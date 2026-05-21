import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { fileSignatureMatches } from "./installed-plugin-index-hash.js";
import { hasOptionalMissingPluginManifestFile } from "./installed-plugin-index-manifest.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import {
  inspectPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  refreshPersistedInstalledPluginIndex,
  type InstalledPluginIndexStoreInspection,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store.js";
import {
  getInstalledPluginRecord,
  extractPluginInstallRecordsFromInstalledPluginIndex,
  isInstalledPluginEnabled,
  listInstalledPluginRecords,
  loadInstalledPluginIndex,
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";

export type PluginRegistrySnapshot = InstalledPluginIndex;
export type PluginRegistryRecord = InstalledPluginIndexRecord;
export type PluginRegistryInspection = InstalledPluginIndexStoreInspection;
export type PluginRegistrySnapshotSource = "provided" | "persisted" | "derived";
export type PluginRegistrySnapshotDiagnosticCode =
  | "persisted-registry-disabled"
  | "persisted-registry-missing"
  | "persisted-registry-stale-policy"
  | "persisted-registry-stale-source";

export type PluginRegistrySnapshotDiagnostic = {
  level: "info" | "warn";
  code: PluginRegistrySnapshotDiagnosticCode;
  message: string;
};

export type PluginRegistrySnapshotResult = {
  snapshot: PluginRegistrySnapshot;
  source: PluginRegistrySnapshotSource;
  diagnostics: readonly PluginRegistrySnapshotDiagnostic[];
};

export const DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV = "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY";

function formatDeprecatedPersistedRegistryDisableWarning(): string {
  return `${DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV} is a deprecated break-glass compatibility switch; use \`openclaw plugins registry --refresh\` or \`openclaw doctor --fix\` to repair registry state.`;
}

export type LoadPluginRegistryParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    index?: PluginRegistrySnapshot;
    preferPersisted?: boolean;
  };

export type GetPluginRecordParams = LoadPluginRegistryParams & {
  pluginId: string;
};

function hasEnvFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  return Boolean(value && value !== "0" && value !== "false" && value !== "no");
}

function canReuseCurrentPluginMetadataSnapshot(params: LoadPluginRegistryParams): boolean {
  return (
    params.preferPersisted !== false &&
    params.stateDir === undefined &&
    params.filePath === undefined &&
    params.pluginIndexFilePath === undefined &&
    params.installRecords === undefined &&
    params.candidates === undefined &&
    params.diagnostics === undefined &&
    params.now === undefined
  );
}

function loadCurrentPluginRegistrySnapshotResult(
  params: LoadPluginRegistryParams,
): PluginRegistrySnapshotResult | undefined {
  if (!canReuseCurrentPluginMetadataSnapshot(params)) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const current = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.workspaceDir === undefined ? { allowWorkspaceScopedSnapshot: true } : {}),
  });
  if (!current || current.registryDiagnostics.length > 0) {
    return undefined;
  }
  return {
    snapshot: current.index,
    source: "provided",
    diagnostics: current.registryDiagnostics,
  };
}

function hasMissingPersistedPluginSource(index: InstalledPluginIndex): boolean {
  return index.plugins.some((plugin) => {
    if (!plugin.enabled) {
      return false;
    }
    return (
      !fs.existsSync(plugin.rootDir) ||
      (!hasOptionalMissingPluginManifestFile(plugin) && !fs.existsSync(plugin.manifestPath)) ||
      (plugin.source ? !fs.existsSync(plugin.source) : false) ||
      (plugin.setupSource ? !fs.existsSync(plugin.setupSource) : false)
    );
  });
}

function resolveComparablePath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isRelativePathInsideOrEqual(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  const relative = path.relative(
    resolveComparablePath(parentPath),
    resolveComparablePath(childPath),
  );
  return isRelativePathInsideOrEqual(relative);
}

function hasMismatchedPersistedBundledPluginRoot(
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv,
): boolean {
  const bundledPluginsDir = resolveBundledPluginsDir(env);
  if (!bundledPluginsDir) {
    return false;
  }
  return index.plugins.some(
    (plugin) =>
      plugin.origin === "bundled" && !isPathInsideOrEqual(plugin.rootDir, bundledPluginsDir),
  );
}

// lyc:aic v2026.5 新增大量 staleness 检测 helper：
//   hashExistingFile / resolveRecordPackageJsonPath / hasStalePersistedPluginDiagnostics /
//   hasStalePersistedPluginMetadata / loadSnapshotInstallRecords /
//   hasRecoveredInstallRecordsMissingFromPersistedIndex
// 用于判断 ~/.openclaw/plugins/installs.json 里的快照是否与磁盘真实状态一致。
// 原来的"派生快照缓存"机制 (resolveDerivedSnapshotCacheKey + derivedSnapshotCache) 整体被删除——
// 你对它的中文注释已存档到 .ai_claude/orphaned-comments.md。
function hashExistingFile(filePath: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function resolveRecordPackageJsonPath(plugin: InstalledPluginIndexRecord): string | null {
  const packageJsonPath = plugin.packageJson?.path;
  if (!packageJsonPath) {
    return null;
  }
  const rootDir = plugin.rootDir || path.dirname(plugin.manifestPath);
  const resolved = path.resolve(rootDir, packageJsonPath);
  const relative = path.relative(rootDir, resolved);
  if (!isRelativePathInsideOrEqual(relative)) {
    return null;
  }
  const realRelative = path.relative(
    resolveComparablePath(rootDir),
    resolveComparablePath(resolved),
  );
  return isRelativePathInsideOrEqual(realRelative) ? resolved : null;
}

function hasStalePersistedPluginDiagnostics(index: InstalledPluginIndex): boolean {
  return index.diagnostics.some((diag) => {
    const source = diag.source;
    return (
      typeof diag.pluginId === "string" &&
      diag.pluginId.trim().length > 0 &&
      typeof source === "string" &&
      path.isAbsolute(source) &&
      !fs.existsSync(source)
    );
  });
}

function hasStalePersistedPluginMetadata(index: InstalledPluginIndex): boolean {
  return index.plugins.some((plugin) => {
    if (!hasOptionalMissingPluginManifestFile(plugin)) {
      const manifestSignatureMatches = fileSignatureMatches(
        plugin.manifestPath,
        plugin.manifestFile,
      );
      if (manifestSignatureMatches !== true) {
        const manifestHash = hashExistingFile(plugin.manifestPath);
        if (manifestHash && manifestHash !== plugin.manifestHash) {
          return true;
        }
      }
    }
    const packageJsonPath = resolveRecordPackageJsonPath(plugin);
    if (!plugin.packageJson?.hash) {
      return false;
    }
    if (!packageJsonPath) {
      return true;
    }
    const packageJsonSignatureMatches = fileSignatureMatches(
      packageJsonPath,
      plugin.packageJson.fileSignature,
    );
    if (packageJsonSignatureMatches === true && plugin.origin === "bundled") {
      return false;
    }
    if (packageJsonSignatureMatches === false) {
      return hashExistingFile(packageJsonPath) !== plugin.packageJson.hash;
    }
    // Fast same-size rewrites can preserve observable stat fields on some filesystems.
    const packageJsonHash = hashExistingFile(packageJsonPath);
    return packageJsonHash !== plugin.packageJson.hash;
  });
}

function loadSnapshotInstallRecords(params: LoadPluginRegistryParams, env: NodeJS.ProcessEnv) {
  return loadInstalledPluginIndexInstallRecordsSync({
    env,
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    ...(params.filePath
      ? { filePath: params.filePath }
      : params.pluginIndexFilePath
        ? { filePath: params.pluginIndexFilePath }
        : {}),
  });
}

function hasRecoveredInstallRecordsMissingFromPersistedIndex(
  index: InstalledPluginIndex,
  installRecords: ReturnType<typeof loadInstalledPluginIndexInstallRecordsSync>,
  env: NodeJS.ProcessEnv,
): boolean {
  const persistedRecords = extractPluginInstallRecordsFromInstalledPluginIndex(index);
  const persistedPluginIds = new Set(index.plugins.map((plugin) => plugin.pluginId));
  return Object.entries(installRecords).some(([pluginId, record]) => {
    if (persistedRecords[pluginId] && persistedPluginIds.has(pluginId)) {
      return false;
    }
    const installPaths = [record.installPath, record.sourcePath].filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    );
    if (installPaths.length === 0) {
      return true;
    }
    return installPaths.some((installPath) => fs.existsSync(resolveUserPath(installPath, env)));
  });
}

// lyc: 加载带有元数据的插件注册表快照
export function loadPluginRegistrySnapshotWithMetadata(
  params: LoadPluginRegistryParams = {},
): PluginRegistrySnapshotResult {
  if (params.index) {
    return {
      snapshot: params.index,
      source: "provided",
      diagnostics: [],
    };
  }
  const current = loadCurrentPluginRegistrySnapshotResult(params);
  if (current) {
    return current;
  }

  const env = params.env ?? process.env;
  // lyc: 初始化诊断数组
  const diagnostics: PluginRegistrySnapshotDiagnostic[] = [];
  // lyc: 调用者 是否禁用 持久化插件注册表: 是否由调用者禁用 = 偏好使用持久化 插件注册表=false
  const disabledByCaller = params.preferPersisted === false;
  // lyc: 环境变量 是否禁用 持久化插件注册表: 是否由环境变量禁用 = 禁用持久化 插件注册表(OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY)=true
  const disabledByEnv = hasEnvFlag(env, DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV);
  // lyc: 持久化读取功能已启用 = 调用者 和 环境变量 都没有禁用 持久化插件注册表 时为已启用
  const persistedReadsEnabled = !disabledByCaller && !disabledByEnv;
  // lyc: 持久化安装记录读取功能已启用 = 环境变量 没有禁用 持久化插件注册表 时为已启用
  const persistedInstallRecordReadsEnabled = !disabledByEnv;
  // lyc:aic v2026.5：原本这里用 resolveDerivedSnapshotCacheKey + derivedSnapshotCache 查内存缓存——
  //                  整个机制被删除（注释存档在 .ai_claude/orphaned-comments.md）。
  let persistedIndex: InstalledPluginIndex | null = null;
  // lyc: 如果 持久化安装记录读取功能已启用(persistedInstallRecordReadsEnabled) 即: 环境变量 env.DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV 没有禁用 持久化插件注册表
  if (persistedInstallRecordReadsEnabled) {
    // lyc: 解析已安装插件索引, 即解析value(~/.openclaw/plugins/installs.json)为 InstalledPluginIndex 类型的实例, 并特别处理 installRecords 属性
    persistedIndex = readPersistedInstalledPluginIndexSync(params);
    // lyc: 持久化读取功能已启用(调用者和环境变量都没有禁用持久化插件注册表时为true) & 解析已安装插件索引(persistedIndex) 成功
    // lyc: 对 解析已安装插件索引(persistedIndex) 进行策略、源、绑定件树的校验, 效验成功返回带有元数据的插件注册表快照(其中包含persistedIndex), 否则继续执行
    if (persistedReadsEnabled && persistedIndex) {
      if (
        params.config &&
        persistedIndex.policyHash !== resolveInstalledPluginIndexPolicyHash(params.config)
      ) {
        diagnostics.push({
          level: "warn",
          // lyc: 持久化注册表过期策略
          code: "persisted-registry-stale-policy",
          // lyc: 持久化插件注册表策略与当前配置不匹配；正在使用派生插件索引。请运行`openclaw plugins registry --refresh`以更新持久化注册表
          message:
            "Persisted plugin registry policy does not match current config; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasMissingPersistedPluginSource(persistedIndex)) {
        diagnostics.push({
          level: "warn",
          // lyc: 持久化注册表源已过时
          code: "persisted-registry-stale-source",
          // lyc: 持久化插件注册表指向缺失的插件文件；正在使用派生插件索引。运行`openclaw plugins registry --refresh`以更新持久化注册表
          message:
            "Persisted plugin registry points at missing plugin files; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasMismatchedPersistedBundledPluginRoot(persistedIndex, env)) {
        diagnostics.push({
          level: "warn",
          // lyc: 持久化注册表源已过时
          code: "persisted-registry-stale-source",
          // lyc: 持久化插件注册表指向另一个已绑定的插件树；正在使用派生插件索引。请运行“openclaw plugins registry --refresh”来更新持久化注册表。
          message:
            "Persisted plugin registry points at a different bundled plugin tree; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasStalePersistedPluginDiagnostics(persistedIndex)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry contains diagnostics referencing missing paths; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasStalePersistedPluginMetadata(persistedIndex)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry metadata no longer matches plugin manifest or package files; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (
        hasRecoveredInstallRecordsMissingFromPersistedIndex(
          persistedIndex,
          loadSnapshotInstallRecords(params, env),
          env,
        )
      ) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry is missing recoverable managed npm plugins; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else {
        // lyc: 如果 已安装插件索引 策略、源、绑定件树都匹配, 则返回 已安装插件索引
        return {
          snapshot: persistedIndex,
          source: "persisted",
          diagnostics,
        };
      }
    } else if (persistedReadsEnabled) {
      // lyc: 持久化读取功能未启用(调用者或环境变量有一个或全部禁用了持久化插件注册表时为false) 或 解析已安装插件索引失败
      diagnostics.push({
        level: "info",
        // lyc: 持久化注册表缺失
        code: "persisted-registry-missing",
        // lyc: 持久化插件注册表缺失或无效；正在使用派生插件索引。
        message: "Persisted plugin registry is missing or invalid; using derived plugin index.",
      });
    }
  } else {
    // lyc: 持久化安装记录读取功能未启用(persistedInstallRecordReadsEnabled) 即: 环境变量 env.DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV 禁用了 持久化插件注册表
    diagnostics.push({
      level: "warn",
      // lyc: 持久化注册表已禁用
      code: "persisted-registry-disabled",
      /* lyc: 
      */
      message: disabledByEnv
        ? `${formatDeprecatedPersistedRegistryDisableWarning()} Using legacy derived plugin index.`
        : "Persisted plugin registry reads are disabled by the caller; using derived plugin index.",
    });
  }

  return {
    snapshot: loadInstalledPluginIndex({
      ...params,
      // lyc:aic v2026.5：installRecords 处理逻辑反转——
      //   原本：总是显式传 installRecords（caller 优先，否则从 persistedIndex 抽）
      //   现在：如果"持久化安装记录读取功能已启用"就什么都不传，让 loadInstalledPluginIndex 自己处理；
      //         否则才显式传 caller 的 installRecords（或空对象兜底）
      // lyc: 如果入参提供 installRecords 属性, 则优先使用入参提供的安装记录
      ...(persistedInstallRecordReadsEnabled
        ? {}
        : { installRecords: params.installRecords ?? {} }),
    }),
    source: "derived",
    diagnostics,
  };
}

// lyc: 解析插件注册表(PluginRegistry) 的快照(PluginRegistrySnapshot) 并返回解析后的快照; 快照为 InstalledPluginIndex 类型的实例
// lyc: PluginRegistrySnapshot = InstalledPluginIndex 类型的实例
function resolveSnapshot(params: LoadPluginRegistryParams = {}): PluginRegistrySnapshot {
  return loadPluginRegistrySnapshotWithMetadata(params).snapshot;
}

// lyc: 加载插件注册表(PluginRegistry) 的快照(PluginRegistrySnapshot) 快照为 InstalledPluginIndex 类型的实例
export function loadPluginRegistrySnapshot(
  params: LoadPluginRegistryParams = {},
): PluginRegistrySnapshot {
  return resolveSnapshot(params);
}

export function listPluginRecords(
  params: LoadPluginRegistryParams = {},
): readonly PluginRegistryRecord[] {
  return listInstalledPluginRecords(resolveSnapshot(params));
}

export function getPluginRecord(params: GetPluginRecordParams): PluginRegistryRecord | undefined {
  return getInstalledPluginRecord(resolveSnapshot(params), params.pluginId);
}

export function isPluginEnabled(params: GetPluginRecordParams): boolean {
  return isInstalledPluginEnabled(resolveSnapshot(params), params.pluginId, params.config);
}

export function inspectPluginRegistry(
  params: LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions = {},
): Promise<PluginRegistryInspection> {
  return inspectPersistedInstalledPluginIndex(params);
}

export function refreshPluginRegistry(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): Promise<PluginRegistrySnapshot> {
  return refreshPersistedInstalledPluginIndex(params);
}
