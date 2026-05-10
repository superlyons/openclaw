import fs from "node:fs";
import path from "node:path";
import { resolveCompatibilityHostVersion } from "../version.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  inspectPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
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
import { resolvePluginCacheInputs } from "./roots.js";

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

const DERIVED_SNAPSHOT_CACHE_MS = 1000;
const derivedSnapshotCache = new Map<
  string,
  { expiresAt: number; result: PluginRegistrySnapshotResult }
>();

export function clearPluginRegistrySnapshotCache(): void {
  derivedSnapshotCache.clear();
}

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

function hasMissingPersistedPluginSource(index: InstalledPluginIndex): boolean {
  return index.plugins.some((plugin) => {
    if (!plugin.enabled) {
      return false;
    }
    return (
      !fs.existsSync(plugin.rootDir) ||
      !fs.existsSync(plugin.manifestPath) ||
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

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  const relative = path.relative(
    resolveComparablePath(parentPath),
    resolveComparablePath(childPath),
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

/* lyc: 解析派生快照缓存键, 组成成分:
持久化插件注册表存储路径,插件源根目录,加载路径,openclaw版本,环境变量(禁用持久化插件注册表,禁用捆绑插件,VITEST)组成
入参params只有提供: cache=非false值, preferPersisted=非false值, env, index 属性时才会执行逻辑, 否则返回null
*/
function resolveDerivedSnapshotCacheKey(
  params: LoadPluginRegistryParams,
  env: NodeJS.ProcessEnv,
): string | null {
  if (
    params.cache === false ||
    params.preferPersisted === false ||
    params.config ||
    params.workspaceDir ||
    params.stateDir ||
    params.filePath ||
    params.pluginIndexFilePath ||
    params.installRecords ||
    params.candidates ||
    params.diagnostics ||
    params.now
  ) {
    return null;
  }
  // lyc: 解析插件缓存输入: { roots插件源根目录: { stock: packageRoot/.../extensions, global: openclaw的配置目录/extensions, workspace: openclaw的配置目录/extensions } , loadPaths加载路径: [...]}
  const { roots, loadPaths } = resolvePluginCacheInputs({ env });
  return JSON.stringify({
    // lyc: 持久化插件注册表存储路径, 默认为: ~/.openclaw/plugins/installs.json
    persistedStore: resolveInstalledPluginIndexStorePath({ env }),
    // lyc: 插件源根目录: { stock:"packageRoot/dist/extensions", global:"~/.openclaw/extensions", workspace:"workspace/.openclaw/extensions" }
    roots,
    // lyc: 加载路径: loadPaths:[]
    loadPaths,
    // lyc: openclaw版本, 默认值为unknown
    hostContractVersion: resolveCompatibilityHostVersion(env),
    // lyc: 环境变量 禁用持久化插件注册表, 默认值为""
    disablePersisted: env[DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV] ?? "",
    // lyc: 环境变量 禁用捆绑插件, 默认值为""
    disableBundled: env.OPENCLAW_DISABLE_BUNDLED_PLUGINS ?? "",
    // lyc: 是否是vitest环境, 默认值为""
    vitest: env.VITEST ?? "",
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
  // lyc: 派生缓存键: 如果 持久化读取功能已启用(persistedReadsEnabled), 则解析派生快照缓存键, 否则为null
  const derivedCacheKey = persistedReadsEnabled
    ? resolveDerivedSnapshotCacheKey(params, env)
    : null;
  // lyc: 如果 持久化读取功能已启用(persistedReadsEnabled) & 派生缓存键存在(derivedCacheKey), 则尝试从缓存中获取派生插件注册表快照, 如果存在且未过期, 则返回缓存结果, 否则继续执行
  if (derivedCacheKey) {
    const cached = derivedSnapshotCache.get(derivedCacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
  }
  let persistedIndex: InstalledPluginIndex | null = null;
  // lyc: 如果 持久化安装记录读取功能已启用(persistedInstallRecordReadsEnabled) 即: 环境变量 env.DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV 没有禁用 持久化插件注册表
  if (persistedInstallRecordReadsEnabled) {
    // lyc: 解析已安装插件索引, 即解析value(~/.openclaw/plugins/installs.json)为 InstalledPluginIndex 类型的实例, 并特别处理 installRecords 属性
    persistedIndex = readPersistedInstalledPluginIndexSync(params);
    // lyc: 持久化读取功能已启用(调用者和环境变量都没有禁用持久化插件注册表时为true) & 解析已安装插件索引(persistedIndex) 成功
    // lyc: 对 解析已安装插件索引(persistedIndex) 进行策略、源、绑定件树的校验, 效验成功返回persistedIndex, 否则继续执行
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
      环境变量禁用的警告信息：(disabledByEnv=true)
        OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY 是一个已弃用的紧急兼容性开关；请使用 `openclaw plugins registry --refresh` 或 `openclaw doctor --fix` 来修复注册表状态。正在使用旧版派生插件索引。
      调用方禁用的警告信息：(disabledByCaller=true)
        调用方已禁用持久化插件注册表读取；正在使用派生插件索引
      */
      message: disabledByEnv
        ? `${formatDeprecatedPersistedRegistryDisableWarning()} Using legacy derived plugin index.`
        : "Persisted plugin registry reads are disabled by the caller; using derived plugin index.",
    });
  }

  const result: PluginRegistrySnapshotResult = {
    snapshot: loadInstalledPluginIndex({
      ...params,
      installRecords:
        // lyc: 如果入参提供 installRecords 属性, 则优先使用入参提供的安装记录
        params.installRecords ??
        // lyc: 从已安装插件索引中提取安装记录: 从 persistedIndex.installRecords 或 persistedIndex.plugins[].installRecord 中提取安装记录
        extractPluginInstallRecordsFromInstalledPluginIndex(persistedIndex),
    }),
    source: "derived",
    diagnostics,
  };
  if (derivedCacheKey) {
    derivedSnapshotCache.set(derivedCacheKey, {
      expiresAt: Date.now() + DERIVED_SNAPSHOT_CACHE_MS,
      result,
    });
  }
  return result;
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
