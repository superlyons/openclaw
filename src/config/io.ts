import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";
import { ensureOwnerDisplaySecret } from "../agents/owner-display.js";
import { loadDotEnv } from "../infra/dotenv.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import { VERSION } from "../version.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import { maintainConfigBackups } from "./backup-rotation.js";
import {
  applyCompactionDefaults,
  applyContextPruningDefaults,
  applyAgentDefaults,
  applyLoggingDefaults,
  applyMessageDefaults,
  applyModelDefaults,
  applySessionDefaults,
  applyTalkConfigNormalization,
  applyTalkApiKey,
} from "./defaults.js";
import { restoreEnvVarRefs } from "./env-preserve.js";
import {
  MissingEnvVarError,
  containsEnvVarReference,
  resolveConfigEnvVars,
} from "./env-substitution.js";
import { applyConfigEnvVars } from "./env-vars.js";
import {
  ConfigIncludeError,
  readConfigIncludeFileWithGuards,
  resolveConfigIncludes,
} from "./includes.js";
import { findLegacyConfigIssues } from "./legacy.js";
import { applyMergePatch } from "./merge-patch.js";
import { normalizeExecSafeBinProfilesInConfig } from "./normalize-exec-safe-bin.js";
import { normalizeConfigPaths } from "./normalize-paths.js";
import { resolveConfigPath, resolveDefaultConfigCandidates, resolveStateDir } from "./paths.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import type { OpenClawConfig, ConfigFileSnapshot, LegacyConfigIssue } from "./types.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
import { compareOpenClawVersions } from "./version.js";

// Re-export for backwards compatibility
export { CircularIncludeError, ConfigIncludeError } from "./includes.js";
export { MissingEnvVarError } from "./env-substitution.js";

const SHELL_ENV_EXPECTED_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "MINIMAX_API_KEY",
  "SYNTHETIC_API_KEY",
  "KILOCODE_API_KEY",
  "ELEVENLABS_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
];

const OPEN_DM_POLICY_ALLOW_FROM_RE =
  /^(?<policyPath>[a-z0-9_.-]+)\s*=\s*"open"\s+requires\s+(?<allowPath>[a-z0-9_.-]+)(?:\s+\(or\s+[a-z0-9_.-]+\))?\s+to include "\*"$/i;

const CONFIG_AUDIT_LOG_FILENAME = "config-audit.jsonl";
const loggedInvalidConfigs = new Set<string>();

type ConfigWriteAuditResult = "rename" | "copy-fallback" | "failed";

type ConfigWriteAuditRecord = {
  ts: string;
  source: "config-io";
  event: "config.write";
  result: ConfigWriteAuditResult;
  configPath: string;
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  execArgv: string[];
  watchMode: boolean;
  watchSession: string | null;
  watchCommand: string | null;
  existsBefore: boolean;
  previousHash: string | null;
  nextHash: string | null;
  previousBytes: number | null;
  nextBytes: number | null;
  changedPathCount: number | null;
  hasMetaBefore: boolean;
  hasMetaAfter: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
  suspicious: string[];
  errorCode?: string;
  errorMessage?: string;
};

export type ParseConfigJson5Result = { ok: true; parsed: unknown } | { ok: false; error: string };
export type ConfigWriteOptions = {
  /**
   * Read-time env snapshot used to validate `${VAR}` restoration decisions.
   * If omitted, write falls back to current process env.
   */
  envSnapshotForRestore?: Record<string, string | undefined>;
  /**
   * Optional safety check: only use envSnapshotForRestore when writing the
   * same config file path that produced the snapshot.
   */
  expectedConfigPath?: string;
  /**
   * Paths that must be explicitly removed from the persisted file payload,
   * even if schema/default normalization reintroduces them.
   */
  unsetPaths?: string[][];
};

export type ReadConfigFileSnapshotForWriteResult = {
  snapshot: ConfigFileSnapshot;
  writeOptions: ConfigWriteOptions;
};

function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

function formatConfigValidationFailure(pathLabel: string, issueMessage: string): string {
  const match = issueMessage.match(OPEN_DM_POLICY_ALLOW_FROM_RE);
  const policyPath = match?.groups?.policyPath?.trim();
  const allowPath = match?.groups?.allowPath?.trim();
  if (!policyPath || !allowPath) {
    return `Config validation failed: ${pathLabel}: ${issueMessage}`;
  }

  return [
    `Config validation failed: ${pathLabel}`,
    "",
    `Configuration mismatch: ${policyPath} is "open", but ${allowPath} does not include "*".`,
    "",
    "Fix with:",
    `  openclaw config set ${allowPath} '["*"]'`,
    "",
    "Or switch policy:",
    `  openclaw config set ${policyPath} "pairing"`,
  ].join("\n");
}

function isNumericPathSegment(raw: string): boolean {
  return /^[0-9]+$/.test(raw);
}

function isWritePlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnObjectKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const WRITE_PRUNED_OBJECT = Symbol("write-pruned-object");

type UnsetPathWriteResult = {
  changed: boolean;
  value: unknown;
};

/** lyc: 删除路径pathSegments对应的属性 
value = {
  database: {
    connection: {
      host: "localhost",
      port: 5432
    },
    pool: [1, 2, 3]
  }
};
删除database.connection.host属性
pathSegments = ["database", "connection", "host"];
depth = 0
return { changed: true, value: { database: { connection: { port: 5432 } }, pool: [1, 2, 3] } }
删除database.pool[1]数组元素
pathSegments = ["database", "pool", "1"], depth = 0
return { changed: true, value: { database: { connection: { host: "localhost", port: 5432 }, pool: [1, 3] } } }
*/
function unsetPathForWriteAt(
  value: unknown,
  pathSegments: string[],
  depth: number,
): UnsetPathWriteResult {
  if (depth >= pathSegments.length) {
    return { changed: false, value };
  }
  const segment = pathSegments[depth];
  const isLeaf = depth === pathSegments.length - 1;

  if (Array.isArray(value)) {
    if (!isNumericPathSegment(segment)) {
      return { changed: false, value };
    }
    const index = Number.parseInt(segment, 10);
    if (!Number.isFinite(index) || index < 0 || index >= value.length) {
      return { changed: false, value };
    }
    if (isLeaf) {
      const next = value.slice();
      next.splice(index, 1);
      return { changed: true, value: next };
    }
    const child = unsetPathForWriteAt(value[index], pathSegments, depth + 1);
    if (!child.changed) {
      return { changed: false, value };
    }
    const next = value.slice();
    if (child.value === WRITE_PRUNED_OBJECT) {
      next.splice(index, 1);
    } else {
      next[index] = child.value;
    }
    return { changed: true, value: next };
  }

  if (
    isBlockedObjectKey(segment) ||
    !isWritePlainObject(value) ||
    !hasOwnObjectKey(value, segment)
  ) {
    return { changed: false, value };
  }
  if (isLeaf) {
    const next: Record<string, unknown> = { ...value };
    delete next[segment];
    return {
      changed: true,
      value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next,
    };
  }

  const child = unsetPathForWriteAt(value[segment], pathSegments, depth + 1);
  if (!child.changed) {
    return { changed: false, value };
  }
  const next: Record<string, unknown> = { ...value };
  if (child.value === WRITE_PRUNED_OBJECT) {
    delete next[segment];
  } else {
    next[segment] = child.value;
  }
  return {
    changed: true,
    value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next,
  };
}
// lyc: 删除路径pathSegments对应的属性
function unsetPathForWrite(
  root: OpenClawConfig,
  pathSegments: string[],
): { changed: boolean; next: OpenClawConfig } {
  if (pathSegments.length === 0) {
    return { changed: false, next: root };
  }
  const result = unsetPathForWriteAt(root, pathSegments, 0);
  if (!result.changed) {
    return { changed: false, next: root };
  }
  if (result.value === WRITE_PRUNED_OBJECT) {
    return { changed: true, next: {} };
  }
  if (isWritePlainObject(result.value)) {
    return { changed: true, next: coerceConfig(result.value) };
  }
  return { changed: false, next: root };
}

export function resolveConfigSnapshotHash(snapshot: {
  hash?: string;
  raw?: string | null;
}): string | null {
  if (typeof snapshot.hash === "string") {
    const trimmed = snapshot.hash.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof snapshot.raw !== "string") {
    return null;
  }
  return hashConfigRaw(snapshot.raw);
}

function coerceConfig(value: unknown): OpenClawConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as OpenClawConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasConfigMeta(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  const meta = value.meta;
  return isPlainObject(meta);
}

function resolveGatewayMode(value: unknown): string | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const gateway = value.gateway;
  if (!isPlainObject(gateway) || typeof gateway.mode !== "string") {
    return null;
  }
  const trimmed = gateway.mode.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneUnknown<T>(value: T): T {
  return structuredClone(value);
}

/* lyc: 创建合并补丁
base或target 均不是简单对象时, 直接返回target的深拷贝
遍历base和target的所有属性key:
  一个属性key在target中没有时,patch[key]=null
  一个属性key在base中没有时,patch[key]=深拷贝(target[key])  
  一个属性key在base和target都存在时:
    属性key的值都为简单对象时:
      childPatch=继续本逻辑createMergePatch(base[key], target[key])
      childPatch是空对象遍历下一个属性key
      否则,patch[key]=childPatch; 遍历下一个属性key, 代表base[key]和target[key]不相等的合并补丁
    否则深度对比base[key]和target[key], 如果不相等
      patch[key]=深拷贝(target[key])
返回patch
简单逻辑:
  patch[key]=null, 代表base有target没有
  patch[key]=深度拷贝(targetValue), 代表base没有target有
  如果key在base和target都存在 且 都是简单对象:
      patch[key]=递归本逻辑(base[key], target[key]) 
  如果key在base和target都存在 且 不是简单对象(基本类型,复杂类型) 且 值不相等:
      patch[key]=深度拷贝(targetValue)  
  如果key在base和target都存在且值相等时跳过
patch的值为:
  base中存在target中没有的, 值为null
  target中存在base中没有的, 值为深拷贝(target[key])
  base,target中都存在但值不相同的, 值为深拷贝(target[key])
*/
function createMergePatch(base: unknown, target: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(target)) {
    // lyc: cloneUnknown内部调用structuredClone进行深拷贝, 支持基本类型和复杂类型(Date, Set, Map, Error, RegExp, ArrayBuffer, Blob, File, ImageData等等)
    return cloneUnknown(target);
  }

  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const key of keys) {
    // lyc: 注意hasBse和hasTarget一定是or关系或是互斥的, 不存在[false, false]的值, 即可能的值有: [true, true], [true, false], [false, true]
    const hasBase = key in base;
    const hasTarget = key in target;
    if (!hasTarget) {
      // lyc: target配置中没有该键(一定是base的key)，添加到patch中=null
      patch[key] = null;
      continue;
    }
    const targetValue = target[key];
    if (!hasBase) {
      // lyc: base配置中没有该键(一定是target的key)，添加到patch中=targetValue
      patch[key] = cloneUnknown(targetValue);
      continue;
    }
    const baseValue = base[key];
    // lyc: key在base和target配置中都有值
    // lyc: 如果base和target配置中该键的值都是对象，递归合并
    if (isPlainObject(baseValue) && isPlainObject(targetValue)) {
      const childPatch = createMergePatch(baseValue, targetValue);
      // lyc: 如果childPatch为空对象，不添加到patch中, 也就代表baseValue和targetValue相等
      if (isPlainObject(childPatch) && Object.keys(childPatch).length === 0) {
        continue;
      }
      // lyc: childPath是简单对象并且不为空对象则代表baseValue和targetValue不相等, 添加到patch中
      patch[key] = childPatch;
      continue;
    }
    // lyc: 如果base和target配置中该键的值不相等, 添加到patch中=targetValue
    if (!isDeepStrictEqual(baseValue, targetValue)) {
      patch[key] = cloneUnknown(targetValue);
    }
  }
  return patch;
}

// lyc: 收集配置文件中所有环境变量引用的对象属性路径
function collectEnvRefPaths(value: unknown, path: string, output: Map<string, string>): void {
  if (typeof value === "string") {
    if (containsEnvVarReference(value)) {
      output.set(path, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectEnvRefPaths(item, `${path}[${index}]`, output);
    });
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      collectEnvRefPaths(child, childPath, output);
    }
  }
}

// lyc: 收集配置文件base和target的不同处的对象属性路径, 不同指的是base和target: 属性值或数组元素不相等, 缺少属性, 缺少数组元素
function collectChangedPaths(
  base: unknown,
  target: unknown,
  path: string,
  output: Set<string>,
): void {
  if (Array.isArray(base) && Array.isArray(target)) {
    const max = Math.max(base.length, target.length);
    for (let index = 0; index < max; index += 1) {
      const childPath = path ? `${path}[${index}]` : `[${index}]`;
      if (index >= base.length || index >= target.length) {
        output.add(childPath);
        continue;
      }
      collectChangedPaths(base[index], target[index], childPath, output);
    }
    return;
  }
  if (isPlainObject(base) && isPlainObject(target)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const hasBase = key in base;
      const hasTarget = key in target;
      if (!hasTarget || !hasBase) {
        output.add(childPath);
        continue;
      }
      collectChangedPaths(base[key], target[key], childPath, output);
    }
    return;
  }
  if (!isDeepStrictEqual(base, target)) {
    output.add(path);
  }
}

/* lyc: 获取路径的父路径
  a.b.c -> a.b; a.b[0] -> a.b; a.b[0].c -> a.b[0]; "a" -> ""; "" -> ""
*/
function parentPath(value: string): string {
  if (!value) {
    return "";
  }
  if (value.endsWith("]")) {
    const index = value.lastIndexOf("[");
    return index > 0 ? value.slice(0, index) : "";
  }
  const index = value.lastIndexOf(".");
  return index >= 0 ? value.slice(0, index) : "";
}

function isPathChanged(path: string, changedPaths: Set<string>): boolean {
  if (changedPaths.has(path)) {
    return true;
  }
  let current = parentPath(path);
  while (current) {
    if (changedPaths.has(current)) {
      return true;
    }
    current = parentPath(current);
  }
  return changedPaths.has("");
}

function restoreEnvRefsFromMap(
  value: unknown,
  path: string,
  envRefMap: Map<string, string>,
  changedPaths: Set<string>,
): unknown {
  if (typeof value === "string") {
    if (!isPathChanged(path, changedPaths)) {
      const original = envRefMap.get(path);
      if (original !== undefined) {
        return original;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const updated = restoreEnvRefsFromMap(item, `${path}[${index}]`, envRefMap, changedPaths);
      if (updated !== item) {
        changed = true;
      }
      return updated;
    });
    return changed ? next : value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const updated = restoreEnvRefsFromMap(child, childPath, envRefMap, changedPaths);
      if (updated !== child) {
        changed = true;
      }
      next[key] = updated;
    }
    return changed ? next : value;
  }
  return value;
}

function resolveConfigAuditLogPath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  // lyc: ~/.openclaw/logs/config-audit.jsonl
  return path.join(resolveStateDir(env, homedir), "logs", CONFIG_AUDIT_LOG_FILENAME);
}

// lyc: 解析配置文件写入可疑原因
function resolveConfigWriteSuspiciousReasons(params: {
  existsBefore: boolean;
  previousBytes: number | null;
  nextBytes: number | null;
  hasMetaBefore: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
}): string[] {
  const reasons: string[] = [];
  if (!params.existsBefore) {
    return reasons;
  }
  if (
    typeof params.previousBytes === "number" &&
    typeof params.nextBytes === "number" &&
    params.previousBytes >= 512 &&
    params.nextBytes < Math.floor(params.previousBytes * 0.5)
  ) {
    reasons.push(`size-drop:${params.previousBytes}->${params.nextBytes}`);
  }
  if (!params.hasMetaBefore) {
    reasons.push("missing-meta-before-write");
  }
  if (params.gatewayModeBefore && !params.gatewayModeAfter) {
    reasons.push("gateway-mode-removed");
  }
  return reasons;
}

async function appendConfigWriteAuditRecord(
  deps: Required<ConfigIoDeps>,
  record: ConfigWriteAuditRecord,
): Promise<void> {
  try {
    const auditPath = resolveConfigAuditLogPath(deps.env, deps.homedir);
    await deps.fs.promises.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    await deps.fs.promises.appendFile(auditPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best-effort
  }
}

export type ConfigIoDeps = {
  fs?: typeof fs;
  json5?: typeof JSON5;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  configPath?: string;
  logger?: Pick<typeof console, "error" | "warn">;
};

// lyc: 警告配置文件中gateway.token已被废弃, 使用gateway.auth.token代替
function warnOnConfigMiskeys(raw: unknown, logger: Pick<typeof console, "warn">): void {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const gateway = (raw as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") {
    return;
  }
  if ("token" in (gateway as Record<string, unknown>)) {
    logger.warn(
      'Config uses "gateway.token". This key is ignored; use "gateway.auth.token" instead.',
    );
  }
}

function stampConfigVersion(cfg: OpenClawConfig): OpenClawConfig {
  const now = new Date().toISOString();
  return {
    ...cfg,
    meta: {
      ...cfg.meta,
      lastTouchedVersion: VERSION,
      lastTouchedAt: now,
    },
  };
}

// lyc: 警告配置文件是否来自未来版本的OpenClaw
function warnIfConfigFromFuture(cfg: OpenClawConfig, logger: Pick<typeof console, "warn">): void {
  const touched = cfg.meta?.lastTouchedVersion;
  if (!touched) {
    return;
  }
  const cmp = compareOpenClawVersions(VERSION, touched);
  if (cmp === null) {
    return;
  }
  if (cmp < 0) {
    logger.warn(
      `Config was last written by a newer OpenClaw (${touched}); current version is ${VERSION}.`,
    );
  }
}

function resolveConfigPathForDeps(deps: Required<ConfigIoDeps>): string {
  if (deps.configPath) {
    return deps.configPath;
  }
  // lyc: 用户home目录+"/.openclaw/openclaw.json"是默认文件路径
  return resolveConfigPath(deps.env, resolveStateDir(deps.env, deps.homedir));
}

function normalizeDeps(overrides: ConfigIoDeps = {}): Required<ConfigIoDeps> {
  return {
    fs: overrides.fs ?? fs,
    json5: overrides.json5 ?? JSON5,
    env: overrides.env ?? process.env,
    homedir:
      overrides.homedir ?? (() => resolveRequiredHomeDir(overrides.env ?? process.env, os.homedir)),
    configPath: overrides.configPath ?? "",
    logger: overrides.logger ?? console,
  };
}

function maybeLoadDotEnvForConfig(env: NodeJS.ProcessEnv): void {
  // Only hydrate dotenv for the real process env. Callers using injected env
  // objects (tests/diagnostics) should stay isolated.
  // lyc: 只加载真实环境变量，注入环境变量（测试/诊断）应该保持隔离。
  if (env !== process.env) {
    return;
  }
  loadDotEnv({ quiet: true });
}

export function parseConfigJson5(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): ParseConfigJson5Result {
  try {
    return { ok: true, parsed: json5.parse(raw) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

type ConfigReadResolution = {
  resolvedConfigRaw: unknown;
  envSnapshotForRestore: Record<string, string | undefined>;
};

// lyc: 解析parsed中的include指令对应的值返回最终的配置对象
function resolveConfigIncludesForRead(
  parsed: unknown,
  configPath: string,
  deps: Required<ConfigIoDeps>,
): unknown {
  return resolveConfigIncludes(parsed, configPath, {
    readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
    readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
      readConfigIncludeFileWithGuards({
        includePath,
        resolvedPath,
        rootRealDir,
        ioFs: deps.fs,
      }),
    parseJson: (raw) => deps.json5.parse(raw),
  });
}

// lyc: 解析配置文件中的`${VAR_NAME}`环境变量引用并返回最终替换后的配置对象和环境变量快照用于写入时恢复${VAR}
function resolveConfigForRead(
  resolvedIncludes: unknown,
  env: NodeJS.ProcessEnv,
): ConfigReadResolution {
  // Apply config.env to process.env BEFORE substitution so ${VAR} can reference config-defined vars.
  // lyc: 在替换之前，将config.env(resolvedIncludes.env)应用到process.env中，这样${VAR}就可以引用配置文件(resolvedIncludes.env)中定义的变量。
  if (resolvedIncludes && typeof resolvedIncludes === "object" && "env" in resolvedIncludes) {
    applyConfigEnvVars(resolvedIncludes as OpenClawConfig, env);
  }

  return {
    // lyc: 已替换环境变量的配置对象
    resolvedConfigRaw: resolveConfigEnvVars(resolvedIncludes, env),
    // Capture env snapshot after substitution for write-time ${VAR} restoration.
    // lyc: 在替换之后，捕获环境变量快照，用于写入时恢复${VAR}
    envSnapshotForRestore: { ...env } as Record<string, string | undefined>,
  };
}

type ReadConfigFileSnapshotInternalResult = {
  snapshot: ConfigFileSnapshot;
  envSnapshotForRestore?: Record<string, string | undefined>;
};

export function createConfigIO(overrides: ConfigIoDeps = {}) {
  // lyc: 规范化依赖项(deps)，使用默认值填充未提供的依赖,即deps是对overrides规范化后的ConfigIoDeps对象
  const deps = normalizeDeps(overrides);
  // lyc: 根据依赖项(deps)解析openclaw.json配置文件的请求路径
  const requestedConfigPath = resolveConfigPathForDeps(deps);
  // lyc: 如果用户指定了配置路径(入参overrides.configPath通过normalizeDeps()规范化)，则只使用该路径；否则使用默认候选路径列表
  const candidatePaths = deps.configPath
    ? [requestedConfigPath]
    : resolveDefaultConfigCandidates(deps.env, deps.homedir);
  // lyc: 在候选路径(candidatePaths)中查找第一个存在的openclaw.json配置文件，如果没有则使用requestedConfigPath(请求的路径)
  const configPath =
    candidatePaths.find((candidate) => deps.fs.existsSync(candidate)) ?? requestedConfigPath;

  /* lyc:
   加载并验证配置文件
   */
  function loadConfig(): OpenClawConfig {
    try {
      // lyc: 尝试加载.env文件到process.env，仅对真实进程环境生效
      maybeLoadDotEnvForConfig(deps.env);
      // lyc: openclaw.json配置文件不存在时的处理并返回空配置({})
      if (!deps.fs.existsSync(configPath)) {
        // lyc: 如果启用了加载shell环境变量(OPENCLAW_LOAD_SHELL_ENV=true)且不应延迟(OPENCLAW_DEFER_SHELL_ENV_FALLBACK=false)，则尝试加载shell环境变量
        if (shouldEnableShellEnvFallback(deps.env) && !shouldDeferShellEnvFallback(deps.env)) {
          // lyc: 向deps.env追加SHELL_ENV_EXPECTED_KEYS指定的shell环境变量
          loadShellEnvFallback({
            enabled: true,
            env: deps.env,
            // lyc: 加载shell环境变量时期望的环境变量键名
            expectedKeys: SHELL_ENV_EXPECTED_KEYS,
            logger: deps.logger,
            // lyc: 超时时间, Ms代表毫秒级
            timeoutMs: resolveShellEnvFallbackTimeoutMs(deps.env),
          });
        }
        return {};
      }
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const parsed = deps.json5.parse(raw);
      // lyc: 解析配置文件中的`${VAR_NAME}`环境变量引用并返回最终替换后的配置对象
      const { resolvedConfigRaw: resolvedConfig } = resolveConfigForRead(
        // lyc: 解析parsed中的include指令对应的值返回最终的配置对象
        resolveConfigIncludesForRead(parsed, configPath, deps),
        deps.env,
      );
      // lyc: 警告配置文件中gateway.token已被废弃, 使用gateway.auth.token代替
      warnOnConfigMiskeys(resolvedConfig, deps.logger);
      if (typeof resolvedConfig !== "object" || resolvedConfig === null) {
        return {};
      }
      // lyc: 查找重复的agentDir
      const preValidationDuplicates = findDuplicateAgentDirs(resolvedConfig as OpenClawConfig, {
        env: deps.env,
        homedir: deps.homedir,
      });
      // lyc: 存在重复的agentDir时报错
      if (preValidationDuplicates.length > 0) {
        throw new DuplicateAgentDirError(preValidationDuplicates);
      }
      // lyc: 验证配置对象
      const validated = validateConfigObjectWithPlugins(resolvedConfig);
      if (!validated.ok) {
        const details = validated.issues
          .map((iss) => `- ${iss.path || "<root>"}: ${iss.message}`)
          .join("\n");
        if (!loggedInvalidConfigs.has(configPath)) {
          loggedInvalidConfigs.add(configPath);
          deps.logger.error(`Invalid config at ${configPath}:\\n${details}`);
        }
        const error = new Error(`Invalid config at ${configPath}:\n${details}`);
        (error as { code?: string; details?: string }).code = "INVALID_CONFIG";
        (error as { code?: string; details?: string }).details = details;
        throw error;
      }
      if (validated.warnings.length > 0) {
        const details = validated.warnings
          .map((iss) => `- ${iss.path || "<root>"}: ${iss.message}`)
          .join("\n");
        deps.logger.warn(`Config warnings:\\n${details}`);
      }
      // lyc: 警告配置文件来自未来版本的OpenClaw
      warnIfConfigFromFuture(validated.config, deps.logger);
      // lyc: 对cfg应用默认值: messages,logging,session,agents,agents.defaults.contextPruning,agents.defaults.compaction,models,talk
      const cfg = applyTalkConfigNormalization(
        applyModelDefaults(
          applyCompactionDefaults(
            applyContextPruningDefaults(
              applyAgentDefaults(
                applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))),
              ),
            ),
          ),
        ),
      );``
      // lyc: 对cfg中有关路径的配置中存在"~/..."的值进行规范化处理
      normalizeConfigPaths(cfg);
      // lyc: 对cfg中有关exec的配置中存在safeBinProfiles和safeBinTrustedDirs属性的值进行规范化处理
      normalizeExecSafeBinProfilesInConfig(cfg);

      // lyc: 再一次查找重复的agentDir
      const duplicates = findDuplicateAgentDirs(cfg, {
        env: deps.env,
        homedir: deps.homedir,
      });
      if (duplicates.length > 0) {
        throw new DuplicateAgentDirError(duplicates);
      }

      // lyc: 应用配置文件中的环境变量(cfg.env)到deps.env, 如果deps.env已存在不覆盖, 只添加
      applyConfigEnvVars(cfg, deps.env);

      // lyc: 如果启用了加载shell环境变量(OPENCLAW_LOAD_SHELL_ENV=true || cfg.env.shellEnv.enabled === true)
      const enabled = shouldEnableShellEnvFallback(deps.env) || cfg.env?.shellEnv?.enabled === true;
      // lyc: 如果启用了加载shell环境变量 && 且不应延迟OPENCLAW_DEFER_SHELL_ENV_FALLBACK=false，则尝试加载shell环境变量
      if (enabled && !shouldDeferShellEnvFallback(deps.env)) {
        // lyc: 向deps.env追加SHELL_ENV_EXPECTED_KEYS指定的shell环境变量
        loadShellEnvFallback({
          enabled: true,
          env: deps.env,
          expectedKeys: SHELL_ENV_EXPECTED_KEYS,
          logger: deps.logger,
          timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(deps.env),
        });
      }

      // lyc: 获得configPath对应的所有者显示秘钥(ownerDisplaySecret)
      const pendingSecret = AUTO_OWNER_DISPLAY_SECRET_BY_PATH.get(configPath);
      // lyc: 确保config为hash模式(config.commands.ownerDisplay=hash时)有专用密钥,ownerDisplaySecret一定有值
      const ownerDisplaySecretResolution = ensureOwnerDisplaySecret(
        cfg,
        () => pendingSecret ?? crypto.randomBytes(32).toString("hex"),
      );
      // lyc: 更新config配置, 即所有者显示的配置一定是正确的
      const cfgWithOwnerDisplaySecret = ownerDisplaySecretResolution.config;
      // lyc: 如果config.commands.ownerDisplay=hash
      if (ownerDisplaySecretResolution.generatedSecret) {
        // lyc: 缓存所有者显示秘钥
        AUTO_OWNER_DISPLAY_SECRET_BY_PATH.set(
          configPath,
          ownerDisplaySecretResolution.generatedSecret,
        );
        if (!AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT.has(configPath)) {
          AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT.add(configPath);
          void writeConfigFile(cfgWithOwnerDisplaySecret, { expectedConfigPath: configPath })
            .then(() => {
              AUTO_OWNER_DISPLAY_SECRET_BY_PATH.delete(configPath);
              AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.delete(configPath);
            })
            .catch((err) => {
              if (!AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.has(configPath)) {
                AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.add(configPath);
                deps.logger.warn(
                  `Failed to persist auto-generated commands.ownerDisplaySecret at ${configPath}: ${String(err)}`,
                );
              }
            })
            .finally(() => {
              AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT.delete(configPath);
            });
        }
      } else {
        // lyc: 这里为config.commands.ownerDisplay=raw, 则删除所有者显示秘钥的缓存
        AUTO_OWNER_DISPLAY_SECRET_BY_PATH.delete(configPath);
        AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.delete(configPath);
      }

      // lyc: 应用运行时覆盖
      return applyConfigOverrides(cfgWithOwnerDisplaySecret);
    } catch (err) {
      if (err instanceof DuplicateAgentDirError) {
        deps.logger.error(err.message);
        throw err;
      }
      const error = err as { code?: string };
      if (error?.code === "INVALID_CONFIG") {
        return {};
      }
      deps.logger.error(`Failed to read config at ${configPath}`, err);
      return {};
    }
  }

  /* lyc: 读取configPath配置文件的快照,
  快照包含四级配置文件: raw(最原始的配置文件字符串), parsed(JSON解析后的内容), resolved(应用命令的配置), config(最终的配置对象）
  {
    snapshot:{
        path: configPath, // 配置文件路径
        exists: boolean, // configPath是否存在
        raw: string, //configPath原始的文件内容
        parsed: unknown, // configPath经过JSON.parse解析后的内容
        resolved: OpenClawConfig; // parsed经过包含$include和环境变量${ENV}替换后的配置
        valid: boolean; // configPath是否有效
        config: OpenClawConfig; // 最终的配置对象（resolved应用了所有默认值和转换）
        hash?: string; // 配置文件内容的hash值
        issues: ConfigValidationIssue[] // 配置问题列表
        warnings: ConfigValidationIssue[] // 配置警告列表
        legacyIssues: LegacyConfigIssue[] // 兼容性配置问题列表
    },
    envSnapshotForRestore: {} // 当时env环境变量的快照
  }
  */
  async function readConfigFileSnapshotInternal(): Promise<ReadConfigFileSnapshotInternalResult> {
    maybeLoadDotEnvForConfig(deps.env);
    const exists = deps.fs.existsSync(configPath);
    if (!exists) {
      const hash = hashConfigRaw(null);
      const config = applyTalkApiKey(
        applyTalkConfigNormalization(
          applyModelDefaults(
            applyCompactionDefaults(
              applyContextPruningDefaults(
                applyAgentDefaults(applySessionDefaults(applyMessageDefaults({}))),
              ),
            ),
          ),
        ),
      );
      const legacyIssues: LegacyConfigIssue[] = [];
      return {
        snapshot: {
          path: configPath,
          exists: false,
          raw: null,
          parsed: {},
          resolved: {},
          valid: true,
          config,
          hash,
          issues: [],
          warnings: [],
          legacyIssues,
        },
      };
    }

    try {
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const hash = hashConfigRaw(raw);
      const parsedRes = parseConfigJson5(raw, deps.json5);
      if (!parsedRes.ok) {
        return {
          snapshot: {
            path: configPath,
            exists: true,
            raw,
            parsed: {},
            resolved: {},
            valid: false,
            config: {},
            hash,
            issues: [{ path: "", message: `JSON5 parse failed: ${parsedRes.error}` }],
            warnings: [],
            legacyIssues: [],
          },
        };
      }

      // Resolve $include directives
      let resolved: unknown;
      try {
        // lyc: 解析配置中include指令
        resolved = resolveConfigIncludesForRead(parsedRes.parsed, configPath, deps);
      } catch (err) {
        const message =
          err instanceof ConfigIncludeError
            ? err.message
            : `Include resolution failed: ${String(err)}`;
        return {
          snapshot: {
            path: configPath,
            exists: true,
            raw,
            parsed: parsedRes.parsed,
            resolved: coerceConfig(parsedRes.parsed),
            valid: false,
            config: coerceConfig(parsedRes.parsed),
            hash,
            issues: [{ path: "", message }],
            warnings: [],
            legacyIssues: [],
          },
        };
      }

      let readResolution: ConfigReadResolution;
      try {
        // lyc: 应用配置中的环境变量
        readResolution = resolveConfigForRead(resolved, deps.env);
      } catch (err) {
        const message =
          err instanceof MissingEnvVarError
            ? err.message
            : `Env var substitution failed: ${String(err)}`;
        return {
          snapshot: {
            path: configPath,
            exists: true,
            raw,
            parsed: parsedRes.parsed,
            resolved: coerceConfig(resolved),
            valid: false,
            config: coerceConfig(resolved),
            hash,
            issues: [{ path: "", message }],
            warnings: [],
            legacyIssues: [],
          },
        };
      }

      const resolvedConfigRaw = readResolution.resolvedConfigRaw;
      // Detect legacy keys on resolved config, but only mark source-literal legacy
      // entries (for auto-migration) when they are present in the parsed source.
      // lyc: 查找配置中的遗留问题
      const legacyIssues = findLegacyConfigIssues(resolvedConfigRaw, parsedRes.parsed);

      // lyc: 验证配置
      const validated = validateConfigObjectWithPlugins(resolvedConfigRaw);
      if (!validated.ok) {
        return {
          snapshot: {
            path: configPath,
            exists: true,
            raw,
            parsed: parsedRes.parsed,
            resolved: coerceConfig(resolvedConfigRaw),
            valid: false,
            config: coerceConfig(resolvedConfigRaw),
            hash,
            issues: validated.issues,
            warnings: validated.warnings,
            legacyIssues,
          },
        };
      }

      // lyc: 警告配置文件是否来自未来版本的OpenClaw
      warnIfConfigFromFuture(validated.config, deps.logger);
      // lyc: 为配置文件应用默认值
      const snapshotConfig = normalizeConfigPaths(
        applyTalkApiKey(
          applyTalkConfigNormalization(
            applyModelDefaults(
              applyAgentDefaults(
                applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))),
              ),
            ),
          ),
        ),
      );
      // lyc: 对配置中的exec的配置进行规范化处理
      normalizeExecSafeBinProfilesInConfig(snapshotConfig);
      return {
        snapshot: {
          path: configPath,
          exists: true,
          raw,
          parsed: parsedRes.parsed,
          // Use resolvedConfigRaw (after $include and ${ENV} substitution but BEFORE runtime defaults)
          // for config set/unset operations (issue #6070)
          resolved: coerceConfig(resolvedConfigRaw),
          valid: true,
          config: snapshotConfig,
          hash,
          issues: [],
          warnings: validated.warnings,
          legacyIssues,
        },
        envSnapshotForRestore: readResolution.envSnapshotForRestore,
      };
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      let message: string;
      if (nodeErr?.code === "EACCES") {
        // Permission denied — common in Docker/container deployments where the
        // config file is owned by root but the gateway runs as a non-root user.
        const uid = process.getuid?.();
        const uidHint = typeof uid === "number" ? String(uid) : "$(id -u)";
        message = [
          `read failed: ${String(err)}`,
          ``,
          `Config file is not readable by the current process. If running in a container`,
          `or 1-click deployment, fix ownership with:`,
          `  chown ${uidHint} "${configPath}"`,
          `Then restart the gateway.`,
        ].join("\n");
        deps.logger.error(message);
      } else {
        message = `read failed: ${String(err)}`;
      }
      return {
        snapshot: {
          path: configPath,
          exists: true,
          raw: null,
          parsed: {},
          resolved: {},
          valid: false,
          config: {},
          hash: hashConfigRaw(null),
          issues: [{ path: "", message }],
          warnings: [],
          legacyIssues: [],
        },
      };
    }
  }

  async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
    const result = await readConfigFileSnapshotInternal();
    return result.snapshot;
  }

  async function readConfigFileSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
    const result = await readConfigFileSnapshotInternal();
    return {
      snapshot: result.snapshot,
      writeOptions: {
        envSnapshotForRestore: result.envSnapshotForRestore,
        expectedConfigPath: configPath,
      },
    };
  }

  /* lyc: 写入配置文件
    snapshotResult = {
      snapshot:{
          path: configPath, // 配置文件路径
          exists: boolean, // configPath是否存在
          raw: string, //configPath原始的文件内容
          parsed: unknown, // configPath经过JSON.parse解析后的内容
          resolved: OpenClawConfig; // parsed经过包含$include和环境变量${ENV}替换后的配置
          valid: boolean; // configPath是否有效
          config: OpenClawConfig; // 最终的配置对象（resolved应用了所有默认值和转换）
          hash?: string; // 配置文件内容的hash值
          issues: ConfigValidationIssue[] // 配置问题列表
          warnings: ConfigValidationIssue[] // 配置警告列表
          legacyIssues: LegacyConfigIssue[] // 兼容性配置问题列表
      },
      envSnapshotForRestore: {} // 当时env环境变量的快照
  }
  snapshot = snapshotResult.snapshot;
  patch的值为:
    base中存在target中没有的, 值为null
    target中存在base中没有的, 值为深拷贝(target[key])
    base,target中都存在但值不相同的, 值为深拷贝(target[key])
  configPath = openclaw.json配置文件的路径
  cfg 函数入参配置
  persistCandidate = cfg
  persistCandidate = applyMergePatch(snapshot.resolved, createMergePatch(snapshot.config, cfg));
  resolvedIncludes = resolveConfigIncludes(snapshot.parsed, configPath, {});
  envRefMap = resolvedIncludes中的环境变量引用的对象属性路径和值
  changedPaths = 收集snapshot.config和cfg中变化的路径(值不相等,某一属性路径不存在)
  validated = 验证后的(persistCandidate)
  cfgToWrite = validated.config
  cfgToWrite = restoreEnvVarRefs( // 根据parsedRes.parsed恢复cfgToWrite中已解析的环境变量引用
              cfgToWrite,
              parsedRes.parsed,
              envForRestore,
            )
  outputConfigBase = envRefMap和changedPaths恢复的cfgToWrite || cfgToWrite
  outputConfig = outputConfigBase
  stampedOutputConfig = stampConfigVersion(outputConfig); 标记后的outputConfig为meta属性添加lastTouchedVersion和lastTouchedAt
  json=json.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n")
  维护openclaw.json相关配置文件的备份
  writeFileSync(configPath, json) 将json写入openclaw.json
  */
  async function writeConfigFile(cfg: OpenClawConfig, options: ConfigWriteOptions = {}) {
    // lyc: 清除配置缓存configCache，确保写入的配置是最新的
    clearConfigCache();
    // lyc: 持久化候选persistCandidate=cfg
    let persistCandidate: unknown = cfg;
    // lyc: 读取configPath配置文件的快照snapshot
    const { snapshot } = await readConfigFileSnapshotInternal();
    let envRefMap: Map<string, string> | null = null;
    let changedPaths: Set<string> | null = null;
    // lyc: 如果配置快照snapshot有效(验证通过)且存在; 当configPath不存在时valid=true, exists=false
    if (snapshot.valid && snapshot.exists) {
      // lyc: 获得快照最终配置config和入参cfg的不同处(patch)
      const patch = createMergePatch(snapshot.config, cfg);
      // lyc: 向快照的resolved配置应用合并补丁, 用patch删除,覆盖,合并resolved相关属性
      persistCandidate = applyMergePatch(snapshot.resolved, patch);
      try {
        // lyc: resolvedIncludes=快照parsed配置经过执行$include指令替换后的配置
        const resolvedIncludes = resolveConfigIncludes(snapshot.parsed, configPath, {
          readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
          readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
            readConfigIncludeFileWithGuards({
              includePath,
              resolvedPath,
              rootRealDir,
              ioFs: deps.fs,
            }),
          parseJson: (raw) => deps.json5.parse(raw),
        });
        const collected = new Map<string, string>();
        // lyc: 收集resolvedIncludes中所有环境变量引用的对象属性路径(key)和值(value)
        collectEnvRefPaths(resolvedIncludes, "", collected);
        // lyc: 如果resolvedIncludes中存在环境变量引用
        if (collected.size > 0) {
          envRefMap = collected;
          changedPaths = new Set<string>();
          // lyc: 收集snapshot.config和cfg中变化的路径(值不相等,某一属性路径不存在)
          collectChangedPaths(snapshot.config, cfg, "", changedPaths);
        }
      } catch {
        envRefMap = null;
      }
    }
    // lyc: 验证persistCandidate
    const validated = validateConfigObjectRawWithPlugins(persistCandidate);
    if (!validated.ok) {
      const issue = validated.issues[0];
      const pathLabel = issue?.path ? issue.path : "<root>";
      const issueMessage = issue?.message ?? "invalid";
      throw new Error(formatConfigValidationFailure(pathLabel, issueMessage));
    }
    if (validated.warnings.length > 0) {
      const details = validated.warnings
        .map((warning) => `- ${warning.path}: ${warning.message}`)
        .join("\n");
      deps.logger.warn(`Config warnings:\n${details}`);
    }

    // Restore ${VAR} env var references that were resolved during config loading.
    // Read the current file (pre-substitution) and restore any references whose
    // resolved values match the incoming config — so we don't overwrite
    // "${ANTHROPIC_API_KEY}" with "sk-ant-..." when the caller didn't change it.
    //
    // We use only the root file's parsed content (no $include resolution) to avoid
    // pulling values from included files into the root config on write-back.
    // Apply env restoration to validated.config (which has runtime defaults stripped
    // per issue #6070) rather than the raw caller input.
    /* lyc:
    恢复在配置加载过程中解析过的${VAR}环境变量引用。
    读取当前文件（预替换）并恢复解析值与传入配置匹配的所有引用 —— 这样，当调用者未更改“${ANTHROPIC_API_KEY}”时，我们就不会将其覆盖为“sk-ant-...”。
    我们仅使用根文件的解析内容（不进行$include解析），以避免在回写时将包含文件中的值引入根配置中。
    对validated.config（根据问题#6070已去除了运行时默认值）应用环境恢复，而不是对原始调用者输入进行环境恢复。
    */
    let cfgToWrite = validated.config;
    try {
      if (deps.fs.existsSync(configPath)) {
        const currentRaw = await deps.fs.promises.readFile(configPath, "utf-8");
        const parsedRes = parseConfigJson5(currentRaw, deps.json5);
        if (parsedRes.ok) {
          // Use env snapshot from when config was loaded (if available) to avoid
          // TOCTOU issues where env changes between load and write. Falls back to
          // live env if no snapshot exists (e.g., first write before any load).
          // lyc: 使用加载配置时的环境快照（如果可用）以避免在加载和写入之间环境发生变化导致的TOCTOU问题。如果不存在快照（例如，在任何加载之前先进行写入），则回退到实时环境
          const envForRestore = options.envSnapshotForRestore ?? deps.env;
          // lyc: 恢复cfgToWrite中在配置加载过程中解析过的${VAR}环境变量引用
          cfgToWrite = restoreEnvVarRefs(
            cfgToWrite,
            parsedRes.parsed,
            envForRestore,
          ) as OpenClawConfig;
        }
      }
    } catch {
      // If reading the current file fails, write cfg as-is (no env restoration)
    }

    const dir = path.dirname(configPath);
    await deps.fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    // lyc: outputConfigBase = 如果envRefMap和changedPaths都存在则从中为cfgToWrite恢复环境变量引用 || cfgToWrite
    const outputConfigBase =
      envRefMap && changedPaths
        ? (restoreEnvRefsFromMap(cfgToWrite, "", envRefMap, changedPaths) as OpenClawConfig)
        : cfgToWrite;
    let outputConfig = outputConfigBase;
    // lyc: 删除outputConfig中unsetPaths对应的属性
    if (options.unsetPaths?.length) {
      for (const unsetPath of options.unsetPaths) {
        if (!Array.isArray(unsetPath) || unsetPath.length === 0) {
          continue;
        }
        const unsetResult = unsetPathForWrite(outputConfig, unsetPath);
        if (unsetResult.changed) {
          outputConfig = unsetResult.next;
        }
      }
    }
    // Do NOT apply runtime defaults when writing — user config should only contain
    // explicitly set values. Runtime defaults are applied when loading (issue #6070).
    // lyc: 在写入时不要应用运行时默认值——用户配置应仅包含明确设置的值。运行时默认值在加载时应用（问题 #6070）。
    // lyc: stampedOutputConfig=标记后的outputConfig, 为meta属性添加lastTouchedVersion和lastTouchedAt
    const stampedOutputConfig = stampConfigVersion(outputConfig);
    // lyc: stampedOutputConfig的JSON字符串, 在结尾添加换行符
    const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
    // lyc: json的sha256哈希值
    const nextHash = hashConfigRaw(json);
    // lyc: snapshot.raw的sha256哈希值
    const previousHash = resolveConfigSnapshotHash(snapshot);
    const changedPathCount = changedPaths?.size;
    const previousBytes =
      typeof snapshot.raw === "string" ? Buffer.byteLength(snapshot.raw, "utf-8") : null;
    const nextBytes = Buffer.byteLength(json, "utf-8");
    // lyc: snapshot.parsed是否有meta属性
    const hasMetaBefore = hasConfigMeta(snapshot.parsed);
    // lyc: stampedOutputConfig是否有meta属性
    const hasMetaAfter = hasConfigMeta(stampedOutputConfig);
    // lyc: snapshot.resolved的gateway.mode属性值
    const gatewayModeBefore = resolveGatewayMode(snapshot.resolved);
    // lyc: stampedOutputConfig的gateway.mode属性值
    const gatewayModeAfter = resolveGatewayMode(stampedOutputConfig);
    // lyc: 解析配置文件写入可疑原因
    const suspiciousReasons = resolveConfigWriteSuspiciousReasons({
      existsBefore: snapshot.exists,
      previousBytes,
      nextBytes,
      hasMetaBefore,
      gatewayModeBefore,
      gatewayModeAfter,
    });
    // lyc: 记录配置文件覆盖日志
    const logConfigOverwrite = () => {
      if (!snapshot.exists) {
        return;
      }
      const isVitest = deps.env.VITEST === "true";
      const shouldLogInVitest = deps.env.OPENCLAW_TEST_CONFIG_OVERWRITE_LOG === "1";
      if (isVitest && !shouldLogInVitest) {
        return;
      }
      const changeSummary =
        typeof changedPathCount === "number" ? `, changedPaths=${changedPathCount}` : "";
      deps.logger.warn(
        `Config overwrite: ${configPath} (sha256 ${previousHash ?? "unknown"} -> ${nextHash}, backup=${configPath}.bak${changeSummary})`,
      );
    };
    // lyc: 记录配置文件写入可疑原因日志
    const logConfigWriteAnomalies = () => {
      if (suspiciousReasons.length === 0) {
        return;
      }
      // Tests often write minimal configs (missing meta, etc); keep output quiet unless requested.
      const isVitest = deps.env.VITEST === "true";
      const shouldLogInVitest = deps.env.OPENCLAW_TEST_CONFIG_WRITE_ANOMALY_LOG === "1";
      if (isVitest && !shouldLogInVitest) {
        return;
      }
      deps.logger.warn(`Config write anomaly: ${configPath} (${suspiciousReasons.join(", ")})`);
    };
    const auditRecordBase = {
      ts: new Date().toISOString(),
      source: "config-io" as const,
      event: "config.write" as const,
      configPath,
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      argv: process.argv.slice(0, 8),
      execArgv: process.execArgv.slice(0, 8),
      watchMode: deps.env.OPENCLAW_WATCH_MODE === "1",
      watchSession:
        typeof deps.env.OPENCLAW_WATCH_SESSION === "string" &&
        deps.env.OPENCLAW_WATCH_SESSION.trim().length > 0
          ? deps.env.OPENCLAW_WATCH_SESSION.trim()
          : null,
      watchCommand:
        typeof deps.env.OPENCLAW_WATCH_COMMAND === "string" &&
        deps.env.OPENCLAW_WATCH_COMMAND.trim().length > 0
          ? deps.env.OPENCLAW_WATCH_COMMAND.trim()
          : null,
      existsBefore: snapshot.exists,
      previousHash: previousHash ?? null,
      nextHash,
      previousBytes,
      nextBytes,
      changedPathCount: typeof changedPathCount === "number" ? changedPathCount : null,
      hasMetaBefore,
      hasMetaAfter,
      gatewayModeBefore,
      gatewayModeAfter,
      suspicious: suspiciousReasons,
    };
    // lyc: 向配置审计文件追加当前配置文件的审计记录, 配置审计文件: ~/.openclaw/logs/config-audit.jsonl
    const appendWriteAudit = async (result: ConfigWriteAuditResult, err?: unknown) => {
      const errorCode =
        err && typeof err === "object" && "code" in err && typeof err.code === "string"
          ? err.code
          : undefined;
      const errorMessage =
        err && typeof err === "object" && "message" in err && typeof err.message === "string"
          ? err.message
          : undefined;
      await appendConfigWriteAuditRecord(deps, {
        ...auditRecordBase,
        result,
        nextHash: result === "failed" ? null : auditRecordBase.nextHash,
        nextBytes: result === "failed" ? null : auditRecordBase.nextBytes,
        errorCode,
        errorMessage,
      });
    };

    const tmp = path.join(
      dir,
      `${path.basename(configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );

    // lyc: 将json写入configPath, 写入之前做好配置的轮换备份
    try {
      await deps.fs.promises.writeFile(tmp, json, {
        encoding: "utf-8",
        mode: 0o600,
      });

      if (deps.fs.existsSync(configPath)) {
        // lyc: 维护openclaw.json相关配置文件的备份
        await maintainConfigBackups(configPath, deps.fs.promises);
      }

      try {
        // lyc: 重命名tmp到configPath
        await deps.fs.promises.rename(tmp, configPath);
      } catch (err) {
        const code = (err as { code?: string }).code;
        // Windows doesn't reliably support atomic replace via rename when dest exists.
        // lyc: 当目标文件存在时，Windows无法通过重命名来可靠地支持原子替换。需要特殊处理
        if (code === "EPERM" || code === "EEXIST") {
          await deps.fs.promises.copyFile(tmp, configPath);
          await deps.fs.promises.chmod(configPath, 0o600).catch(() => {
            // best-effort
          });
          await deps.fs.promises.unlink(tmp).catch(() => {
            // best-effort
          });
          logConfigOverwrite();
          logConfigWriteAnomalies();
          await appendWriteAudit("copy-fallback");
          return;
        }
        // lyc: 清理tmp文件
        await deps.fs.promises.unlink(tmp).catch(() => {
          // best-effort
        });
        throw err;
      }
      logConfigOverwrite();
      logConfigWriteAnomalies();
      // lyc: 向配置审计文件追加当前配置文件的审计记录
      await appendWriteAudit("rename");
    } catch (err) {
      await appendWriteAudit("failed", err);
      throw err;
    }
  }

  return {
    configPath,
    loadConfig,
    readConfigFileSnapshot,
    readConfigFileSnapshotForWrite,
    writeConfigFile,
  };
}

// NOTE: These wrappers intentionally do *not* cache the resolved config path at
// module scope. `OPENCLAW_CONFIG_PATH` (and friends) are expected to work even
// when set after the module has been imported (tests, one-off scripts, etc.).
const DEFAULT_CONFIG_CACHE_MS = 200;
// lyc: 按路径保存显示所有者秘密(key=config路径, value=专用密钥)
const AUTO_OWNER_DISPLAY_SECRET_BY_PATH = new Map<string, string>();
const AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT = new Set<string>();
const AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED = new Set<string>();
let configCache: {
  configPath: string;
  expiresAt: number;
  config: OpenClawConfig;
} | null = null;
let runtimeConfigSnapshot: OpenClawConfig | null = null;
let runtimeConfigSourceSnapshot: OpenClawConfig | null = null;

function resolveConfigCacheMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_CONFIG_CACHE_MS?.trim();
  if (raw === "" || raw === "0") {
    return 0;
  }
  if (!raw) {
    return DEFAULT_CONFIG_CACHE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CONFIG_CACHE_MS;
  }
  return Math.max(0, parsed);
}

function shouldUseConfigCache(env: NodeJS.ProcessEnv): boolean {
  if (env.OPENCLAW_DISABLE_CONFIG_CACHE?.trim()) {
    return false;
  }
  return resolveConfigCacheMs(env) > 0;
}

export function clearConfigCache(): void {
  configCache = null;
}

export function setRuntimeConfigSnapshot(
  config: OpenClawConfig,
  sourceConfig?: OpenClawConfig,
): void {
  runtimeConfigSnapshot = config;
  runtimeConfigSourceSnapshot = sourceConfig ?? null;
  clearConfigCache();
}

export function clearRuntimeConfigSnapshot(): void {
  runtimeConfigSnapshot = null;
  runtimeConfigSourceSnapshot = null;
  clearConfigCache();
}

export function getRuntimeConfigSnapshot(): OpenClawConfig | null {
  return runtimeConfigSnapshot;
}

export function loadConfig(): OpenClawConfig {
  if (runtimeConfigSnapshot) {
    return runtimeConfigSnapshot;
  }
  const io = createConfigIO();
  const configPath = io.configPath;
  const now = Date.now();
  if (shouldUseConfigCache(process.env)) {
    const cached = configCache;
    if (cached && cached.configPath === configPath && cached.expiresAt > now) {
      return cached.config;
    }
  }
  const config = io.loadConfig();
  if (shouldUseConfigCache(process.env)) {
    const cacheMs = resolveConfigCacheMs(process.env);
    if (cacheMs > 0) {
      configCache = {
        configPath,
        expiresAt: now + cacheMs,
        config,
      };
    }
  }
  return config;
}

export async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
  return await createConfigIO().readConfigFileSnapshot();
}

export async function readConfigFileSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
  return await createConfigIO().readConfigFileSnapshotForWrite();
}

export async function writeConfigFile(
  cfg: OpenClawConfig,
  options: ConfigWriteOptions = {},
): Promise<void> {
  const io = createConfigIO();
  let nextCfg = cfg;
  if (runtimeConfigSnapshot && runtimeConfigSourceSnapshot) {
    const runtimePatch = createMergePatch(runtimeConfigSnapshot, cfg);
    nextCfg = coerceConfig(applyMergePatch(runtimeConfigSourceSnapshot, runtimePatch));
  }
  const sameConfigPath =
    options.expectedConfigPath === undefined || options.expectedConfigPath === io.configPath;
  await io.writeConfigFile(nextCfg, {
    envSnapshotForRestore: sameConfigPath ? options.envSnapshotForRestore : undefined,
    unsetPaths: options.unsetPaths,
  });
}
