import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { ensureOwnerDisplaySecret } from "../agents/owner-display.js";
import { applyRuntimeLegacyConfigMigrations } from "../commands/doctor/shared/runtime-compat-api.js";
import { loadDotEnv } from "../infra/dotenv.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import {
  collectRelevantDoctorPluginIds,
  listPluginDoctorLegacyConfigRules,
} from "../plugins/doctor-contract-registry.js";
import {
  loadInstalledPluginIndexInstallRecordsSync,
  resolveInstalledPluginIndexRecordsStorePath,
  writePersistedInstalledPluginIndexInstallRecordsSync,
} from "../plugins/installed-plugin-index-records.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { isRecord } from "../utils.js";
import { VERSION } from "../version.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import { maintainConfigBackups } from "./backup-rotation.js";
import { restoreEnvVarRefs } from "./env-preserve.js";
import {
  type EnvSubstitutionWarning,
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
import {
  appendConfigAuditRecord,
  appendConfigAuditRecordSync,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  formatConfigOverwriteLogMessage,
  type ConfigWriteAuditResult,
} from "./io.audit.js";
import { throwInvalidConfig } from "./io.invalid-config.js";
import {
  maybeRecoverSuspiciousConfigRead,
  maybeRecoverSuspiciousConfigReadSync,
  promoteConfigSnapshotToLastKnownGood as promoteConfigSnapshotToLastKnownGoodWithDeps,
  recoverConfigFromLastKnownGood as recoverConfigFromLastKnownGoodWithDeps,
} from "./io.observe-recovery.js";
import { persistGeneratedOwnerDisplaySecret } from "./io.owner-display-secret.js";
import {
  collectChangedPaths,
  createMergePatch,
  formatConfigValidationFailure,
  applyUnsetPathsForWrite,
  projectSourceOntoRuntimeShape,
  restoreEnvRefsFromMap,
  resolvePersistCandidateForWrite,
  resolveManagedUnsetPathsForWrite,
  resolveWriteEnvSnapshotForPath,
} from "./io.write-prepare.js";
import { findLegacyConfigIssues } from "./legacy.js";
import {
  asResolvedSourceConfig,
  asRuntimeConfig,
  materializeRuntimeConfig,
} from "./materialize.js";
import { applyMergePatch } from "./merge-patch.js";
import { resolveConfigPath, resolveStateDir } from "./paths.js";
import {
  extractShippedPluginInstallConfigRecords,
  stripShippedPluginInstallConfigRecords,
} from "./plugin-install-config-migration.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import {
  clearRuntimeConfigSnapshot as clearRuntimeConfigSnapshotState,
  createRuntimeConfigWriteNotification,
  finalizeRuntimeSnapshotWrite,
  getRuntimeConfigSnapshotMetadata as getRuntimeConfigSnapshotMetadataState,
  getRuntimeConfigSnapshot as getRuntimeConfigSnapshotState,
  getRuntimeConfigSourceSnapshot as getRuntimeConfigSourceSnapshotState,
  loadPinnedRuntimeConfig,
  notifyRuntimeConfigWriteListeners,
  registerRuntimeConfigWriteListener,
  resetConfigRuntimeState as resetConfigRuntimeStateState,
  resolveRuntimeConfigCacheKey,
  selectApplicableRuntimeConfig,
  setRuntimeConfigSnapshot as setRuntimeConfigSnapshotState,
  getRuntimeConfigSnapshotRefreshHandler as getRuntimeConfigSnapshotRefreshHandlerState,
  setRuntimeConfigSnapshotRefreshHandler as setRuntimeConfigSnapshotRefreshHandlerState,
  type ConfigWriteAfterWrite,
  type RuntimeConfigWriteNotification,
} from "./runtime-snapshot.js";
import { resolveShellEnvExpectedKeys } from "./shell-env-expected-keys.js";
import type { OpenClawConfig, ConfigFileSnapshot, LegacyConfigIssue } from "./types.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
import { shouldWarnOnTouchedVersion } from "./version.js";

export {
  clearRuntimeConfigSnapshotState as clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadataState as getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSnapshotState as getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshotState as getRuntimeConfigSourceSnapshot,
  resetConfigRuntimeStateState as resetConfigRuntimeState,
  resolveRuntimeConfigCacheKey,
  selectApplicableRuntimeConfig,
  setRuntimeConfigSnapshotState as setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandlerState as setRuntimeConfigSnapshotRefreshHandler,
};

// Re-export for backwards compatibility
export { CircularIncludeError, ConfigIncludeError } from "./includes.js";
export { MissingEnvVarError } from "./env-substitution.js";
export { resolveShellEnvExpectedKeys } from "./shell-env-expected-keys.js";

type ShippedPluginInstallConfigWriteMigration =
  | {
      migrated: false;
    }
  | {
      migrated: true;
      filePath: string;
      previousFile:
        | {
            existed: false;
          }
        | {
            existed: true;
            raw: string;
          };
    };

type ShippedPluginInstallConfigReadMigration = {
  config: unknown;
  persistedRootParsed?: unknown;
  persistedRootRaw?: string;
};

const CONFIG_HEALTH_STATE_FILENAME = "config-health.json";
const loggedInvalidConfigs = new Set<string>();

type ConfigHealthFingerprint = {
  hash: string;
  bytes: number;
  mtimeMs: number | null;
  ctimeMs: number | null;
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
  hasMeta: boolean;
  gatewayMode: string | null;
  observedAt: string;
};

type ConfigHealthEntry = {
  lastKnownGood?: ConfigHealthFingerprint;
  lastPromotedGood?: ConfigHealthFingerprint;
  lastObservedSuspiciousSignature?: string | null;
};

type ConfigHealthState = {
  entries?: Record<string, ConfigHealthEntry>;
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
  /**
   * Internal fast path for callers that already hold a fresh config snapshot.
   * Avoids rereading the full config just to prepare an immediate write.
   */
  baseSnapshot?: ConfigFileSnapshot;
  /**
   * Internal one-shot CLI fast path. When no runtime snapshot is active, skip
   * the post-write runtime snapshot refresh/reload tail entirely.
   */
  skipRuntimeSnapshotRefresh?: boolean;
  /**
   * Allow intentionally destructive config writes, such as explicit reset flows.
   * Normal writers must keep this false so clobbers are rejected before disk commit.
   */
  allowDestructiveWrite?: boolean;
  /**
   * Suppress human-readable output logs (overwrite/anomaly messages).
   * Useful when the caller wants machine-readable output only (--json mode).
   */
  skipOutputLogs?: boolean;
  /**
   * Runtime reload intent for observers that react to committed config writes.
   * Omitted means the observer should use its normal reload plan.
   */
  afterWrite?: ConfigWriteAfterWrite;
};

export type ReadConfigFileSnapshotForWriteResult = {
  snapshot: ConfigFileSnapshot;
  writeOptions: ConfigWriteOptions;
};

export type ConfigWriteNotification = RuntimeConfigWriteNotification;
export type ConfigSnapshotReadMeasure = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;

export class ConfigRuntimeRefreshError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigRuntimeRefreshError";
  }
}

function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

async function tightenStateDirPermissionsIfNeeded(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  fsModule: typeof fs;
}): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const stateDir = resolveStateDir(params.env, params.homedir);
  const configDir = path.dirname(params.configPath);
  if (path.resolve(configDir) !== path.resolve(stateDir)) {
    return;
  }
  try {
    const stat = await params.fsModule.promises.stat(configDir);
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) === 0) {
      return;
    }
    await params.fsModule.promises.chmod(configDir, 0o700);
  } catch {
    // Best-effort hardening only; callers still need the config write to proceed.
  }
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

function hasConfigMeta(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const meta = value.meta;
  return isRecord(meta);
}

function resolveGatewayMode(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const gateway = value.gateway;
  if (!isRecord(gateway) || typeof gateway.mode !== "string") {
    return null;
  }
  const trimmed = gateway.mode.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      collectEnvRefPaths(child, childPath, output);
    }
  }
}

function resolveConfigHealthStatePath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  return path.join(resolveStateDir(env, homedir), "logs", CONFIG_HEALTH_STATE_FILENAME);
}

function normalizeStatNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStatId(value: number | bigint | null | undefined): string | null {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function resolveConfigStatMetadata(
  stat: fs.Stats | null,
): Pick<ConfigHealthFingerprint, "dev" | "ino" | "mode" | "nlink" | "uid" | "gid"> {
  return {
    dev: normalizeStatId(stat?.dev ?? null),
    ino: normalizeStatId(stat?.ino ?? null),
    mode: normalizeStatNumber(stat ? stat.mode & 0o777 : null),
    nlink: normalizeStatNumber(stat?.nlink ?? null),
    uid: normalizeStatNumber(stat?.uid ?? null),
    gid: normalizeStatNumber(stat?.gid ?? null),
  };
}

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

function resolveConfigWriteBlockingReasons(suspicious: string[]): string[] {
  return suspicious.filter(
    (reason) => reason.startsWith("size-drop:") || reason === "gateway-mode-removed",
  );
}

/* lyc:ai 
readConfigHealthState 异步读取配置健康状态文件。
- 文件路径：~/.openclaw/logs/config-health.json
- 包含每个配置文件的健康信息（最后已知良好状态、可疑签名等）
- 如果文件不存在或解析失败，返回空对象（安全默认值）
*/
async function readConfigHealthState(deps: Required<ConfigIoDeps>): Promise<ConfigHealthState> {
  try {
    const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
    const raw = await deps.fs.promises.readFile(healthPath, "utf-8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as ConfigHealthState) : {};
  } catch {
    return {};
  }
}

/* lyc:ai 
readConfigHealthStateSync 是 readConfigHealthState 的同步版本。
用于同步代码路径中读取配置健康状态。
*/
function readConfigHealthStateSync(deps: Required<ConfigIoDeps>): ConfigHealthState {
  try {
    const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
    const raw = deps.fs.readFileSync(healthPath, "utf-8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as ConfigHealthState) : {};
  } catch {
    return {};
  }
}

/* lyc:ai 
writeConfigHealthState 异步写入配置健康状态文件。
- 创建目录（递归，权限 0o700）
- 写入格式化的 JSON 文件（权限 0o600）
- 最佳努力模式：失败时静默忽略（不影响主流程）
*/
async function writeConfigHealthState(
  deps: Required<ConfigIoDeps>,
  state: ConfigHealthState,
): Promise<void> {
  try {
    const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
    await deps.fs.promises.mkdir(path.dirname(healthPath), { recursive: true, mode: 0o700 });
    await deps.fs.promises.writeFile(healthPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best-effort
  }
}

/* lyc:ai 
writeConfigHealthStateSync 是 writeConfigHealthState 的同步版本。
用于同步代码路径中写入配置健康状态。
*/
function writeConfigHealthStateSync(deps: Required<ConfigIoDeps>, state: ConfigHealthState): void {
  try {
    const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
    deps.fs.mkdirSync(path.dirname(healthPath), { recursive: true, mode: 0o700 });
    deps.fs.writeFileSync(healthPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best-effort
  }
}

function getConfigHealthEntry(state: ConfigHealthState, configPath: string): ConfigHealthEntry {
  const entries = state.entries;
  if (!entries || !isRecord(entries)) {
    return {};
  }
  const entry = entries[configPath];
  return entry && isRecord(entry) ? entry : {};
}

function setConfigHealthEntry(
  state: ConfigHealthState,
  configPath: string,
  entry: ConfigHealthEntry,
): ConfigHealthState {
  return {
    ...state,
    entries: {
      ...state.entries,
      [configPath]: entry,
    },
  };
}

function isUpdateChannelOnlyRoot(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "update") {
    return false;
  }
  const update = value.update;
  if (!isRecord(update)) {
    return false;
  }
  const updateKeys = Object.keys(update);
  return updateKeys.length === 1 && typeof update.channel === "string";
}

/* lyc:ai 
resolveConfigObserveSuspiciousReasons 函数负责检测配置文件的可疑变化。
它将当前配置与基线配置（上次已知良好或备份）进行比较，
识别可能表明配置被意外修改或损坏的模式。

可疑变化检测规则：

1. **文件大小骤减**（size-drop-vs-last-good）
   - 条件：基线文件大小 >= 512 字节，且当前文件大小 < 基线大小的 50%
   - 风险：可能被意外截断、覆盖或清空

2. **元数据丢失**（missing-meta-vs-last-good）
   - 条件：基线包含 meta 字段，但当前配置不包含
   - 风险：配置完整性受损，可能缺少重要元信息

3. **网关模式丢失**（gateway-mode-missing-vs-last-good）
   - 条件：基线有 gateway.mode 设置，但当前配置没有
   - 风险：网关功能可能被意外禁用

4. **仅更新通道根配置**（update-channel-only-root）
   - 条件：基线有 gateway.mode 且当前配置只有 update.channel 字段
   - 风险：配置可能被简化工具意外覆盖，只保留了更新通道设置

设计考虑：
- 基线要求：只有存在有效的基线配置时才进行比较
- 阈值设置：文件大小检查使用 512 字节阈值和 50% 比例，避免误报小文件
- 组合检测：多个可疑指标可以同时触发，提供全面的保护
*/
function resolveConfigObserveSuspiciousReasons(params: {
  /* lyc:ai 当前配置文件的字节大小 */
  bytes: number;
  /* lyc:ai 当前配置是否包含 meta 字段 */
  hasMeta: boolean;
  /* lyc:ai 当前配置的网关模式（如果存在） */
  gatewayMode: string | null;
  /* lyc:ai 当前配置的解析后对象 */
  parsed: unknown;
  /* lyc:ai 基线配置（上次已知良好或从备份读取） */
  lastKnownGood?: ConfigHealthFingerprint;
}): string[] {
  const reasons: string[] = [];
  const baseline = params.lastKnownGood;
  /* lyc:ai 如果没有基线配置，则无法进行比较，返回空数组 */
  if (!baseline) {
    return reasons;
  }
  
  /* lyc:ai 检测文件大小骤减：可能表明配置被意外截断或覆盖 */
  if (baseline.bytes >= 512 && params.bytes < Math.floor(baseline.bytes * 0.5)) {
    reasons.push(`size-drop-vs-last-good:${baseline.bytes}->${params.bytes}`);
  }
  
  /* lyc:ai 检测元数据丢失：meta 字段是配置完整性的重要指标 */
  if (baseline.hasMeta && !params.hasMeta) {
    reasons.push("missing-meta-vs-last-good");
  }
  
  /* lyc:ai 检测网关模式丢失：可能影响网关功能 */
  if (baseline.gatewayMode && !params.gatewayMode) {
    reasons.push("gateway-mode-missing-vs-last-good");
  }
  
  /* lyc:ai 
  检测仅更新通道的根配置：
  这种模式通常出现在配置被简化工具处理后，
  只保留了 update.channel 设置而丢失了其他重要配置
  */
  if (baseline.gatewayMode && isUpdateChannelOnlyRoot(params.parsed)) {
    reasons.push("update-channel-only-root");
  }
  
  return reasons;
}

async function readConfigFingerprintForPath(
  deps: Required<ConfigIoDeps>,
  targetPath: string,
): Promise<ConfigHealthFingerprint | null> {
  try {
    const raw = await deps.fs.promises.readFile(targetPath, "utf-8");
    const stat = await deps.fs.promises.stat(targetPath).catch(() => null);
    const parsedRes = parseConfigJson5(raw, deps.json5);
    const parsed = parsedRes.ok ? parsedRes.parsed : {};
    return {
      hash: hashConfigRaw(raw),
      bytes: Buffer.byteLength(raw, "utf-8"),
      mtimeMs: stat?.mtimeMs ?? null,
      ctimeMs: stat?.ctimeMs ?? null,
      ...resolveConfigStatMetadata(stat),
      hasMeta: hasConfigMeta(parsed),
      gatewayMode: resolveGatewayMode(parsed),
      observedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function readConfigFingerprintForPathSync(
  deps: Required<ConfigIoDeps>,
  targetPath: string,
): ConfigHealthFingerprint | null {
  try {
    const raw = deps.fs.readFileSync(targetPath, "utf-8");
    const stat = deps.fs.statSync(targetPath, { throwIfNoEntry: false }) ?? null;
    const parsedRes = parseConfigJson5(raw, deps.json5);
    const parsed = parsedRes.ok ? parsedRes.parsed : {};
    return {
      hash: hashConfigRaw(raw),
      bytes: Buffer.byteLength(raw, "utf-8"),
      mtimeMs: stat?.mtimeMs ?? null,
      ctimeMs: stat?.ctimeMs ?? null,
      ...resolveConfigStatMetadata(stat),
      hasMeta: hasConfigMeta(parsed),
      gatewayMode: resolveGatewayMode(parsed),
      observedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function formatConfigArtifactTimestamp(ts: string): string {
  return ts.replaceAll(":", "-").replaceAll(".", "-");
}

/* lyc:ai 
persistClobberedConfigSnapshot 函数负责保存被覆盖的配置文件副本。
这是配置健康监控的关键安全机制，防止用户因意外覆盖而丢失配置。

关键特性：
- 文件命名：config.json.clobbered.YYYY-MM-DDTHH-MM-SS-sssZ
- 原子写入：使用 "wx" 标志确保不会覆盖现有文件
- 安全权限：文件权限设置为 0o600（仅所有者可读写）
- 最佳努力：失败时返回 null，不影响主流程

使用场景：
- 检测到可疑配置变化时自动触发
- 为用户提供恢复原始配置的能力
*/
async function persistClobberedConfigSnapshot(params: {
  deps: Required<ConfigIoDeps>;
  configPath: string;
  raw: string;
  observedAt: string;
}): Promise<string | null> {
  /* lyc:ai 
  生成被覆盖配置文件的唯一路径：
  - 基础路径：原配置文件路径
  - 后缀：.clobbered.时间戳
  - 时间戳格式：YYYY-MM-DDTHH-MM-SS-sssZ（ISO 8601 变体）
  */
  const targetPath = `${params.configPath}.clobbered.${formatConfigArtifactTimestamp(params.observedAt)}`;
  try {
    /* lyc:ai 
    安全写入被覆盖的配置文件：
    - encoding: "utf-8" 确保正确的文本编码
    - mode: 0o600 限制文件权限（仅所有者可访问）
    - flag: "wx" 原子写入，如果文件已存在则失败（防止覆盖）
    */
    await params.deps.fs.promises.writeFile(targetPath, params.raw, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    return targetPath;
  } catch {
    /* lyc:ai 写入失败时返回 null（最佳努力模式） */
    return null;
  }
}

/* lyc:ai 
persistClobberedConfigSnapshotSync 是 persistClobberedConfigSnapshot 的同步版本。
用于同步代码路径中保存被覆盖的配置文件副本。
*/
function persistClobberedConfigSnapshotSync(params: {
  deps: Required<ConfigIoDeps>;
  configPath: string;
  raw: string;
  observedAt: string;
}): string | null {
  const targetPath = `${params.configPath}.clobbered.${formatConfigArtifactTimestamp(params.observedAt)}`;
  try {
    params.deps.fs.writeFileSync(targetPath, params.raw, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    return targetPath;
  } catch {
    return null;
  }
}

function sameFingerprint(
  left: ConfigHealthFingerprint | undefined,
  right: ConfigHealthFingerprint,
): boolean {
  if (!left) {
    return false;
  }
  return (
    left.hash === right.hash &&
    left.bytes === right.bytes &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.hasMeta === right.hasMeta &&
    left.gatewayMode === right.gatewayMode
  );
}


/* lyc:ai 
observeConfigSnapshot 是配置健康监控的核心函数。
它在每次读取配置文件时执行，用于检测和记录可疑的配置变化。

核心功能：
1. 创建配置文件的健康指纹（ConfigHealthFingerprint）
2. 检测可疑的配置变化（如文件大小骤减、元数据丢失等）
3. 自动保存被覆盖的配置文件副本（.clobbered 文件）
4. 记录详细的审计日志
5. 更新配置健康状态

设计目标：
- 预防性：在问题发生时立即检测并记录
- 安全性：自动备份可疑的配置文件，防止数据丢失
- 可追溯性：详细的审计日志帮助诊断问题根源
- 性能：只在必要时执行昂贵的操作（如文件备份）

调用时机：
- 每次调用 readConfigFileSnapshot() 时
- 通过 finalizeReadConfigSnapshotInternalResult() 间接调用
*/
async function observeConfigSnapshot(
  deps: Required<ConfigIoDeps>,
  snapshot: ConfigFileSnapshot,
): Promise<void> {
  /* lyc:ai 如果配置文件不存在或没有原始内容，则跳过健康检查 */
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return;
  }

  /* lyc:ai ========== 阶段一：创建当前配置的健康指纹 ========== */
  /* lyc:ai 获取配置文件的文件系统统计信息 */
  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const now = new Date().toISOString();
  /* lyc:ai 
  创建当前配置的健康指纹，包含以下关键信息：
  - hash: 配置内容的 SHA256 哈希值
  - bytes: 文件大小（字节）
  - mtimeMs/ctimeMs: 修改时间和创建时间
  - 文件系统元数据（dev, ino, mode, nlink, uid, gid）
  - hasMeta: 是否包含 meta 字段（配置完整性指标）
  - gatewayMode: 网关模式设置
  - observedAt: 观察时间戳
  */
  const current: ConfigHealthFingerprint = {
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    bytes: Buffer.byteLength(snapshot.raw, "utf-8"),
    mtimeMs: stat?.mtimeMs ?? null,
    ctimeMs: stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(stat),
    hasMeta: hasConfigMeta(snapshot.parsed),
    gatewayMode: resolveGatewayMode(snapshot.resolved),
    observedAt: now,
  };

  /* lyc:ai ========== 阶段二：获取历史健康状态和基线 ========== */
  /* lyc:ai 读取配置健康状态文件（~/.openclaw/logs/config-health.json） */
  let healthState = await readConfigHealthState(deps);
  /* lyc:ai 获取当前配置路径的健康条目 */
  const entry = getConfigHealthEntry(healthState, snapshot.path);
  /* lyc:ai 
  确定基线配置用于比较：
  1. 优先使用上次已知良好的配置（lastKnownGood）
  2. 其次尝试从备份文件（.bak）中读取
  3. 如果都没有，则使用 undefined
  */
  const backupBaseline =
    entry.lastKnownGood ??
    (await readConfigFingerprintForPath(deps, `${snapshot.path}.bak`)) ??
    undefined;
  
  /* lyc:ai ========== 阶段三：检测可疑配置变化 ========== */
  /* lyc:ai 调用 resolveConfigObserveSuspiciousReasons 检测可疑变化 */
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: current.bytes,
    hasMeta: current.hasMeta,
    gatewayMode: current.gatewayMode,
    parsed: snapshot.parsed,
    lastKnownGood: backupBaseline,
  });

  /* lyc:ai ========== 阶段四：处理正常配置情况 ========== */
  /* lyc:ai 如果没有检测到可疑变化 */
  if (suspicious.length === 0) {
    /* lyc:ai 如果配置有效，更新最后已知良好状态 */
    if (snapshot.valid) {
      const nextEntry: ConfigHealthEntry = {
        ...entry,
        lastKnownGood: current,
        lastObservedSuspiciousSignature: null,
      };
      /* lyc:ai 
      只有在状态实际发生变化时才写入健康状态文件：
      - 当前指纹与上次已知良好指纹不同，或
      - 之前有可疑签名记录（需要清除）
      */
      if (
        !sameFingerprint(entry.lastKnownGood, current) ||
        entry.lastObservedSuspiciousSignature !== null
      ) {
        healthState = setConfigHealthEntry(healthState, snapshot.path, nextEntry);
        await writeConfigHealthState(deps, healthState);
      }
    }
    return;
  }

  /* lyc:ai ========== 阶段五：处理可疑配置情况 ========== */
  /* lyc:ai 创建可疑配置的唯一签名，用于去重 */
  const suspiciousSignature = `${current.hash}:${suspicious.join(",")}`;
  /* lyc:ai 如果已经报告过相同的可疑签名，则跳过重复报告 */
  if (entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return;
  }

  /* lyc:ai 尝试获取备份配置的完整指纹（用于审计日志） */
  const backup =
    (backupBaseline?.hash ? backupBaseline : null) ??
    (await readConfigFingerprintForPath(deps, `${snapshot.path}.bak`));
  /* lyc:ai 
  保存被覆盖的配置文件副本：
  - 文件名格式：config.json.clobbered.YYYY-MM-DDTHH-MM-SS-sssZ
  - 这确保了即使配置被意外覆盖，用户也能恢复原始内容
  */
  const clobberedPath = await persistClobberedConfigSnapshot({
    deps,
    configPath: snapshot.path,
    raw: snapshot.raw,
    observedAt: now,
  });

  /* lyc:ai 记录可疑配置警告 */
  deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
  
  /* lyc:ai ========== 阶段六：记录详细的审计日志 ========== */
  /* lyc:ai 
  创建完整的配置观察审计记录，包含：
  - 时间戳和进程信息
  - 当前配置的详细信息
  - 可疑原因列表
  - 最后已知良好配置的对比信息
  - 备份配置信息
  - 被覆盖文件的保存路径
  */
  await appendConfigAuditRecord({
    fs: deps.fs,
    env: deps.env,
    homedir: deps.homedir,
    record: {
      ts: now,
      source: "config-io",
      event: "config.observe",
      phase: "read",
      configPath: snapshot.path,
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      argv: process.argv.slice(0, 8),
      execArgv: process.execArgv.slice(0, 8),
      exists: true,
      valid: snapshot.valid,
      hash: current.hash,
      bytes: current.bytes,
      mtimeMs: current.mtimeMs,
      ctimeMs: current.ctimeMs,
      dev: current.dev,
      ino: current.ino,
      mode: current.mode,
      nlink: current.nlink,
      uid: current.uid,
      gid: current.gid,
      hasMeta: current.hasMeta,
      gatewayMode: current.gatewayMode,
      suspicious,
      lastKnownGoodHash: entry.lastKnownGood?.hash ?? null,
      lastKnownGoodBytes: entry.lastKnownGood?.bytes ?? null,
      lastKnownGoodMtimeMs: entry.lastKnownGood?.mtimeMs ?? null,
      lastKnownGoodCtimeMs: entry.lastKnownGood?.ctimeMs ?? null,
      lastKnownGoodDev: entry.lastKnownGood?.dev ?? null,
      lastKnownGoodIno: entry.lastKnownGood?.ino ?? null,
      lastKnownGoodMode: entry.lastKnownGood?.mode ?? null,
      lastKnownGoodNlink: entry.lastKnownGood?.nlink ?? null,
      lastKnownGoodUid: entry.lastKnownGood?.uid ?? null,
      lastKnownGoodGid: entry.lastKnownGood?.gid ?? null,
      lastKnownGoodGatewayMode: entry.lastKnownGood?.gatewayMode ?? null,
      backupHash: backup?.hash ?? null,
      backupBytes: backup?.bytes ?? null,
      backupMtimeMs: backup?.mtimeMs ?? null,
      backupCtimeMs: backup?.ctimeMs ?? null,
      backupDev: backup?.dev ?? null,
      backupIno: backup?.ino ?? null,
      backupMode: backup?.mode ?? null,
      backupNlink: backup?.nlink ?? null,
      backupUid: backup?.uid ?? null,
      backupGid: backup?.gid ?? null,
      backupGatewayMode: backup?.gatewayMode ?? null,
      clobberedPath,
      restoredFromBackup: false,
      restoredBackupPath: null,
    },
  });

  /* lyc:ai ========== 阶段七：更新健康状态 ========== */
  /* lyc:ai 记录当前可疑签名，防止重复报告 */
  healthState = setConfigHealthEntry(healthState, snapshot.path, {
    ...entry,
    lastObservedSuspiciousSignature: suspiciousSignature,
  });
  await writeConfigHealthState(deps, healthState);
}

/* lyc:ai 
observeConfigSnapshotSync 是 observeConfigSnapshot 的同步版本。
它提供相同的功能但使用同步 I/O 操作，主要用于以下场景：
- 测试环境（避免异步复杂性）
- 配置加载的同步路径
- 错误恢复路径中的同步操作

与异步版本的主要区别：
- 使用 fs.statSync 而不是 fs.promises.stat
- 使用 readConfigHealthStateSync 而不是异步版本
- 使用 persistClobberedConfigSnapshotSync 而不是异步版本
- 使用 appendConfigAuditRecordSync 而不是异步版本

功能完全相同：检测可疑配置变化、保存备份、记录审计日志。
*/
function observeConfigSnapshotSync(
  deps: Required<ConfigIoDeps>,
  snapshot: ConfigFileSnapshot,
): void {
  /* lyc:ai 如果配置文件不存在或没有原始内容，则跳过健康检查 */
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return;
  }

  /* lyc:ai ========== 阶段一：创建当前配置的健康指纹（同步版本） ========== */
  /* lyc:ai 使用同步 I/O 获取配置文件的文件系统统计信息 */
  const stat = deps.fs.statSync(snapshot.path, { throwIfNoEntry: false }) ?? null;
  const now = new Date().toISOString();
  const current: ConfigHealthFingerprint = {
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    bytes: Buffer.byteLength(snapshot.raw, "utf-8"),
    mtimeMs: stat?.mtimeMs ?? null,
    ctimeMs: stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(stat),
    hasMeta: hasConfigMeta(snapshot.parsed),
    gatewayMode: resolveGatewayMode(snapshot.resolved),
    observedAt: now,
  };

  /* lyc:ai ========== 阶段二：获取历史健康状态和基线（同步版本） ========== */
  /* lyc:ai 使用同步函数读取配置健康状态 */
  let healthState = readConfigHealthStateSync(deps);
  const entry = getConfigHealthEntry(healthState, snapshot.path);
  const backupBaseline =
    entry.lastKnownGood ??
    readConfigFingerprintForPathSync(deps, `${snapshot.path}.bak`) ??
    undefined;
  
  /* lyc:ai ========== 阶段三：检测可疑配置变化 ========== */
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: current.bytes,
    hasMeta: current.hasMeta,
    gatewayMode: current.gatewayMode,
    parsed: snapshot.parsed,
    lastKnownGood: backupBaseline,
  });

  /* lyc:ai ========== 阶段四：处理正常配置情况 ========== */
  if (suspicious.length === 0) {
    if (snapshot.valid) {
      const nextEntry: ConfigHealthEntry = {
        ...entry,
        lastKnownGood: current,
        lastObservedSuspiciousSignature: null,
      };
      if (
        !sameFingerprint(entry.lastKnownGood, current) ||
        entry.lastObservedSuspiciousSignature !== null
      ) {
        healthState = setConfigHealthEntry(healthState, snapshot.path, nextEntry);
        /* lyc:ai 使用同步函数写入健康状态 */
        writeConfigHealthStateSync(deps, healthState);
      }
    }
    return;
  }

  /* lyc:ai ========== 阶段五：处理可疑配置情况 ========== */
  const suspiciousSignature = `${current.hash}:${suspicious.join(",")}`;
  if (entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return;
  }

  /* lyc:ai 尝试获取备份配置的完整指纹（同步版本） */
  const backup =
    (backupBaseline?.hash ? backupBaseline : null) ??
    readConfigFingerprintForPathSync(deps, `${snapshot.path}.bak`);
  /* lyc:ai 保存被覆盖的配置文件副本（同步版本） */
  const clobberedPath = persistClobberedConfigSnapshotSync({
    deps,
    configPath: snapshot.path,
    raw: snapshot.raw,
    observedAt: now,
  });

  /* lyc:ai 记录可疑配置警告 */
  deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
  
  /* lyc:ai ========== 阶段六：记录详细的审计日志（同步版本） ========== */
  appendConfigAuditRecordSync({
    fs: deps.fs,
    env: deps.env,
    homedir: deps.homedir,
    record: {
      ts: now,
      source: "config-io",
      event: "config.observe",
      phase: "read",
      configPath: snapshot.path,
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      argv: process.argv.slice(0, 8),
      execArgv: process.execArgv.slice(0, 8),
      exists: true,
      valid: snapshot.valid,
      hash: current.hash,
      bytes: current.bytes,
      mtimeMs: current.mtimeMs,
      ctimeMs: current.ctimeMs,
      dev: current.dev,
      ino: current.ino,
      mode: current.mode,
      nlink: current.nlink,
      uid: current.uid,
      gid: current.gid,
      hasMeta: current.hasMeta,
      gatewayMode: current.gatewayMode,
      suspicious,
      lastKnownGoodHash: entry.lastKnownGood?.hash ?? null,
      lastKnownGoodBytes: entry.lastKnownGood?.bytes ?? null,
      lastKnownGoodMtimeMs: entry.lastKnownGood?.mtimeMs ?? null,
      lastKnownGoodCtimeMs: entry.lastKnownGood?.ctimeMs ?? null,
      lastKnownGoodDev: entry.lastKnownGood?.dev ?? null,
      lastKnownGoodIno: entry.lastKnownGood?.ino ?? null,
      lastKnownGoodMode: entry.lastKnownGood?.mode ?? null,
      lastKnownGoodNlink: entry.lastKnownGood?.nlink ?? null,
      lastKnownGoodUid: entry.lastKnownGood?.uid ?? null,
      lastKnownGoodGid: entry.lastKnownGood?.gid ?? null,
      lastKnownGoodGatewayMode: entry.lastKnownGood?.gatewayMode ?? null,
      backupHash: backup?.hash ?? null,
      backupBytes: backup?.bytes ?? null,
      backupMtimeMs: backup?.mtimeMs ?? null,
      backupCtimeMs: backup?.ctimeMs ?? null,
      backupDev: backup?.dev ?? null,
      backupIno: backup?.ino ?? null,
      backupMode: backup?.mode ?? null,
      backupNlink: backup?.nlink ?? null,
      backupUid: backup?.uid ?? null,
      backupGid: backup?.gid ?? null,
      backupGatewayMode: backup?.gatewayMode ?? null,
      clobberedPath,
      restoredFromBackup: false,
      restoredBackupPath: null,
    },
  });

  healthState = setConfigHealthEntry(healthState, snapshot.path, {
    ...entry,
    lastObservedSuspiciousSignature: suspiciousSignature,
  });
  writeConfigHealthStateSync(deps, healthState);
}

export type ConfigIoDeps = {
  fs?: typeof fs;
  json5?: typeof JSON5;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  configPath?: string;
  logger?: Pick<typeof console, "error" | "warn">;
  measure?: ConfigSnapshotReadMeasure;
};

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

function warnIfConfigFromFuture(cfg: OpenClawConfig, logger: Pick<typeof console, "warn">): void {
  const touched = cfg.meta?.lastTouchedVersion;
  if (!touched) {
    return;
  }
  if (shouldWarnOnTouchedVersion(VERSION, touched)) {
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
    measure: overrides.measure ?? (async (_name, run) => await run()),
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

function findJsonRootSuffix(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): { raw: string; parsed: unknown } | null {
  if (/^\s*(?:\{|\[)/.test(raw)) {
    return null;
  }
  let offset = 0;
  while (offset < raw.length) {
    const nextNewline = raw.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? raw.length : nextNewline + 1;
    const line = raw.slice(offset, lineEnd);
    if (/^\s*(?:\{|\[)/.test(line)) {
      const candidate = raw.slice(offset);
      const parsed = parseConfigJson5(candidate, json5);
      return parsed.ok ? { raw: candidate, parsed: parsed.parsed } : null;
    }
    offset = lineEnd;
  }
  return null;
}

async function persistPrefixedConfigRecovery(params: {
  deps: Required<ConfigIoDeps>;
  configPath: string;
  originalRaw: string;
  recoveredRaw: string;
}): Promise<void> {
  const observedAt = new Date().toISOString();
  const clobberedPath = await persistClobberedConfigSnapshot({
    deps: params.deps,
    configPath: params.configPath,
    raw: params.originalRaw,
    observedAt,
  });
  await params.deps.fs.promises.writeFile(params.configPath, params.recoveredRaw, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await params.deps.fs.promises.chmod?.(params.configPath, 0o600).catch(() => {});
  params.deps.logger.warn(
    `Config auto-stripped non-JSON prefix: ${params.configPath}` +
      (clobberedPath ? ` (original saved as ${clobberedPath})` : ""),
  );
}

async function recoverConfigFromJsonRootSuffixWithDeps(params: {
  deps: Required<ConfigIoDeps>;
  configPath: string;
  snapshot: ConfigFileSnapshot;
}): Promise<boolean> {
  if (!params.snapshot.exists || params.snapshot.valid || typeof params.snapshot.raw !== "string") {
    return false;
  }
  const suffixRecovery = findJsonRootSuffix(params.snapshot.raw, params.deps.json5);
  if (!suffixRecovery) {
    return false;
  }

  let resolved: unknown;
  try {
    resolved = resolveConfigIncludesForRead(suffixRecovery.parsed, params.configPath, params.deps);
  } catch {
    return false;
  }
  const readResolution = resolveConfigForRead(resolved, params.deps.env);
  const legacyResolution = resolveLegacyConfigForRead(
    readResolution.resolvedConfigRaw,
    suffixRecovery.parsed,
  );
  const validated = validateConfigObjectWithPlugins(
    stripShippedPluginInstallConfigRecords(legacyResolution.effectiveConfigRaw),
    {
      env: params.deps.env,
    },
  );
  if (!validated.ok) {
    return false;
  }

  await persistPrefixedConfigRecovery({
    deps: params.deps,
    configPath: params.configPath,
    originalRaw: params.snapshot.raw,
    recoveredRaw: suffixRecovery.raw,
  });
  return true;
}

type ConfigReadResolution = {
  resolvedConfigRaw: unknown;
  envSnapshotForRestore: Record<string, string | undefined>;
  envWarnings: EnvSubstitutionWarning[];
};

type LegacyMigrationResolution = {
  effectiveConfigRaw: unknown;
  sourceLegacyIssues: LegacyConfigIssue[];
};

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

function resolveConfigForRead(
  resolvedIncludes: unknown,
  env: NodeJS.ProcessEnv,
): ConfigReadResolution {
  // Apply config.env to process.env BEFORE substitution so ${VAR} can reference config-defined vars.
  if (resolvedIncludes && typeof resolvedIncludes === "object" && "env" in resolvedIncludes) {
    applyConfigEnvVars(resolvedIncludes as OpenClawConfig, env);
  }

  // Collect missing env var references as warnings instead of throwing,
  // so non-critical config sections with unset vars don't crash the gateway.
  const envWarnings: EnvSubstitutionWarning[] = [];
  return {
    resolvedConfigRaw: resolveConfigEnvVars(resolvedIncludes, env, {
      onMissing: (w) => envWarnings.push(w),
    }),
    // Capture env snapshot after substitution for write-time ${VAR} restoration.
    envSnapshotForRestore: { ...env } as Record<string, string | undefined>,
    envWarnings,
  };
}

function resolveLegacyConfigForRead(
  resolvedConfigRaw: unknown,
  sourceRaw: unknown,
): LegacyMigrationResolution {
  const pluginIds = collectRelevantDoctorPluginIds(resolvedConfigRaw);
  const sourceLegacyIssues = findLegacyConfigIssues(
    resolvedConfigRaw,
    sourceRaw,
    listPluginDoctorLegacyConfigRules({ pluginIds }),
  );
  if (!resolvedConfigRaw || typeof resolvedConfigRaw !== "object") {
    return {
      effectiveConfigRaw: resolvedConfigRaw,
      sourceLegacyIssues,
    };
  }
  const compat = applyRuntimeLegacyConfigMigrations(resolvedConfigRaw);
  return {
    effectiveConfigRaw: compat.next ?? resolvedConfigRaw,
    sourceLegacyIssues,
  };
}

type ReadConfigFileSnapshotInternalResult = {
  snapshot: ConfigFileSnapshot;
  envSnapshotForRestore?: Record<string, string | undefined>;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

export type ReadConfigFileSnapshotWithPluginMetadataResult = {
  snapshot: ConfigFileSnapshot;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

function createConfigFileSnapshot(params: {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  sourceConfig: OpenClawConfig;
  valid: boolean;
  runtimeConfig: OpenClawConfig;
  hash?: string;
  issues: ConfigFileSnapshot["issues"];
  warnings: ConfigFileSnapshot["warnings"];
  legacyIssues: LegacyConfigIssue[];
}): ConfigFileSnapshot {
  const sourceConfig = asResolvedSourceConfig(params.sourceConfig);
  const runtimeConfig = asRuntimeConfig(params.runtimeConfig);
  return {
    path: params.path,
    exists: params.exists,
    raw: params.raw,
    parsed: params.parsed,
    sourceConfig,
    resolved: sourceConfig,
    valid: params.valid,
    runtimeConfig,
    config: runtimeConfig,
    hash: params.hash,
    issues: params.issues,
    warnings: params.warnings,
    legacyIssues: params.legacyIssues,
  };
}

/* lyc:ai 
finalizeReadConfigSnapshotInternalResult 是配置快照读取的最终处理函数。
它在 readConfigFileSnapshotInternal 函数的末尾被调用，
负责执行配置健康监控（observeConfigSnapshot）并返回最终结果。

关键作用：
- 触发配置健康检查和可疑变化检测
- 确保每次配置读取都会进行健康监控
- 返回原始结果，不修改快照内容

调用链：
readConfigFileSnapshotInternal() -> finalizeReadConfigSnapshotInternalResult() -> observeConfigSnapshot()
*/
async function finalizeReadConfigSnapshotInternalResult(
  deps: Required<ConfigIoDeps>,
  result: ReadConfigFileSnapshotInternalResult,
): Promise<ReadConfigFileSnapshotInternalResult> {
  /* lyc:ai 执行配置健康监控，检测可疑变化并记录审计日志 */
  await observeConfigSnapshot(deps, result.snapshot);
  return result;
}

export function createConfigIO(
  overrides: ConfigIoDeps & { pluginValidation?: "full" | "skip" } = {},
) {
  const deps = normalizeDeps(overrides);
  const configPath = resolveConfigPathForDeps(deps);

  /* lyc:ai 
  observeLoadConfigSnapshot 是配置加载路径中的同步健康监控函数。
  它在 loadConfig() 函数中被调用，用于同步执行配置健康检查。
  
  与异步版本的区别：
  - 使用 observeConfigSnapshotSync 而不是 observeConfigSnapshot
  - 用于同步配置加载路径（如 CLI 启动时的初始配置加载）
  - 返回原始快照，不修改内容
  
  调用场景：
  - CLI 启动时的配置加载
  - 同步配置验证路径
  */
  function observeLoadConfigSnapshot(snapshot: ConfigFileSnapshot): ConfigFileSnapshot {
    observeConfigSnapshotSync(deps, snapshot);
    return snapshot;
  }

  function finalizeLoadedRuntimeConfig(cfg: OpenClawConfig): OpenClawConfig {
    const duplicates = findDuplicateAgentDirs(cfg, {
      env: deps.env,
      homedir: deps.homedir,
    });
    if (duplicates.length > 0) {
      throw new DuplicateAgentDirError(duplicates);
    }

    applyConfigEnvVars(cfg, deps.env);

    const enabled = shouldEnableShellEnvFallback(deps.env) || cfg.env?.shellEnv?.enabled === true;
    if (enabled && !shouldDeferShellEnvFallback(deps.env)) {
      loadShellEnvFallback({
        enabled: true,
        env: deps.env,
        expectedKeys: resolveShellEnvExpectedKeys(deps.env),
        logger: deps.logger,
        timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(deps.env),
      });
    }

    const pendingSecret = AUTO_OWNER_DISPLAY_SECRET_BY_PATH.get(configPath);
    const ownerDisplaySecretResolution = ensureOwnerDisplaySecret(
      cfg,
      () => pendingSecret ?? crypto.randomBytes(32).toString("hex"),
    );
    const cfgWithOwnerDisplaySecret = persistGeneratedOwnerDisplaySecret({
      config: ownerDisplaySecretResolution.config,
      configPath,
      generatedSecret: ownerDisplaySecretResolution.generatedSecret,
      logger: deps.logger,
      state: {
        pendingByPath: AUTO_OWNER_DISPLAY_SECRET_BY_PATH,
        persistInFlight: AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT,
        persistWarned: AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED,
      },
      persistConfig: (nextConfig, options) => writeConfigFile(nextConfig, options),
    });

    return applyConfigOverrides(cfgWithOwnerDisplaySecret);
  }

  function captureFileSnapshotSync(filePath: string):
    | {
        existed: false;
      }
    | {
        existed: true;
        raw: string;
      } {
    return deps.fs.existsSync(filePath)
      ? ({
          existed: true,
          raw: deps.fs.readFileSync(filePath, "utf-8"),
        } as const)
      : ({ existed: false } as const);
  }

  function restoreFileSnapshotSync(
    filePath: string,
    previousFile:
      | {
          existed: false;
        }
      | {
          existed: true;
          raw: string;
        },
  ): void {
    if (previousFile.existed) {
      deps.fs.writeFileSync(filePath, previousFile.raw, {
        encoding: "utf-8",
        mode: 0o600,
      });
      return;
    }
    try {
      deps.fs.unlinkSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
  }

  function replaceConfigFileSync(raw: string): void {
    const dir = path.dirname(configPath);
    deps.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(
      dir,
      `${path.basename(configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      deps.fs.writeFileSync(tmp, raw, {
        encoding: "utf-8",
        mode: 0o600,
      });
      try {
        deps.fs.renameSync(tmp, configPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EPERM" && code !== "EEXIST") {
          throw err;
        }
        deps.fs.copyFileSync(tmp, configPath);
        deps.fs.chmodSync(configPath, 0o600);
        deps.fs.unlinkSync(tmp);
      }
    } catch (err) {
      try {
        deps.fs.unlinkSync(tmp);
      } catch (cleanupErr) {
        if ((cleanupErr as NodeJS.ErrnoException)?.code !== "ENOENT") {
          deps.logger.warn(`Failed to clean temporary config file ${tmp}: ${String(cleanupErr)}`);
        }
      }
      throw err;
    }
  }

  function migrateAndStripShippedPluginInstallConfigRecords(
    configRaw: unknown,
    options: { persist?: boolean; rootConfigRaw?: unknown } = {},
  ): ShippedPluginInstallConfigReadMigration {
    const installRecords = extractShippedPluginInstallConfigRecords(configRaw);
    const stripped = stripShippedPluginInstallConfigRecords(configRaw);
    if (Object.keys(installRecords).length === 0) {
      return { config: stripped };
    }
    if (options.persist === false) {
      return { config: stripped };
    }

    try {
      const stateDir = resolveStateDir(deps.env, deps.homedir);
      const filePath = resolveInstalledPluginIndexRecordsStorePath({
        env: deps.env,
        stateDir,
      });
      const previousFile = captureFileSnapshotSync(filePath);
      const existingRecords = loadInstalledPluginIndexInstallRecordsSync({
        env: deps.env,
        stateDir,
      });
      const nextRecords = {
        ...installRecords,
        ...existingRecords,
      };
      if (Object.keys(installRecords).some((pluginId) => !(pluginId in existingRecords))) {
        writePersistedInstalledPluginIndexInstallRecordsSync(nextRecords, {
          config: coerceConfig(stripped),
          env: deps.env,
          stateDir,
        });
      }
      const rootConfigRaw = options.rootConfigRaw;
      if (
        rootConfigRaw !== undefined &&
        Object.keys(extractShippedPluginInstallConfigRecords(rootConfigRaw)).length > 0
      ) {
        const persistedRootParsed = stripShippedPluginInstallConfigRecords(rootConfigRaw);
        const persistedRootRaw = JSON.stringify(persistedRootParsed, null, 2)
          .trimEnd()
          .concat("\n");
        try {
          replaceConfigFileSync(persistedRootRaw);
        } catch (err) {
          restoreFileSnapshotSync(filePath, previousFile);
          throw err;
        }
        return { config: stripped, persistedRootParsed, persistedRootRaw };
      }
    } catch (err) {
      deps.logger.warn(
        `Config (${configPath}): could not migrate shipped plugins.installs records into the plugin index: ${formatErrorMessage(
          err,
        )}`,
      );
      return { config: configRaw };
    }

    return { config: stripped };
  }

  function ensureShippedPluginInstallConfigRecordsMigratedForWrite(
    snapshot: ConfigFileSnapshot,
  ): ShippedPluginInstallConfigWriteMigration {
    const installRecords = {
      ...extractShippedPluginInstallConfigRecords(snapshot.sourceConfig),
      ...extractShippedPluginInstallConfigRecords(snapshot.parsed),
    };
    if (Object.keys(installRecords).length === 0) {
      return { migrated: false };
    }

    const stateDir = resolveStateDir(deps.env, deps.homedir);
    const filePath = resolveInstalledPluginIndexRecordsStorePath({
      env: deps.env,
      stateDir,
    });
    const existingRecords = loadInstalledPluginIndexInstallRecordsSync({
      env: deps.env,
      stateDir,
    });
    if (Object.keys(installRecords).every((pluginId) => pluginId in existingRecords)) {
      return { migrated: false };
    }

    const previousFile = deps.fs.existsSync(filePath)
      ? ({
          existed: true,
          raw: deps.fs.readFileSync(filePath, "utf-8"),
        } as const)
      : ({ existed: false } as const);
    try {
      writePersistedInstalledPluginIndexInstallRecordsSync(
        {
          ...installRecords,
          ...existingRecords,
        },
        {
          config: coerceConfig(stripShippedPluginInstallConfigRecords(snapshot.sourceConfig)),
          env: deps.env,
          stateDir,
        },
      );
      return {
        migrated: true,
        filePath,
        previousFile,
      };
    } catch (err) {
      throw new Error(
        `Config write blocked: shipped plugins.installs records in ${configPath} could not be migrated into the plugin index. Fix state directory permissions or run openclaw plugins registry --refresh, then retry. ${formatErrorMessage(
          err,
        )}`,
        { cause: err },
      );
    }
  }

  function rollbackShippedPluginInstallConfigWriteMigration(
    migration: ShippedPluginInstallConfigWriteMigration,
  ): void {
    if (!migration.migrated) {
      return;
    }
    if (migration.previousFile.existed) {
      deps.fs.writeFileSync(migration.filePath, migration.previousFile.raw, {
        encoding: "utf-8",
        mode: 0o600,
      });
      return;
    }
    try {
      deps.fs.unlinkSync(migration.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
  }

  function loadConfig(): OpenClawConfig {
    try {
      maybeLoadDotEnvForConfig(deps.env);
      if (!deps.fs.existsSync(configPath)) {
        if (shouldEnableShellEnvFallback(deps.env) && !shouldDeferShellEnvFallback(deps.env)) {
          loadShellEnvFallback({
            enabled: true,
            env: deps.env,
            expectedKeys: resolveShellEnvExpectedKeys(deps.env),
            logger: deps.logger,
            timeoutMs: resolveShellEnvFallbackTimeoutMs(deps.env),
          });
        }
        return {};
      }
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const parsed = deps.json5.parse(raw);
      const recovered = maybeRecoverSuspiciousConfigReadSync({
        deps,
        configPath,
        raw,
        parsed,
      });
      const effectiveRaw = recovered.raw;
      const effectiveParsed = recovered.parsed;
      const readResolution = resolveConfigForRead(
        resolveConfigIncludesForRead(effectiveParsed, configPath, deps),
        deps.env,
      );
      const resolvedConfig = readResolution.resolvedConfigRaw;
      const legacyResolution = resolveLegacyConfigForRead(resolvedConfig, effectiveParsed);
      const installMigration = migrateAndStripShippedPluginInstallConfigRecords(
        legacyResolution.effectiveConfigRaw,
        { rootConfigRaw: effectiveParsed },
      );
      const effectiveConfigRaw = installMigration.config;
      const snapshotRaw = installMigration.persistedRootRaw ?? effectiveRaw;
      const snapshotParsed = installMigration.persistedRootParsed ?? effectiveParsed;
      const hash = hashConfigRaw(snapshotRaw);
      for (const w of readResolution.envWarnings) {
        deps.logger.warn(
          `Config (${configPath}): missing env var "${w.varName}" at ${w.configPath} - feature using this value will be unavailable`,
        );
      }
      warnOnConfigMiskeys(effectiveConfigRaw, deps.logger);
      if (typeof effectiveConfigRaw !== "object" || effectiveConfigRaw === null) {
        observeLoadConfigSnapshot({
          ...createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw: snapshotRaw,
            parsed: snapshotParsed,
            sourceConfig: {},
            valid: true,
            runtimeConfig: {},
            hash,
            issues: [],
            warnings: [],
            legacyIssues: legacyResolution.sourceLegacyIssues,
          }),
        });
        return {};
      }
      const preValidationDuplicates = findDuplicateAgentDirs(effectiveConfigRaw as OpenClawConfig, {
        env: deps.env,
        homedir: deps.homedir,
      });
      if (preValidationDuplicates.length > 0) {
        throw new DuplicateAgentDirError(preValidationDuplicates);
      }
      const validated = validateConfigObjectWithPlugins(effectiveConfigRaw, {
        env: deps.env,
        pluginValidation: overrides.pluginValidation,
      });
      if (!validated.ok) {
        observeLoadConfigSnapshot({
          ...createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw: snapshotRaw,
            parsed: snapshotParsed,
            sourceConfig: coerceConfig(effectiveConfigRaw),
            valid: false,
            runtimeConfig: coerceConfig(effectiveConfigRaw),
            hash,
            issues: validated.issues,
            warnings: validated.warnings,
            legacyIssues: legacyResolution.sourceLegacyIssues,
          }),
        });
        throwInvalidConfig({
          configPath,
          issues: validated.issues,
          logger: deps.logger,
          loggedConfigPaths: loggedInvalidConfigs,
        });
      }
      if (validated.warnings.length > 0) {
        const details = validated.warnings
          .map(
            (iss) =>
              `- ${sanitizeTerminalText(iss.path || "<root>")}: ${sanitizeTerminalText(iss.message)}`,
          )
          .join("\n");
        deps.logger.warn(`Config warnings:\n${details}`);
      }
      warnIfConfigFromFuture(validated.config, deps.logger);
      const cfg = materializeRuntimeConfig(validated.config, "load");
      observeLoadConfigSnapshot({
        ...createConfigFileSnapshot({
          path: configPath,
          exists: true,
          raw: snapshotRaw,
          parsed: snapshotParsed,
          sourceConfig: coerceConfig(effectiveConfigRaw),
          valid: true,
          runtimeConfig: cfg,
          hash,
          issues: [],
          warnings: validated.warnings,
          legacyIssues: legacyResolution.sourceLegacyIssues,
        }),
      });
      return finalizeLoadedRuntimeConfig(cfg);
    } catch (err) {
      if (err instanceof DuplicateAgentDirError) {
        deps.logger.error(err.message);
        throw err;
      }
      const error = err as { code?: string };
      if (error?.code === "INVALID_CONFIG") {
        // Fail closed so invalid configs cannot silently fall back to permissive defaults.
        throw err;
      }
      deps.logger.error(`Failed to read config at ${configPath}`, err);
      throw err;
    }
  }

  /* lyc:ai 
  配置快照读取的核心内部函数。
  它执行完整的配置文件读取、解析、验证和快照创建流程。
  
  执行流程详解：
  
  阶段一：配置文件存在性检查
  - 检查配置文件是否存在
  - 如果不存在，返回空的有效快照
  
  阶段二：文件读取和基础解析
  - 读取原始文件内容
  - 使用 JSON5 解析器解析配置
  - 处理解析失败的情况
  
  阶段三：配置恢复和包含处理
  - 执行可疑配置恢复（maybeRecoverSuspiciousConfigRead）
  - 解析 $include 指令
  - 处理包含解析失败的情况
  
  阶段四：环境变量和遗留配置处理
  - 解析环境变量引用（${VAR}）
  - 转换缺失的环境变量为警告而非错误
  - 处理遗留配置键的迁移
  
  阶段五：配置验证和快照创建
  - 执行完整的配置验证（包括插件验证）
  - 创建最终的配置快照
  - 收集环境变量快照用于后续写入
  
  阶段六：异常处理
  - 处理各种 I/O 和解析异常
  - 提供用户友好的错误信息
  */
  async function readConfigFileSnapshotInternal(
    options: { persistShippedPluginInstallMigration?: boolean } = {},
  ): Promise<ReadConfigFileSnapshotInternalResult> {
    /* lyc:ai 加载 .env 文件（如果存在） */
    maybeLoadDotEnvForConfig(deps.env);
    /* lyc:ai 检查配置文件是否存在 */
    const exists = deps.fs.existsSync(configPath);
    if (!exists) {
      /* lyc:ai 配置文件不存在的情况：返回空的有效快照 */
      const hash = hashConfigRaw(null);
      const config = {};
      const legacyIssues: LegacyConfigIssue[] = [];
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          path: configPath,
          exists: false,
          raw: null,
          parsed: {},
          sourceConfig: {},
          valid: true,
          runtimeConfig: config,
          hash,
          issues: [],
          warnings: [],
          legacyIssues,
        }),
      });
    }

    let fallbackRaw: string | null = null;
    let fallbackParsed: unknown = {};
    let fallbackSourceConfig: OpenClawConfig = {};
    let fallbackHash = hashConfigRaw(null);

    try {
      /* lyc:ai ========== 阶段二：文件读取和基础解析 ========== */
      /* lyc:ai 读取配置文件的原始内容 */
      const raw = await deps.measure("config.snapshot.read.file", () =>
        deps.fs.readFileSync(configPath, "utf-8"),
      );
      /* lyc:ai 计算原始内容的哈希值，用于配置健康检查 */
      const rawHash = await deps.measure("config.snapshot.read.hash", () => hashConfigRaw(raw));
      fallbackRaw = raw;
      fallbackHash = rawHash;
      /* lyc:ai 使用 JSON5 解析器解析配置内容（支持注释、尾随逗号等扩展语法） */
      const parsedRes = await deps.measure("config.snapshot.read.parse", () =>
        parseConfigJson5(raw, deps.json5),
      );
      /* lyc:ai 处理 JSON5 解析失败的情况 */
      if (!parsedRes.ok) {
        return await finalizeReadConfigSnapshotInternalResult(deps, {
          snapshot: createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw,
            parsed: {},
            sourceConfig: {},
            valid: false,
            runtimeConfig: {},
            hash: rawHash,
            issues: [{ path: "", message: `JSON5 parse failed: ${parsedRes.error}` }],
            warnings: [],
            legacyIssues: [],
          }),
        });
      }
      fallbackParsed = parsedRes.parsed;
      fallbackSourceConfig = coerceConfig(parsedRes.parsed);

      /* lyc:ai 
      ========== 阶段三：配置恢复和包含处理 ==========
      执行可疑配置恢复和 $include 指令解析
      */
      /* lyc:ai 
      maybeRecoverSuspiciousConfigRead 函数检测并尝试恢复可疑的配置文件。
      这包括检测配置文件是否被意外截断、覆盖或损坏，并尝试从备份中恢复。
      */
      // Resolve $include directives
      const recovered = await deps.measure("config.snapshot.read.recovery-check", () =>
        maybeRecoverSuspiciousConfigRead({
          deps,
          configPath,
          raw,
          parsed: parsedRes.parsed,
        }),
      );
      const effectiveRaw = recovered.raw;
      const effectiveParsed = recovered.parsed;
      const hash = hashConfigRaw(effectiveRaw);
      fallbackRaw = effectiveRaw;
      fallbackParsed = effectiveParsed;
      fallbackSourceConfig = coerceConfig(effectiveParsed);
      fallbackHash = hash;

      /* lyc:ai 解析 $include 指令，支持配置文件模块化 */
      let resolved: unknown;
      try {
        resolved = await deps.measure("config.snapshot.read.includes", () =>
          resolveConfigIncludesForRead(effectiveParsed, configPath, deps),
        );
      } catch (err) {
        /* lyc:ai 处理 $include 指令解析失败的情况 */
        const message =
          err instanceof ConfigIncludeError
            ? err.message
            : `Include resolution failed: ${String(err)}`;
        return await finalizeReadConfigSnapshotInternalResult(deps, {
          snapshot: createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw: effectiveRaw,
            parsed: effectiveParsed,
            // Keep the recovered root file payload here when read healing kicked in.
            sourceConfig: coerceConfig(effectiveParsed),
            valid: false,
            runtimeConfig: coerceConfig(effectiveParsed),
            hash,
            issues: [{ path: "", message }],
            warnings: [],
            legacyIssues: [],
          }),
        });
      }

      /* lyc:ai 
      ========== 阶段四：环境变量和遗留配置处理 ==========
      解析环境变量引用并处理遗留配置键
      */
      /* lyc:ai 
      resolveConfigForRead 函数处理环境变量引用（${VAR} 语法）。
      它将环境变量引用替换为实际值，并收集缺失环境变量的警告。
      */
      const readResolution = await deps.measure("config.snapshot.read.env", () =>
        resolveConfigForRead(resolved, deps.env),
      );

      /* lyc:ai 
      将缺失的环境变量引用转换为警告而非致命错误。
      这允许网关在降级模式下启动，当非关键配置部分引用了未设置的环境变量时
      （例如可选的提供者 API 密钥）。
      */
      // Convert missing env var references to config warnings instead of fatal errors.
      // This allows the gateway to start in degraded mode when non-critical config
      // sections reference unset env vars (e.g. optional provider API keys).
      const envVarWarnings = readResolution.envWarnings.map((w) => ({
        path: w.configPath,
        message: `Missing env var "${w.varName}" - feature using this value will be unavailable`,
      }));

      /* lyc:ai 获取解析后的配置对象（已替换环境变量） */
      const resolvedConfigRaw = readResolution.resolvedConfigRaw;
      /* lyc:ai 处理遗留配置键的迁移和兼容性 */
      const legacyResolution = await deps.measure("config.snapshot.read.legacy", () =>
        resolveLegacyConfigForRead(resolvedConfigRaw, effectiveParsed),
      );
      const installMigration = await deps.measure(
        "config.snapshot.read.plugin-install-migration",
        () =>
          migrateAndStripShippedPluginInstallConfigRecords(legacyResolution.effectiveConfigRaw, {
            persist: options.persistShippedPluginInstallMigration !== false,
            rootConfigRaw: effectiveParsed,
          }),
      );
      const effectiveConfigRaw = installMigration.config;
      const snapshotRaw = installMigration.persistedRootRaw ?? effectiveRaw;
      const snapshotParsed = installMigration.persistedRootParsed ?? effectiveParsed;
      const snapshotHash = installMigration.persistedRootRaw
        ? hashConfigRaw(installMigration.persistedRootRaw)
        : hash;
      fallbackSourceConfig = coerceConfig(effectiveConfigRaw);
      let pluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
      const loadValidationPluginMetadataSnapshot = (config: OpenClawConfig) => {
        if (pluginMetadataSnapshot) {
          return pluginMetadataSnapshot;
        }
        const defaultAgentId = resolveDefaultAgentId(config);
        pluginMetadataSnapshot = loadPluginMetadataSnapshot({
          config,
          workspaceDir: resolveAgentWorkspaceDir(config, defaultAgentId),
          env: deps.env,
        });
        return pluginMetadataSnapshot;
      };
      /* lyc:ai 
      ========== 阶段五：配置验证和快照创建 ==========
      执行完整的配置验证，包括插件特定的验证规则
      */
      /* lyc:ai 调用 validateConfigObjectWithPlugins 执行完整的配置验证 */
      const validated = await deps.measure("config.snapshot.read.validate", () =>
        validateConfigObjectWithPlugins(effectiveConfigRaw, {
          env: deps.env,
          pluginValidation: overrides.pluginValidation,
          loadPluginMetadataSnapshot: loadValidationPluginMetadataSnapshot,
        }),
      );
      if (!validated.ok) {
        /* lyc:ai 配置验证失败：返回无效的快照 */
        return await finalizeReadConfigSnapshotInternalResult(deps, {
          snapshot: createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw: snapshotRaw,
            parsed: snapshotParsed,
            sourceConfig: coerceConfig(effectiveConfigRaw),
            valid: false,
            runtimeConfig: coerceConfig(effectiveConfigRaw),
            hash: snapshotHash,
            issues: validated.issues,
            warnings: [...validated.warnings, ...envVarWarnings],
            legacyIssues: legacyResolution.sourceLegacyIssues,
          }),
        });
      }

      /* lyc:ai 配置验证成功：创建有效的配置快照 */
      /* lyc:ai 检查配置版本是否来自未来（防止降级问题） */
      warnIfConfigFromFuture(validated.config, deps.logger);
      /* lyc:ai 将验证后的配置转换为运行时配置格式 */
      const snapshotConfig = await deps.measure("config.snapshot.read.materialize", () =>
        materializeRuntimeConfig(validated.config, "snapshot"),
      );
      /* lyc:ai 返回有效的配置快照，包含所有警告和遗留问题信息 */
      return await deps.measure("config.snapshot.read.observe", () =>
        finalizeReadConfigSnapshotInternalResult(deps, {
          snapshot: createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw: snapshotRaw,
            parsed: snapshotParsed,
            // Use resolvedConfigRaw (after $include and ${ENV} substitution but BEFORE runtime defaults)
            // for config set/unset operations (issue #6070)
            sourceConfig: coerceConfig(effectiveConfigRaw),
            valid: true,
            runtimeConfig: snapshotConfig,
            hash: snapshotHash,
            issues: [],
            warnings: [...validated.warnings, ...envVarWarnings],
            legacyIssues: legacyResolution.sourceLegacyIssues,
          }),
          envSnapshotForRestore: readResolution.envSnapshotForRestore,
          pluginMetadataSnapshot,
        }),
      );
    } catch (err) {
      /* lyc:ai 
      ========== 阶段六：异常处理 ==========
      处理各种 I/O 和解析异常，提供用户友好的错误信息
      */
      const nodeErr = err as NodeJS.ErrnoException;
      let message: string;
      if (nodeErr?.code === "EACCES") {
        // Permission denied - common in Docker/container deployments where the
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
      /* lyc:ai 返回包含错误信息的无效快照 */
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          path: configPath,
          exists: true,
          raw: fallbackRaw,
          parsed: fallbackParsed,
          sourceConfig: fallbackSourceConfig,
          valid: false,
          runtimeConfig: fallbackSourceConfig,
          hash: fallbackHash,
          issues: [{ path: "", message }],
          warnings: [],
          legacyIssues: [],
        }),
      });
    }
  }

  async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
    const result = await readConfigFileSnapshotInternal();
    return result.snapshot;
  }

  async function readConfigFileSnapshotWithPluginMetadata(): Promise<ReadConfigFileSnapshotWithPluginMetadataResult> {
    const result = await readConfigFileSnapshotInternal();
    return {
      snapshot: result.snapshot,
      ...(result.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: result.pluginMetadataSnapshot }
        : {}),
    };
  }

  async function promoteConfigSnapshotToLastKnownGood(
    snapshot: ConfigFileSnapshot,
  ): Promise<boolean> {
    return await promoteConfigSnapshotToLastKnownGoodWithDeps({
      deps,
      snapshot,
      logger: deps.logger,
    });
  }

  async function recoverConfigFromLastKnownGood(params: {
    snapshot: ConfigFileSnapshot;
    reason: string;
  }): Promise<boolean> {
    return await recoverConfigFromLastKnownGoodWithDeps({
      deps,
      snapshot: params.snapshot,
      reason: params.reason,
    });
  }

  async function recoverConfigFromJsonRootSuffix(snapshot: ConfigFileSnapshot): Promise<boolean> {
    return await recoverConfigFromJsonRootSuffixWithDeps({
      deps,
      configPath,
      snapshot,
    });
  }

  async function readConfigFileSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
    const result = await readConfigFileSnapshotInternal({
      persistShippedPluginInstallMigration: false,
    });
    return {
      snapshot: result.snapshot,
      writeOptions: {
        envSnapshotForRestore: result.envSnapshotForRestore,
        expectedConfigPath: configPath,
        unsetPaths: resolveManagedUnsetPathsForWrite(undefined),
      },
    };
  }

  async function readBestEffortConfig(): Promise<OpenClawConfig> {
    const result = await readConfigFileSnapshotInternal();
    if (!result.snapshot.valid) {
      return result.snapshot.config;
    }
    return finalizeLoadedRuntimeConfig(
      materializeRuntimeConfig(result.snapshot.sourceConfig, "load"),
    );
  }

  async function readSourceConfigBestEffort(): Promise<OpenClawConfig> {
    maybeLoadDotEnvForConfig(deps.env);
    const exists = deps.fs.existsSync(configPath);
    if (!exists) {
      return {};
    }

    try {
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const parsedRes = parseConfigJson5(raw, deps.json5);
      if (!parsedRes.ok) {
        return {};
      }

      const recovered = await maybeRecoverSuspiciousConfigRead({
        deps,
        configPath,
        raw,
        parsed: parsedRes.parsed,
      });

      let resolved: unknown;
      try {
        resolved = resolveConfigIncludesForRead(recovered.parsed, configPath, deps);
      } catch {
        return coerceConfig(recovered.parsed);
      }

      const readResolution = resolveConfigForRead(resolved, deps.env);
      const legacyResolution = resolveLegacyConfigForRead(
        readResolution.resolvedConfigRaw,
        recovered.parsed,
      );
      return coerceConfig(
        stripShippedPluginInstallConfigRecords(legacyResolution.effectiveConfigRaw),
      );
    } catch {
      return {};
    }
  }

  async function writeConfigFile(
    cfg: OpenClawConfig,
    options: ConfigWriteOptions = {},
  ): Promise<{ persistedHash: string; persistedConfig: OpenClawConfig }> {
    clearConfigCache();
    const unsetPaths = resolveManagedUnsetPathsForWrite(options.unsetPaths);
    let persistCandidate: unknown = cfg;
    const snapshot =
      options.baseSnapshot ??
      (
        await readConfigFileSnapshotInternal({
          persistShippedPluginInstallMigration: false,
        })
      ).snapshot;
    let envRefMap: Map<string, string> | null = null;
    let changedPaths: Set<string> | null = null;
    if (snapshot.valid && snapshot.exists) {
      persistCandidate = resolvePersistCandidateForWrite({
        runtimeConfig: snapshot.config,
        sourceConfig: snapshot.resolved,
        nextConfig: cfg,
        rootAuthoredConfig: snapshot.parsed,
      });
      try {
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
        collectEnvRefPaths(resolvedIncludes, "", collected);
        if (collected.size > 0) {
          envRefMap = collected;
          changedPaths = new Set<string>();
          collectChangedPaths(snapshot.config, cfg, "", changedPaths);
        }
      } catch {
        envRefMap = null;
      }
    }

    persistCandidate = applyUnsetPathsForWrite(persistCandidate as OpenClawConfig, unsetPaths);

    const validated = validateConfigObjectRawWithPlugins(persistCandidate, { env: deps.env });
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
    // resolved values match the incoming config - so we don't overwrite
    // "${ANTHROPIC_API_KEY}" with "sk-ant-..." when the caller didn't change it.
    //
    // We use only the root file's parsed content (no $include resolution) to avoid
    // pulling values from included files into the root config on write-back.
    // Use persistCandidate (the merge-patched value before validation) rather than
    // validated.config, because plugin/channel AJV validation may inject schema
    // defaults (e.g., enrichGroupParticipantsFromContacts) that should not be
    // persisted to disk (issue #56772).
    // Apply legacy web-search normalization so that migration results are still
    // persisted even though we bypass validated.config.
    let cfgToWrite = persistCandidate as OpenClawConfig;
    try {
      if (deps.fs.existsSync(configPath)) {
        const currentRaw = await deps.fs.promises.readFile(configPath, "utf-8");
        const parsedRes = parseConfigJson5(currentRaw, deps.json5);
        if (parsedRes.ok) {
          // Use env snapshot from when config was loaded (if available) to avoid
          // TOCTOU issues where env changes between load and write. Falls back to
          // live env if no snapshot exists (e.g., first write before any load).
          const envForRestore = options.envSnapshotForRestore ?? deps.env;
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
    await tightenStateDirPermissionsIfNeeded({
      configPath,
      env: deps.env,
      homedir: deps.homedir,
      fsModule: deps.fs,
    });
    const outputConfigBase =
      envRefMap && changedPaths
        ? (restoreEnvRefsFromMap(cfgToWrite, "", envRefMap, changedPaths) as OpenClawConfig)
        : cfgToWrite;
    const outputConfig = applyUnsetPathsForWrite(outputConfigBase, unsetPaths);
    // Do NOT apply runtime defaults when writing - user config should only contain
    // explicitly set values. Runtime defaults are applied when loading (issue #6070).
    const stampedOutputConfig = stampConfigVersion(outputConfig);
    const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
    const nextHash = hashConfigRaw(json);
    const previousHash = resolveConfigSnapshotHash(snapshot);
    const changedPathCount = changedPaths?.size;
    const previousBytes =
      typeof snapshot.raw === "string" ? Buffer.byteLength(snapshot.raw, "utf-8") : null;
    const nextBytes = Buffer.byteLength(json, "utf-8");
    const previousStat = snapshot.exists
      ? await deps.fs.promises.stat(configPath).catch(() => null)
      : null;
    const hasMetaBefore = hasConfigMeta(snapshot.parsed);
    const hasMetaAfter = hasConfigMeta(stampedOutputConfig);
    const gatewayModeBefore = resolveGatewayMode(snapshot.resolved);
    const gatewayModeAfter = resolveGatewayMode(stampedOutputConfig);
    const suspiciousReasons = resolveConfigWriteSuspiciousReasons({
      existsBefore: snapshot.exists,
      previousBytes,
      nextBytes,
      hasMetaBefore,
      gatewayModeBefore,
      gatewayModeAfter,
    });
    const logConfigOverwrite = () => {
      if (!snapshot.exists) {
        return;
      }
      if (options.skipOutputLogs) {
        return;
      }
      const isVitest = deps.env.VITEST === "true";
      const shouldLogInVitest = deps.env.OPENCLAW_TEST_CONFIG_OVERWRITE_LOG === "1";
      if (isVitest && !shouldLogInVitest) {
        return;
      }
      deps.logger.warn(
        formatConfigOverwriteLogMessage({
          configPath,
          previousHash: previousHash ?? null,
          nextHash,
          changedPathCount,
        }),
      );
    };
    const logConfigWriteAnomalies = () => {
      if (suspiciousReasons.length === 0) {
        return;
      }
      if (options.skipOutputLogs) {
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
    const previousMetadata = resolveConfigStatMetadata(previousStat);
    const auditRecordBase = createConfigWriteAuditRecordBase({
      configPath,
      env: deps.env,
      existsBefore: snapshot.exists,
      previousHash: previousHash ?? null,
      nextHash,
      previousBytes,
      nextBytes,
      previousMetadata,
      changedPathCount,
      hasMetaBefore,
      hasMetaAfter,
      gatewayModeBefore,
      gatewayModeAfter,
      suspicious: suspiciousReasons,
    });
    const appendWriteAudit = async (
      result: ConfigWriteAuditResult,
      err?: unknown,
      nextStat?: fs.Stats | null,
    ) => {
      await appendConfigAuditRecord({
        fs: deps.fs,
        env: deps.env,
        homedir: deps.homedir,
        record: finalizeConfigWriteAuditRecord({
          base: auditRecordBase,
          result,
          err,
          nextMetadata: resolveConfigStatMetadata(nextStat ?? null),
        }),
      });
    };
    const blockingReasons = resolveConfigWriteBlockingReasons(suspiciousReasons);
    if (blockingReasons.length > 0 && options.allowDestructiveWrite !== true) {
      const rejectedPath = `${configPath}.rejected.${formatConfigArtifactTimestamp(new Date().toISOString())}`;
      await deps.fs.promises
        .writeFile(rejectedPath, json, {
          encoding: "utf-8",
          mode: 0o600,
          flag: "wx",
        })
        .catch(() => {});
      const message = `Config write rejected: ${configPath} (${blockingReasons.join(", ")}). Rejected payload saved to ${rejectedPath}.`;
      const err = Object.assign(new Error(message), {
        code: "CONFIG_WRITE_REJECTED",
        rejectedPath,
        reasons: blockingReasons,
      });
      deps.logger.warn(message);
      await appendWriteAudit("rejected", err);
      throw err;
    }

    const tmp = path.join(
      dir,
      `${path.basename(configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );

    const pluginInstallConfigMigration =
      ensureShippedPluginInstallConfigRecordsMigratedForWrite(snapshot);
    let configCommitted = false;
    try {
      await deps.fs.promises.writeFile(tmp, json, {
        encoding: "utf-8",
        mode: 0o600,
      });

      if (deps.fs.existsSync(configPath)) {
        await maintainConfigBackups(configPath, deps.fs.promises);
      }

      try {
        await deps.fs.promises.rename(tmp, configPath);
      } catch (err) {
        const code = (err as { code?: string }).code;
        // Windows doesn't reliably support atomic replace via rename when dest exists.
        if (code === "EPERM" || code === "EEXIST") {
          await deps.fs.promises.copyFile(tmp, configPath);
          await deps.fs.promises.chmod(configPath, 0o600).catch(() => {
            // best-effort
          });
          await deps.fs.promises.unlink(tmp).catch(() => {
            // best-effort
          });
          configCommitted = true;
          logConfigOverwrite();
          logConfigWriteAnomalies();
          await appendWriteAudit(
            "copy-fallback",
            undefined,
            await deps.fs.promises.stat(configPath).catch(() => null),
          );
          return { persistedHash: nextHash, persistedConfig: stampedOutputConfig };
        }
        await deps.fs.promises.unlink(tmp).catch(() => {
          // best-effort
        });
        throw err;
      }
      configCommitted = true;
      logConfigOverwrite();
      logConfigWriteAnomalies();
      await appendWriteAudit(
        "rename",
        undefined,
        await deps.fs.promises.stat(configPath).catch(() => null),
      );
      return { persistedHash: nextHash, persistedConfig: stampedOutputConfig };
    } catch (err) {
      if (!configCommitted) {
        rollbackShippedPluginInstallConfigWriteMigration(pluginInstallConfigMigration);
      }
      await appendWriteAudit("failed", err);
      throw err;
    }
  }

  return {
    configPath,
    loadConfig,
    readBestEffortConfig,
    readSourceConfigBestEffort,
    readConfigFileSnapshot,
    readConfigFileSnapshotWithPluginMetadata,
    readConfigFileSnapshotForWrite,
    promoteConfigSnapshotToLastKnownGood,
    recoverConfigFromLastKnownGood,
    recoverConfigFromJsonRootSuffix,
    writeConfigFile,
  };
}

// NOTE: These wrappers intentionally do *not* cache the resolved config path at
// module scope. `OPENCLAW_CONFIG_PATH` (and friends) are expected to work even
// when set after the module has been imported (tests, one-off scripts, etc.).
const AUTO_OWNER_DISPLAY_SECRET_BY_PATH = new Map<string, string>();
const AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT = new Set<string>();
const AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED = new Set<string>();
export function clearConfigCache(): void {
  // Compat shim: runtime snapshot is the only in-process cache now.
}

export function registerConfigWriteListener(
  listener: (event: ConfigWriteNotification) => void,
): () => void {
  return registerRuntimeConfigWriteListener(listener);
}

function isCompatibleTopLevelRuntimeProjectionShape(params: {
  runtimeSnapshot: OpenClawConfig;
  candidate: OpenClawConfig;
}): boolean {
  const runtime = params.runtimeSnapshot as Record<string, unknown>;
  const candidate = params.candidate as Record<string, unknown>;
  for (const key of Object.keys(runtime)) {
    if (!Object.hasOwn(candidate, key)) {
      return false;
    }
    const runtimeValue = runtime[key];
    const candidateValue = candidate[key];
    const runtimeType = Array.isArray(runtimeValue)
      ? "array"
      : runtimeValue === null
        ? "null"
        : typeof runtimeValue;
    const candidateType = Array.isArray(candidateValue)
      ? "array"
      : candidateValue === null
        ? "null"
        : typeof candidateValue;
    if (runtimeType !== candidateType) {
      return false;
    }
  }
  return true;
}

export function projectConfigOntoRuntimeSourceSnapshot(config: OpenClawConfig): OpenClawConfig {
  const runtimeConfigSnapshot = getRuntimeConfigSnapshotState();
  const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshotState();
  if (!runtimeConfigSnapshot || !runtimeConfigSourceSnapshot) {
    return config;
  }
  if (config === runtimeConfigSnapshot) {
    return runtimeConfigSourceSnapshot;
  }
  // This projection expects callers to pass config objects derived from the
  // active runtime snapshot (for example shallow/deep clones with targeted edits).
  // For structurally unrelated configs, skip projection to avoid accidental
  // merge-patch deletions or reintroducing resolved values into source refs.
  if (
    !isCompatibleTopLevelRuntimeProjectionShape({
      runtimeSnapshot: runtimeConfigSnapshot,
      candidate: config,
    })
  ) {
    return config;
  }
  const projectedSource = coerceConfig(
    projectSourceOntoRuntimeShape(runtimeConfigSourceSnapshot, runtimeConfigSnapshot),
  );
  const runtimePatch = createMergePatch(runtimeConfigSnapshot, config);
  return coerceConfig(applyMergePatch(projectedSource, runtimePatch));
}

export function loadConfig(): OpenClawConfig {
  // First successful load becomes the process snapshot. Long-lived runtimes
  // should swap this snapshot via explicit reload/watcher paths instead of
  // reparsing openclaw.json on hot code paths.
  return loadPinnedRuntimeConfig(() => createConfigIO().loadConfig());
}

export function getRuntimeConfig(): OpenClawConfig {
  return loadConfig();
}

export async function readBestEffortConfig(): Promise<OpenClawConfig> {
  return await createConfigIO().readBestEffortConfig();
}

export async function readSourceConfigBestEffort(): Promise<OpenClawConfig> {
  return await createConfigIO().readSourceConfigBestEffort();
}

/* lyc:ai 
配置 I/O 模块的核心导出函数。
它被 doctor-config-preflight.ts 中的 runDoctorConfigPreflight 函数调用，
用于读取 OpenClaw 配置文件的完整快照。

功能特点：
- 安全读取：处理文件不存在、权限错误等各种异常情况
- 配置解析：支持 JSON5 格式、环境变量引用、$include 指令
- 验证和警告：执行完整的配置验证并收集警告信息
- 快照创建：返回包含存在性、有效性、问题列表等信息的完整快照
- 最佳努力：即使配置无效也返回部分有效的配置对象

调用链：
doctor-config-preflight.ts -> readConfigFileSnapshot() -> createConfigIO().readConfigFileSnapshot()
*/
export async function readConfigFileSnapshot(options?: {
  measure?: ConfigSnapshotReadMeasure;
}): Promise<ConfigFileSnapshot> {
  return await createConfigIO(
    options?.measure ? { measure: options.measure } : {},
  ).readConfigFileSnapshot();
}

export async function readConfigFileSnapshotWithPluginMetadata(options?: {
  measure?: ConfigSnapshotReadMeasure;
}): Promise<ReadConfigFileSnapshotWithPluginMetadataResult> {
  return await createConfigIO(
    options?.measure ? { measure: options.measure } : {},
  ).readConfigFileSnapshotWithPluginMetadata();
}

export async function promoteConfigSnapshotToLastKnownGood(
  snapshot: ConfigFileSnapshot,
): Promise<boolean> {
  return await createConfigIO().promoteConfigSnapshotToLastKnownGood(snapshot);
}

export async function recoverConfigFromLastKnownGood(params: {
  snapshot: ConfigFileSnapshot;
  reason: string;
}): Promise<boolean> {
  return await createConfigIO().recoverConfigFromLastKnownGood(params);
}

export async function recoverConfigFromJsonRootSuffix(
  snapshot: ConfigFileSnapshot,
): Promise<boolean> {
  return await createConfigIO().recoverConfigFromJsonRootSuffix(snapshot);
}

export async function readSourceConfigSnapshot(): Promise<ConfigFileSnapshot> {
  return await readConfigFileSnapshot();
}

export async function readConfigFileSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
  return await createConfigIO().readConfigFileSnapshotForWrite();
}

export async function readSourceConfigSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
  return await readConfigFileSnapshotForWrite();
}

export async function writeConfigFile(
  cfg: OpenClawConfig,
  options: ConfigWriteOptions = {},
): Promise<void> {
  const io = createConfigIO();
  let nextCfg = cfg;
  const runtimeConfigSnapshot = getRuntimeConfigSnapshotState();
  const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshotState();
  const hadRuntimeSnapshot = Boolean(runtimeConfigSnapshot);
  const hadBothSnapshots = Boolean(runtimeConfigSnapshot && runtimeConfigSourceSnapshot);
  if (hadBothSnapshots) {
    const runtimePatch = createMergePatch(runtimeConfigSnapshot!, cfg);
    nextCfg = coerceConfig(applyMergePatch(runtimeConfigSourceSnapshot!, runtimePatch));
  }
  const writeResult = await io.writeConfigFile(nextCfg, {
    envSnapshotForRestore: resolveWriteEnvSnapshotForPath({
      actualConfigPath: io.configPath,
      expectedConfigPath: options.expectedConfigPath,
      envSnapshotForRestore: options.envSnapshotForRestore,
    }),
    unsetPaths: resolveManagedUnsetPathsForWrite(options.unsetPaths),
    allowDestructiveWrite: options.allowDestructiveWrite,
    skipRuntimeSnapshotRefresh: options.skipRuntimeSnapshotRefresh,
    skipOutputLogs: options.skipOutputLogs,
  });
  if (
    options.skipRuntimeSnapshotRefresh &&
    !hadRuntimeSnapshot &&
    !getRuntimeConfigSnapshotRefreshHandlerState()
  ) {
    return;
  }
  const notifyCommittedWrite = () => {
    const currentRuntimeConfig = getRuntimeConfigSnapshotState();
    if (!currentRuntimeConfig) {
      return;
    }
    notifyRuntimeConfigWriteListeners(
      createRuntimeConfigWriteNotification({
        configPath: io.configPath,
        sourceConfig: nextCfg,
        runtimeConfig: currentRuntimeConfig,
        persistedHash: writeResult.persistedHash,
        afterWrite: options.afterWrite,
      }),
    );
  };
  // Keep the last-known-good runtime snapshot active until the specialized refresh path
  // succeeds, so concurrent readers do not observe unresolved SecretRefs mid-refresh.
  await finalizeRuntimeSnapshotWrite({
    nextSourceConfig: nextCfg,
    hadRuntimeSnapshot,
    hadBothSnapshots,
    loadFreshConfig: () => io.loadConfig(),
    notifyCommittedWrite,
    formatRefreshError: (error) => formatErrorMessage(error),
    createRefreshError: (detail, cause) =>
      new ConfigRuntimeRefreshError(
        `Config was written to ${io.configPath}, but runtime snapshot refresh failed: ${detail}`,
        { cause },
      ),
  });
}
