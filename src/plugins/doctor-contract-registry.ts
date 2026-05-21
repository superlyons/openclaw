import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LegacyConfigRule } from "../config/legacy.shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { asNullableRecord } from "../shared/record-coerce.js";
import type { DoctorSessionRouteStateOwner } from "./doctor-session-route-state-owner-types.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
  type PluginModuleLoaderFactory,
  type PluginModuleLoaderCache,
} from "./plugin-module-loader-cache.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

type PluginDoctorContractModule = {
  legacyConfigRules?: unknown;
  normalizeCompatibilityConfig?: unknown;
  sessionRouteStateOwners?: unknown;
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
  sessionRouteStateOwners: DoctorSessionRouteStateOwner[];
};

type PluginManifestRegistryRecord = PluginManifestRegistry["plugins"][number];

const moduleLoaders: PluginModuleLoaderCache = createPluginModuleLoaderCache();
let moduleLoaderFactoryForTest: PluginModuleLoaderFactory | undefined;

function loadPluginDoctorContractModule(modulePath: string): PluginDoctorContractModule {
  // lyc:aic v2026.5：模块加载从"原生 require 失败再 jiti"改为统一的 getCachedPluginModuleLoader（带缓存）
  return getCachedPluginModuleLoader({
    cache: moduleLoaders,
    modulePath,
    importerUrl: import.meta.url,
    ...(moduleLoaderFactoryForTest ? { createLoader: moduleLoaderFactoryForTest } : {}),
  })(modulePath) as PluginDoctorContractModule;
// lyc:aic v2026.5：以下 3 个 helper 被整体删除（buildDoctorContractCacheKey / buildDoctorContractBaseCacheKey /
//                  resolveDoctorContractBaseCachePayload）。Doctor 合同缓存机制改为基于函数级缓存（见 createDoctorContractsLoaderCache 等）。
//                  你的中文注释（关于这 3 个 helper 的描述）在 git 历史中可查（提交 ${branch HEAD}）。
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

function normalizeTrimmedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function isDoctorSessionRouteStateOwner(value: unknown): value is DoctorSessionRouteStateOwner {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    label?: unknown;
    providerIds?: unknown;
    runtimeIds?: unknown;
    cliSessionKeys?: unknown;
    authProfilePrefixes?: unknown;
  };
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    candidate.id.trim().length > 0 &&
    candidate.label.trim().length > 0 &&
    (candidate.providerIds === undefined ||
      normalizeTrimmedStringList(candidate.providerIds).length > 0) &&
    (candidate.runtimeIds === undefined ||
      normalizeTrimmedStringList(candidate.runtimeIds).length > 0) &&
    (candidate.cliSessionKeys === undefined ||
      normalizeTrimmedStringList(candidate.cliSessionKeys).length > 0) &&
    (candidate.authProfilePrefixes === undefined ||
      normalizeTrimmedStringList(candidate.authProfilePrefixes).length > 0)
  );
}

function coerceDoctorSessionRouteStateOwners(value: unknown): DoctorSessionRouteStateOwner[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isDoctorSessionRouteStateOwner).map((owner) => ({
    id: owner.id.trim(),
    label: owner.label.trim(),
    providerIds: normalizeTrimmedStringList(owner.providerIds),
    runtimeIds: normalizeTrimmedStringList(owner.runtimeIds),
    cliSessionKeys: normalizeTrimmedStringList(owner.cliSessionKeys),
    authProfilePrefixes: normalizeTrimmedStringList(owner.authProfilePrefixes),
  }));
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

function loadPluginDoctorContractEntry(
  record: PluginManifestRegistryRecord,
): PluginDoctorContractEntry | null {
  const contractSource = resolveContractApiPath(record.rootDir);
  if (!contractSource) {
    return null;
  }
  let mod: PluginDoctorContractModule;
  try {
    mod = loadPluginDoctorContractModule(contractSource);
  } catch {
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
  const sessionRouteStateOwners = coerceDoctorSessionRouteStateOwners(
    mod.sessionRouteStateOwners ??
      (mod as { default?: PluginDoctorContractModule }).default?.sessionRouteStateOwners,
  );
  if (rules.length === 0 && !normalizeCompatibilityConfig && sessionRouteStateOwners.length === 0) {
    return null;
  }
  return {
    pluginId: record.id,
    rules,
    normalizeCompatibilityConfig,
    sessionRouteStateOwners,
  };
}

// lyc: 解析插件的Doctor合同, 并返回解析后的 Doctor合同对象列表
function resolvePluginDoctorContracts(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): PluginDoctorContractEntry[] {
  const env = params?.env ?? process.env;
  // lyc:aic v2026.5：原本这里有 baseCacheKey/cacheKey + doctorContractCache 查缓存的逻辑——
  //                  整套机制被替换为更内化的缓存（在下方 moduleLoaders 等内部 cache 里）。
  if (params?.pluginIds && params.pluginIds.length === 0) {
    return [];
  }

  // lyc: 为 插件注册表(PluginRegistry) 加载 插件清单注册表(manifestRegistry:PluginManifestRegistry)
  const manifestRegistry = loadPluginManifestRegistryForPluginRegistry({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env,
    includeDisabled: true,
  });

  const entries: PluginDoctorContractEntry[] = [];
  const scopedPluginIds = params?.pluginIds ? new Set(params.pluginIds) : null;
  for (const record of manifestRegistry.plugins) {
    // lyc: 如果入参指定了 pluginIds 列表, 且当前插件(record.id), 或其渠道(channelId) 或其提供者(providerId) 都不在 pluginIds 列表中, 则跳过当前插件
    if (
      scopedPluginIds &&
      !scopedPluginIds.has(record.id) &&
      !record.channels.some((channelId) => scopedPluginIds.has(channelId)) &&
      !record.providers.some((providerId) => scopedPluginIds.has(providerId))
    ) {
      continue;
    }
    // lyc: 加载当前插件的 Doctor 合同
    // lyc:aic v2026.5：去掉了第二参数 baseCacheKey（缓存键现已不在调用点关心）
    const entry = loadPluginDoctorContractEntry(record);
    // lyc: 如果 Doctor 合同加载成功 (entry!=null), 则将其添加到 Doctor 合同对象列表 (entries) 中, 否则跳过当前插件
    if (entry) {
      entries.push(entry);
    }
  }
  // lyc:aic v2026.5：原本这里 doctorContractCache.set(cacheKey, entries) 缓存结果——已移除
  // lyc: 返回解析后的 Doctor 合同对象列表

  return entries;
}

export function clearPluginDoctorContractRegistryCache(): void {
  moduleLoaders.clear();
}

export function setPluginDoctorContractRegistryModuleLoaderFactoryForTest(
  factory: PluginModuleLoaderFactory | undefined,
): void {
  moduleLoaderFactoryForTest = factory;
  moduleLoaders.clear();
}

// lyc: 列出所有插件的兼容性配置规则
export function listPluginDoctorLegacyConfigRules(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): LegacyConfigRule[] {
  return resolvePluginDoctorContracts(params).flatMap((entry) => entry.rules);
}

export function listPluginDoctorSessionRouteStateOwners(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): DoctorSessionRouteStateOwner[] {
  const owners = new Map<string, DoctorSessionRouteStateOwner>();
  for (const owner of resolvePluginDoctorContracts(params).flatMap(
    (entry) => entry.sessionRouteStateOwners,
  )) {
    if (!owners.has(owner.id)) {
      owners.set(owner.id, owner);
    }
  }
  return [...owners.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

export function applyPluginDoctorCompatibilityMigrations(
  cfg: OpenClawConfig,
  params?: {
    config?: OpenClawConfig;
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
