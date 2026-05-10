import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LegacyConfigRule } from "../config/legacy.shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { asNullableRecord } from "../shared/record-coerce.js";
import { getCachedPluginJitiLoader, type PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { tryNativeRequireJavaScriptModule } from "./native-module-require.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
import { resolvePluginCacheInputs, type PluginSourceRoots } from "./roots.js";

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

type PluginDoctorContractModule = {
  legacyConfigRules?: unknown;
  normalizeCompatibilityConfig?: unknown;
};

type PluginDoctorCompatibilityMutation = {
  config: OpenClawConfig;
  changes: string[];
};

type PluginDoctorCompatibilityNormalizer = (params: {
  cfg: OpenClawConfig;
}) => PluginDoctorCompatibilityMutation;

type PluginDoctorContractEntry = {
  pluginId: string;
  rules: LegacyConfigRule[];
  normalizeCompatibilityConfig?: PluginDoctorCompatibilityNormalizer;
};

type PluginManifestRegistryRecord = PluginManifestRegistry["plugins"][number];

const jitiLoaders: PluginJitiLoaderCache = new Map();
const doctorContractCache = new Map<string, PluginDoctorContractEntry[]>();
const doctorContractRecordCache = new Map<string, Map<string, PluginDoctorContractEntry | null>>();

function getJiti(modulePath: string) {
  return getCachedPluginJitiLoader({
    cache: jitiLoaders,
    modulePath,
    importerUrl: import.meta.url,
  });
}

function loadPluginDoctorContractModule(modulePath: string): PluginDoctorContractModule {
  const nativeModule = tryNativeRequireJavaScriptModule(modulePath);
  if (nativeModule.ok) {
    return nativeModule.moduleExport as PluginDoctorContractModule;
  }
  return getJiti(modulePath)(modulePath) as PluginDoctorContractModule;
}

// lyc: 构建插件Doctor合同缓存键, 由插件源根目录 和 加载路径 和 排序后的插件ID列表 组成
function buildDoctorContractCacheKey(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): string {
  return JSON.stringify({
    ...resolveDoctorContractBaseCachePayload(params),
    pluginIds: [...(params.pluginIds ?? [])].toSorted(),
  });
}

// lyc: 构建插件Doctor合同基础缓存键, 由插件源根目录 和 加载路径组成
function buildDoctorContractBaseCacheKey(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return JSON.stringify(resolveDoctorContractBaseCachePayload(params));
}

// lyc: 解析插件Doctor合同基础缓存有效负载 由 插件源根目录 和 加载路径 组成
function resolveDoctorContractBaseCachePayload(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): {
  roots: PluginSourceRoots;
  loadPaths: string[];
} {
  // lyc: 解析插件缓存输入: { roots插件源根目录: { stock: packageRoot/.../extensions, global: openclaw的配置目录/extensions, workspace: openclaw的配置目录/extensions } , loadPaths加载路径: [...]}
  const { roots, loadPaths } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return { roots, loadPaths };
}

function resolveContractApiPath(rootDir: string): string | null {
  const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT
    ? CONTRACT_API_EXTENSIONS
    : ([...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)] as const);
  for (const extension of orderedExtensions) {
    const candidate = path.join(rootDir, `doctor-contract-api${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  for (const extension of orderedExtensions) {
    const candidate = path.join(rootDir, `contract-api${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function coerceLegacyConfigRules(value: unknown): LegacyConfigRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const candidate = entry as { path?: unknown; message?: unknown };
    return Array.isArray(candidate.path) && typeof candidate.message === "string";
  }) as LegacyConfigRule[];
}

function coerceNormalizeCompatibilityConfig(
  value: unknown,
): PluginDoctorCompatibilityNormalizer | undefined {
  return typeof value === "function" ? (value as PluginDoctorCompatibilityNormalizer) : undefined;
}

function hasLegacyElevenLabsTalkFields(raw: unknown): boolean {
  const talk = asNullableRecord(asNullableRecord(raw)?.talk);
  if (!talk) {
    return false;
  }
  return ["voiceId", "voiceAliases", "modelId", "outputFormat", "apiKey"].some((key) =>
    Object.prototype.hasOwnProperty.call(talk, key),
  );
}

/* lyc: 计算所有可能的插件ID，从raw配置的channels, plugins.entries 和 talk中提取
return: [
    root.channels.属性名(排除defaults属性名), 
    root.plugins.entries.属性名,
    root.talk && root.talk有其中一个属性:["voiceId", "voiceAliases", "modelId", "outputFormat", "apiKey"] && "elevenlabs"
].toSorted()
elevenlabs是一个AI语音合成与声音克隆平台
*/
export function collectRelevantDoctorPluginIds(raw: unknown): string[] {
  const ids = new Set<string>();
  const root = asNullableRecord(raw);
  if (!root) {
    return [];
  }

  const channels = asNullableRecord(root.channels);
  if (channels) {
    for (const channelId of Object.keys(channels)) {
      if (channelId !== "defaults") {
        ids.add(channelId);
      }
    }
  }

  const pluginsEntries = asNullableRecord(asNullableRecord(root.plugins)?.entries);
  if (pluginsEntries) {
    for (const pluginId of Object.keys(pluginsEntries)) {
      ids.add(pluginId);
    }
  }

  if (hasLegacyElevenLabsTalkFields(root)) {
    ids.add("elevenlabs");
  }

  return [...ids].toSorted();
}

export function collectRelevantDoctorPluginIdsForTouchedPaths(params: {
  raw: unknown;
  touchedPaths: ReadonlyArray<ReadonlyArray<string>>;
}): string[] {
  const root = asNullableRecord(params.raw);
  if (!root) {
    return [];
  }

  const ids = new Set<string>();
  for (const touchedPath of params.touchedPaths) {
    const [first, second, third] = touchedPath;
    if (first === "channels") {
      if (!second) {
        return collectRelevantDoctorPluginIds(params.raw);
      }
      if (second !== "defaults") {
        ids.add(second);
      }
      continue;
    }
    if (first === "plugins") {
      if (second !== "entries" || !third) {
        return collectRelevantDoctorPluginIds(params.raw);
      }
      ids.add(third);
      continue;
    }
    if (first === "talk" && hasLegacyElevenLabsTalkFields(root)) {
      ids.add("elevenlabs");
    }
  }

  return [...ids].toSorted();
}

function getDoctorContractRecordCache(
  baseCacheKey: string,
): Map<string, PluginDoctorContractEntry | null> {
  let cache = doctorContractRecordCache.get(baseCacheKey);
  if (!cache) {
    cache = new Map();
    doctorContractRecordCache.set(baseCacheKey, cache);
  }
  return cache;
}

function loadPluginDoctorContractEntry(
  record: PluginManifestRegistryRecord,
  baseCacheKey: string,
): PluginDoctorContractEntry | null {
  const cache = getDoctorContractRecordCache(baseCacheKey);
  const cached = cache.get(record.id);
  if (cached !== undefined) {
    return cached;
  }

  const contractSource = resolveContractApiPath(record.rootDir);
  if (!contractSource) {
    cache.set(record.id, null);
    return null;
  }
  let mod: PluginDoctorContractModule;
  try {
    mod = loadPluginDoctorContractModule(contractSource);
  } catch {
    cache.set(record.id, null);
    return null;
  }
  const rules = coerceLegacyConfigRules(
    (mod as { default?: PluginDoctorContractModule }).default?.legacyConfigRules ??
      mod.legacyConfigRules,
  );
  const normalizeCompatibilityConfig = coerceNormalizeCompatibilityConfig(
    mod.normalizeCompatibilityConfig ??
      (mod as { default?: PluginDoctorContractModule }).default?.normalizeCompatibilityConfig,
  );
  if (rules.length === 0 && !normalizeCompatibilityConfig) {
    cache.set(record.id, null);
    return null;
  }
  const entry = {
    pluginId: record.id,
    rules,
    normalizeCompatibilityConfig,
  };
  cache.set(record.id, entry);
  return entry;
}

// lyc: 解析插件的Doctor合同, 并返回解析后的 Doctor合同对象列表
function resolvePluginDoctorContracts(params?: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): PluginDoctorContractEntry[] {
  const env = params?.env ?? process.env;
  // lyc: 构建插件Doctor合同基础缓存键, 由插件源根目录 和 加载路径组成
  const baseCacheKey = buildDoctorContractBaseCacheKey({
    workspaceDir: params?.workspaceDir,
    env,
  });
  // lyc: 构建插件Doctor合同缓存键, 由插件源根目录 和 加载路径 和 排序后的pluginIds列表 组成
  const cacheKey = buildDoctorContractCacheKey({
    workspaceDir: params?.workspaceDir,
    env,
    pluginIds: params?.pluginIds,
  });
  // lyc: 从缓存中获取 cacheKey(插件Doctor合同缓存键) 对应的 合同对象列表, 如果存在则直接返回
  const cached = doctorContractCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  // lyc: 如果pluginIds列表为空, 则以 cacheKey 为键向缓存中存储空列表, 返回空列表
  if (params?.pluginIds && params.pluginIds.length === 0) {
    doctorContractCache.set(cacheKey, []);
    return [];
  }

  // lyc: 为 插件注册表(PluginRegistry) 加载 插件清单注册表(manifestRegistry:PluginManifestRegistry)
  const manifestRegistry = loadPluginManifestRegistryForPluginRegistry({
    workspaceDir: params?.workspaceDir,
    env,
    cache: true,
    includeDisabled: true,
  });

  const entries: PluginDoctorContractEntry[] = [];
  const selectedPluginIds = params?.pluginIds ? new Set(params.pluginIds) : null;
  for (const record of manifestRegistry.plugins) {
    // lyc: 如果入参指定了 pluginIds 列表, 且当前插件(record.id), 或其渠道(channelId) 或其提供者(providerId) 都不在 pluginIds 列表中, 则跳过当前插件
    if (
      selectedPluginIds &&
      !selectedPluginIds.has(record.id) &&
      !record.channels.some((channelId) => selectedPluginIds.has(channelId)) &&
      !record.providers.some((providerId) => selectedPluginIds.has(providerId))
    ) {
      continue;
    }
    // lyc: 加载当前插件的Doctor合同
    const entry = loadPluginDoctorContractEntry(record, baseCacheKey);
    // lyc: 如果Doctor合同加载成功(entry!=null), 则将其添加到 Doctor合同对象列表(entries)中, 否则跳过当前插件
    if (entry) {
      entries.push(entry);
    }
  }
  // lyc: 以 cacheKey 为键向缓存中存储 Doctor合同对象列表(entries)
  doctorContractCache.set(cacheKey, entries);
  // lyc: 返回解析后的 Doctor合同对象列表
  return entries;
}

export function clearPluginDoctorContractRegistryCache(): void {
  doctorContractCache.clear();
  doctorContractRecordCache.clear();
  jitiLoaders.clear();
}

// lyc: 列出所有插件的兼容性配置规则
export function listPluginDoctorLegacyConfigRules(params?: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): LegacyConfigRule[] {
  return resolvePluginDoctorContracts(params).flatMap((entry) => entry.rules);
}

export function applyPluginDoctorCompatibilityMigrations(
  cfg: OpenClawConfig,
  params?: {
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    pluginIds?: readonly string[];
  },
): {
  config: OpenClawConfig;
  changes: string[];
} {
  let nextCfg = cfg;
  const changes: string[] = [];
  for (const entry of resolvePluginDoctorContracts(params)) {
    const mutation = entry.normalizeCompatibilityConfig?.({ cfg: nextCfg });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    nextCfg = mutation.config;
    changes.push(...mutation.changes);
  }
  return { config: nextCfg, changes };
}
