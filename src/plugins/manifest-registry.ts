import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeOptionalTrimmedStringList } from "../shared/string-normalization.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveUserPath } from "../utils.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { loadBundleManifest } from "./bundle-manifest.js";
import {
  normalizePluginsConfigWithResolver,
  type NormalizedPluginsConfig,
} from "./config-policy.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import type { PluginManifestCommandAlias } from "./manifest-command-aliases.js";
import {
  clearPluginManifestRegistryCache,
  pluginManifestRegistryCache,
} from "./manifest-registry-state.js";
import type {
  PluginBundleFormat,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginFormat,
} from "./manifest-types.js";
import {
  loadPluginManifest,
  type OpenClawPackageManifest,
  type PluginManifestActivation,
  type PluginManifestConfigContracts,
  type PluginManifest,
  type PluginManifestChannelCommandDefaults,
  type PluginManifestChannelConfig,
  type PluginManifestContracts,
  type PluginManifestMediaUnderstandingProviderMetadata,
  type PluginManifestModelCatalog,
  type PluginManifestModelIdNormalization,
  type PluginManifestModelPricing,
  type PluginManifestModelSupport,
  type PluginManifestProviderEndpoint,
  type PluginManifestProviderRequest,
  type PluginManifestQaRunner,
  type PluginManifestSetup,
} from "./manifest.js";
import { checkMinHostVersion } from "./min-host-version.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";
import type { PluginKind } from "./plugin-kind.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { resolvePluginCacheInputs } from "./roots.js";

/**
 * Resolve a plugin source path, falling back from .ts to .js when the
 * .ts file doesn't exist on disk (e.g. in dist builds where only .js
 * is emitted but the manifest still references the .ts entry).
 */
// lyc: 解决插件源路径问题，当磁盘上不存在 .ts 文件时（例如，在 dist 构建中，只生成 .js 文件，但清单仍然引用 .ts 条目），从 .ts 回退到 .js。
function resolvePluginSourcePath(sourcePath: string): string {
  if (fs.existsSync(sourcePath)) {
    return sourcePath;
  }
  // lyc: 当插件源路径以 .ts 结尾时，尝试回退到 .js
  if (sourcePath.endsWith(".ts")) {
    const jsPath = sourcePath.slice(0, -3) + ".js";
    if (fs.existsSync(jsPath)) {
      return jsPath;
    }
  }
  return sourcePath;
}

export type PluginManifestContractListKey =
  | "speechProviders"
  | "externalAuthProviders"
  | "mediaUnderstandingProviders"
  | "documentExtractors"
  | "realtimeVoiceProviders"
  | "realtimeTranscriptionProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "memoryEmbeddingProviders"
  | "webContentExtractors"
  | "webFetchProviders"
  | "webSearchProviders"
  | "migrationProviders";

type SeenIdEntry = {
  candidate: PluginCandidate;
  recordIndex: number;
};

// Canonicalize identical physical plugin roots with the most explicit source.
// This only applies when multiple candidates resolve to the same on-disk plugin.
// lyc: 使用最明确的来源对相同的物理插件根进行规范化。
// lyc: 这仅适用于多个候选插件解析为同一个磁盘上的插件的情况
// lyc: 插件来源优先级: config > workspace > global > bundled
const PLUGIN_ORIGIN_RANK: Readonly<Record<PluginOrigin, number>> = {
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

export type PluginManifestRecord = {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  enabledByDefault?: boolean;
  autoEnableWhenConfiguredProviders?: string[];
  legacyPluginIds?: string[];
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  kind?: PluginKind | PluginKind[];
  channels: string[];
  providers: string[];
  providerDiscoverySource?: string;
  modelSupport?: PluginManifestModelSupport;
  modelCatalog?: PluginManifestModelCatalog;
  modelPricing?: PluginManifestModelPricing;
  modelIdNormalization?: PluginManifestModelIdNormalization;
  providerEndpoints?: PluginManifestProviderEndpoint[];
  providerRequest?: PluginManifestProviderRequest;
  cliBackends: string[];
  syntheticAuthRefs?: string[];
  nonSecretAuthMarkers?: string[];
  commandAliases?: PluginManifestCommandAlias[];
  providerAuthEnvVars?: Record<string, string[]>;
  providerAuthAliases?: Record<string, string>;
  channelEnvVars?: Record<string, string[]>;
  providerAuthChoices?: PluginManifest["providerAuthChoices"];
  activation?: PluginManifestActivation;
  setup?: PluginManifestSetup;
  qaRunners?: PluginManifestQaRunner[];
  skills: string[];
  settingsFiles?: string[];
  hooks: string[];
  origin: PluginOrigin;
  workspaceDir?: string;
  rootDir: string;
  source: string;
  setupSource?: string;
  startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
  contracts?: PluginManifestContracts;
  mediaUnderstandingProviderMetadata?: Record<
    string,
    PluginManifestMediaUnderstandingProviderMetadata
  >;
  configContracts?: PluginManifestConfigContracts;
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
  channelCatalogMeta?: {
    id: string;
    label?: string;
    blurb?: string;
    preferOver?: readonly string[];
    commands?: PluginManifestChannelCommandDefaults;
  };
};

export type PluginManifestRegistry = {
  plugins: PluginManifestRecord[];
  diagnostics: PluginDiagnostic[];
};

export type BundledChannelConfigCollector = (params: {
  pluginDir: string;
  manifest: PluginManifest;
  packageManifest?: OpenClawPackageManifest;
}) => Record<string, PluginManifestChannelConfig> | undefined;

const registryCache = pluginManifestRegistryCache as Map<
  string,
  { expiresAt: number; registry: PluginManifestRegistry }
>;

// Keep a short cache window to collapse bursty reloads during startup flows.
const DEFAULT_MANIFEST_CACHE_MS = 1000;

export { clearPluginManifestRegistryCache } from "./manifest-registry-state.js";

function resolveManifestCacheMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS?.trim();
  if (raw === "" || raw === "0") {
    return 0;
  }
  if (!raw) {
    return DEFAULT_MANIFEST_CACHE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MANIFEST_CACHE_MS;
  }
  return Math.max(0, parsed);
}

// lyc: 是否启用插件清单注册表缓存, 从env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE 和 OPENCLAW_PLUGIN_MANIFEST_CACHE_MS 中判断
function shouldUseManifestCache(env: NodeJS.ProcessEnv): boolean {
  const disabled = env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE?.trim();
  if (disabled) {
    return false;
  }
  return resolveManifestCacheMs(env) > 0;
}

// lyc: 构建插件清单注册表缓存键
function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
  env: NodeJS.ProcessEnv;
}): string {
  // lyc: roots(插件源根目录): { stock: packageRoot/.../extensions, global: openclaw的配置目录/extensions, workspace: workspaceRoot/.openclaw/extensions }, loadPaths(加载路径): [...loadPaths]}
  const { roots, loadPaths } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    loadPaths: params.plugins.loadPaths,
    env: params.env,
  });
  const workspaceKey = roots.workspace ?? "";
  const configExtensionsRoot = roots.global;
  const bundledRoot = roots.stock ?? "";
  const runtimeServiceVersion = resolveCompatibilityHostVersion(params.env);
  // The manifest registry only depends on where plugins are discovered from (workspace + load paths).
  // It does not depend on allow/deny/entries enable-state, so exclude those for higher cache hit rates.
  // lyc: 清单注册表仅依赖于插件的发现位置（workspace + load paths）
  // lyc: 它不依赖于allow/deny/entries的启用状态，因此为了获得更高的缓存命中率，排除了这些因素
  return `${workspaceKey}::${configExtensionsRoot}::${bundledRoot}::${runtimeServiceVersion}::${JSON.stringify(loadPaths)}`;
}

function safeStatMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function normalizePreferredPluginIds(raw: unknown): string[] | undefined {
  return normalizeOptionalTrimmedStringList(raw);
}

// lyc: 规范化插件包清单中的渠道命令的配置(rootDir/package.json.channel.commands)
function normalizePackageChannelCommands(
  commands: unknown,
): PluginManifestChannelCommandDefaults | undefined {
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    return undefined;
  }
  const record = commands as Record<string, unknown>;
  // lyc: 允许 原生命令自动启用
  const nativeCommandsAutoEnabled =
    typeof record.nativeCommandsAutoEnabled === "boolean"
      ? record.nativeCommandsAutoEnabled
      : undefined;
  // lyc: 允许 原生技能自动启用
  const nativeSkillsAutoEnabled =
    typeof record.nativeSkillsAutoEnabled === "boolean"
      ? record.nativeSkillsAutoEnabled
      : undefined;
  return nativeCommandsAutoEnabled !== undefined || nativeSkillsAutoEnabled !== undefined
    ? {
        ...(nativeCommandsAutoEnabled !== undefined ? { nativeCommandsAutoEnabled } : {}),
        ...(nativeSkillsAutoEnabled !== undefined ? { nativeSkillsAutoEnabled } : {}),
      }
    : undefined;
}

// lyc: 合并插件包清单中的渠道元数据(packageChannel)到插件清单中的渠道配置(channelConfigs)
// lyc: packageChannel是单个配置, channelConfigs是多个配置以channelId为键
function mergePackageChannelMetaIntoChannelConfigs(params: {
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
  packageChannel?: OpenClawPackageManifest["channel"];
}): Record<string, PluginManifestChannelConfig> | undefined {
  const channelId = params.packageChannel?.id?.trim();
  // lyc: packageChannel为空 | packageChannel没有id属性 | id的值 是保留的键名 |
  // lyc: 没有提供channelConfigs | channelConfigs没有 id的值 的属性
  if (
    !channelId ||
    isBlockedObjectKey(channelId) ||
    !params.channelConfigs ||
    !Object.prototype.hasOwnProperty.call(params.channelConfigs, channelId)
  ) {
    return params.channelConfigs;
  }

  // lyc: channelConfigs中 packageChannel.id的值 的属性值
  // lyc: 即: channelConfigs 中 packageChannel 的配置
  const existing = params.channelConfigs[channelId];
  // lyc:  channelConfigs 没有 packageChannel 的配置
  if (!existing) {
    return params.channelConfigs;
  }
  // lyc: 在channelConfigs中没有设置的字段, 则使用 packageChannel 中的字段补充
  // lyc: 主要合并 label, description, preferOver, commands 四个字段
  const label = existing.label ?? normalizeOptionalString(params.packageChannel?.label) ?? "";
  const description =
    existing.description ?? normalizeOptionalString(params.packageChannel?.blurb) ?? "";
  const preferOver =
    existing.preferOver ?? normalizePreferredPluginIds(params.packageChannel?.preferOver);
  const commands =
    existing.commands ?? normalizePackageChannelCommands(params.packageChannel?.commands);

  const merged: Record<string, PluginManifestChannelConfig> = Object.create(null);
  for (const [key, value] of Object.entries(params.channelConfigs)) {
    if (!isBlockedObjectKey(key)) {
      merged[key] = value;
    }
  }
  merged[channelId] = {
    ...existing,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(preferOver?.length ? { preferOver } : {}),
    ...(commands ? { commands } : {}),
  };
  return merged;
}

// lyc: 构建插件清单注册表记录
function buildRecord(params: {
  // lyc:  插件清单文件实例 rootDir/openclaw.plugin.json | (codex|cursor|claude)-plugin/plugin.json
  manifest: PluginManifest;
  // lyc: 插件候选候选实例, 其中包含插件的包清单文件实例 rootDir/package.json
  candidate: PluginCandidate;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
  bundledChannelConfigCollector?: BundledChannelConfigCollector;
}): PluginManifestRecord {
  const manifestChannelConfigs =
    params.candidate.origin === "bundled" && params.bundledChannelConfigCollector
      ? params.bundledChannelConfigCollector({
          pluginDir: params.candidate.packageDir ?? params.candidate.rootDir,
          // lyc: 插件清单文件实例 rootDir/openclaw.plugin.json | (codex|cursor|claude)-plugin/plugin.json
          manifest: params.manifest,
          // lyc: 插件的包清单文件实例 rootDir/package.json
          packageManifest: params.candidate.packageManifest,
        })
      : params.manifest.channelConfigs;
  // lyc: 渠道配置列表: manifestChannelConfigs(列表)合并packageChannel(一个)后的渠道配置列表
  const channelConfigs = mergePackageChannelMetaIntoChannelConfigs({
    channelConfigs: manifestChannelConfigs,
    packageChannel: params.candidate.packageManifest?.channel,
  });
  // lyc: 规范化插件包清单中的渠道命令的配置(rootDir/package.json.channel.commands)
  const packageChannelCommands = normalizePackageChannelCommands(
    params.candidate.packageManifest?.channel?.commands,
  );
  return {
    id: params.manifest.id,
    name: normalizeOptionalString(params.manifest.name) ?? params.candidate.packageName,
    description:
      normalizeOptionalString(params.manifest.description) ?? params.candidate.packageDescription,
    version: normalizeOptionalString(params.manifest.version) ?? params.candidate.packageVersion,
    enabledByDefault: params.manifest.enabledByDefault === true ? true : undefined,
    autoEnableWhenConfiguredProviders: params.manifest.autoEnableWhenConfiguredProviders,
    legacyPluginIds: params.manifest.legacyPluginIds,
    format: params.candidate.format ?? "openclaw",
    bundleFormat: params.candidate.bundleFormat,
    kind: params.manifest.kind,
    channels: params.manifest.channels ?? [],
    providers: params.manifest.providers ?? [],
    providerDiscoverySource: params.manifest.providerDiscoveryEntry
      // lyc: 解析 rootDir/providerDiscoveryEntry 路径
      ? resolvePluginSourcePath(
          path.resolve(params.candidate.rootDir, params.manifest.providerDiscoveryEntry),
        )
      : undefined,
    modelSupport: params.manifest.modelSupport,
    modelCatalog: params.manifest.modelCatalog,
    modelPricing: params.manifest.modelPricing,
    modelIdNormalization: params.manifest.modelIdNormalization,
    providerEndpoints: params.manifest.providerEndpoints,
    providerRequest: params.manifest.providerRequest,
    cliBackends: params.manifest.cliBackends ?? [],
    syntheticAuthRefs: params.manifest.syntheticAuthRefs ?? [],
    nonSecretAuthMarkers: params.manifest.nonSecretAuthMarkers ?? [],
    commandAliases: params.manifest.commandAliases,
    providerAuthEnvVars: params.manifest.providerAuthEnvVars,
    providerAuthAliases: params.manifest.providerAuthAliases,
    channelEnvVars: params.manifest.channelEnvVars,
    providerAuthChoices: params.manifest.providerAuthChoices,
    activation: params.manifest.activation,
    setup: params.manifest.setup,
    qaRunners: params.manifest.qaRunners,
    skills: params.manifest.skills ?? [],
    settingsFiles: [],
    hooks: [],
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    setupSource: params.candidate.setupSource,
    startupDeferConfiguredChannelFullLoadUntilAfterListen:
      params.candidate.packageManifest?.startup?.deferConfiguredChannelFullLoadUntilAfterListen ===
      true,
    manifestPath: params.manifestPath,
    schemaCacheKey: params.schemaCacheKey,
    configSchema: params.configSchema,
    configUiHints: params.manifest.uiHints,
    contracts: params.manifest.contracts,
    mediaUnderstandingProviderMetadata: params.manifest.mediaUnderstandingProviderMetadata,
    configContracts: params.manifest.configContracts,
    channelConfigs,
    ...(params.candidate.packageManifest?.channel?.id
      ? {
          channelCatalogMeta: {
            id: params.candidate.packageManifest.channel.id,
            ...(typeof params.candidate.packageManifest.channel.label === "string"
              ? { label: params.candidate.packageManifest.channel.label }
              : {}),
            ...(typeof params.candidate.packageManifest.channel.blurb === "string"
              ? { blurb: params.candidate.packageManifest.channel.blurb }
              : {}),
            ...(params.candidate.packageManifest.channel.preferOver
              ? { preferOver: params.candidate.packageManifest.channel.preferOver }
              : {}),
            ...(packageChannelCommands ? { commands: packageChannelCommands } : {}),
          },
        }
      : {}),
  };
}

// lyc: 构建捆绑的插件清单注册表记录
function buildBundleRecord(params: {
  manifest: {
    id: string;
    name?: string;
    description?: string;
    version?: string;
    skills: string[];
    settingsFiles?: string[];
    hooks: string[];
    capabilities: string[];
  };
  candidate: PluginCandidate;
  manifestPath: string;
}): PluginManifestRecord {
  return {
    id: params.manifest.id,
    name: normalizeOptionalString(params.manifest.name) ?? params.candidate.idHint,
    description: normalizeOptionalString(params.manifest.description),
    version: normalizeOptionalString(params.manifest.version),
    format: "bundle",
    bundleFormat: params.candidate.bundleFormat,
    bundleCapabilities: params.manifest.capabilities,
    channels: [],
    providers: [],
    cliBackends: [],
    syntheticAuthRefs: [],
    nonSecretAuthMarkers: [],
    skills: params.manifest.skills ?? [],
    settingsFiles: params.manifest.settingsFiles ?? [],
    hooks: params.manifest.hooks ?? [],
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    manifestPath: params.manifestPath,
    schemaCacheKey: undefined,
    configSchema: undefined,
    configUiHints: undefined,
    configContracts: undefined,
    channelConfigs: undefined,
  };
}

// lyc: 向入参 诊断记录(diagnostics) 中添加 提供者认证环境变量(ProviderAuthEnvVars) 兼容性诊断信息
// lyc: 排除 来源(origin)是 捆绑的插件
function pushProviderAuthEnvVarsCompatDiagnostic(params: {
  record: PluginManifestRecord;
  diagnostics: PluginDiagnostic[];
}): void {
  if (params.record.origin === "bundled" || !params.record.providerAuthEnvVars) {
    return;
  }
  /* lyc: 提取 providerAuthEnvVars 中的 providerId 列表
  providerAuthEnvVars = { providerId: [envVar1, envVar2, ...], providerId2: [envVar3, envVar4, ...], ... }
  providerIds = [providerId, providerId2, ...]
  */
  const providerIds = Object.entries(params.record.providerAuthEnvVars)
    .filter(([providerId, envVars]) => providerId.trim() && envVars.length > 0)
    .map(([providerId]) => providerId)
    .toSorted((left, right) => left.localeCompare(right));
  if (providerIds.length === 0) {
    return;
  }
  params.diagnostics.push({
    level: "warn",
    pluginId: sanitizeForLog(params.record.id),
    source: sanitizeForLog(params.record.manifestPath),
    // lyc: `providerAuthEnvVars` 是用于查找提供程序环境变量的已弃用兼容性元数据；请在弃用期限结束前，将 [providerId, providerId2, ...] 环境变量镜像到 setup.providers[].envVars 中
    message: `providerAuthEnvVars is deprecated compatibility metadata for provider env-var lookup; mirror ${providerIds.map(sanitizeForLog).join(", ")} env vars to setup.providers[].envVars before the deprecation window closes`,
  });
}

// lyc: 向入参 诊断记录(diagnostics) 中添加 通道配置(ChannelConfig) 兼容性诊断信息
// lyc: 排除 来源(origin)是 捆绑的插件 或者 格式(format)是 bundle的插件
function pushNonBundledChannelConfigDescriptorDiagnostic(params: {
  record: PluginManifestRecord;
  diagnostics: PluginDiagnostic[];
}): void {
  if (params.record.origin === "bundled" || params.record.format === "bundle") {
    return;
  }
  // lyc: channels = ["channelId1", "channelId2", ...]
  const declaredChannels = params.record.channels
    .map((channelId) => channelId.trim())
    .filter((channelId) => channelId.length > 0);
  if (declaredChannels.length === 0) {
    return;
  }
  // lyc: channelConfigs = { channelId1: {}, channelId2: {} ... }
  const channelConfigs = params.record.channelConfigs ?? {};
  // lyc: 找出 declaredChannels 中没有 channelConfigs 配置的 channelId
  const missingChannels = declaredChannels.filter(
    (channelId) => !Object.prototype.hasOwnProperty.call(channelConfigs, channelId),
  );
  if (missingChannels.length === 0) {
    return;
  }
  const safeMissingChannels = missingChannels.map(sanitizeForLog);
  params.diagnostics.push({
    level: "warn",
    pluginId: sanitizeForLog(params.record.id),
    source: sanitizeForLog(params.record.manifestPath),
    // lyc: 通道插件清单中声明了 channelId1、channelId2、channelId3，但没有channelConfigs元数据；请添加openclaw.plugin.json#channelConfigs，以便在运行时加载之前 配置模式 和 设置界面 能够正常工作
    message: `channel plugin manifest declares ${safeMissingChannels.join(", ")} without channelConfigs metadata; add openclaw.plugin.json#channelConfigs so config schema and setup surfaces work before runtime loads`,
  });
}

// lyc: 向入参 诊断记录(diagnostics) 中添加插件清单兼容性诊断信息
function pushManifestCompatibilityDiagnostics(params: {
  record: PluginManifestRecord;
  diagnostics: PluginDiagnostic[];
}): void {
  // lyc: 添加 提供者认证环境变量(ProviderAuthEnvVars) 兼容性诊断信息
  pushProviderAuthEnvVarsCompatDiagnostic(params);
  // lyc: 添加 通道配置(ChannelConfig) 兼容性诊断信息
  pushNonBundledChannelConfigDescriptorDiagnostic(params);
}

// lyc: 判断当前候选插件是否匹配它的已安装插件记录中的路径(installPath, sourcePath)
// lyc: 即: 当前候选插件的安装记录中的路径(installPath, sourcePath) 是否 等于 或 在 当前候选插件的源路径(candidate.source) 内
// lyc: 候选插件的来源(origin)必须是 global 才会执行匹配操作
function matchesInstalledPluginRecord(params: {
  pluginId: string;
  candidate: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): boolean {
  // lyc: 如果当前候选插件的来源(origin)不是 global, 则返回 false
  if (params.candidate.origin !== "global") {
    return false;
  }
  // lyc: 如果 安装记录(installRecords) 中没有 当前候选插件的id(pluginId), 则返回 false
  const record = params.installRecords[params.pluginId];
  if (!record) {
    return false;
  }
  // lyc: 当前候选插件的源路径(candidate.source)
  const candidateSource = resolveUserPath(params.candidate.source, params.env);
  // lyc: 当前候选插件的 已安装插件记录 的路径(installPath, sourcePath)
  const trackedPaths = [record.installPath, record.sourcePath]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => resolveUserPath(entry, params.env));
  if (trackedPaths.length === 0) {
    return false;
  }
  // lyc: 如果 跟踪路径 等于 当前候选插件的源路径 或 在 当前候选插件的源路径 内, 则返回 true, 否则返回 false
  return trackedPaths.some((trackedPath) => {
    return candidateSource === trackedPath || isPathInside(trackedPath, candidateSource);
  });
}

/* lyc: 解决插件优先级冲突, 通过插件来源(origin)来判断, 数值越小优先级越高
config > global & 匹配安装记录路径 > bundled > workspace > global
*/
function resolveDuplicatePrecedenceRank(params: {
  pluginId: string;
  candidate: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): number {
  if (params.candidate.origin === "config") {
    return 0;
  }
  if (
    params.candidate.origin === "global" &&
    // lyc: 当前 候选插件源路径 是否匹配它的 已安装插件记录(installRecords) 中的路径(installPath, sourcePath)
    matchesInstalledPluginRecord({
      pluginId: params.pluginId,
      candidate: params.candidate,
      config: params.config,
      env: params.env,
      installRecords: params.installRecords,
    })
  ) {
    return 1;
  }
  if (params.candidate.origin === "bundled") {
    // Bundled plugin ids are reserved unless the operator explicitly overrides them.
    // lyc: 除非操作员明确覆盖，否则捆绑的插件ID将被保留
    return 2;
  }
  if (params.candidate.origin === "workspace") {
    return 3;
  }
  return 4;
}

/* lyc: 判断当前候选插件是否是故意的、可接受的重复安装的捆绑插件
允许用户安装的插件可以覆盖系统捆绑插件，这是预期行为

定义: 入参left和right可以是以下任意一种
用户安装的插件: 来源(origin)是 global 且 IsInstalled已安装=true
系统捆绑插件: 来源(origin)是 bundled 且 IsInstalled已安装=false

预期行为:
left用户安装的插件 (global+已安装) ↔ right系统捆绑插件 (bundled)
left系统捆绑插件 (bundled) ↔ right用户安装的插件 (global+已安装)
其它非预期行为均返回false
*/
function isIntentionalInstalledBundledDuplicate(params: {
  pluginId: string;
  left: PluginCandidate;
  right: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): boolean {
  // lyc: left插件 是否已安装 且 来源(origin)必须是 global
  const leftIsInstalled = matchesInstalledPluginRecord({
    pluginId: params.pluginId,
    candidate: params.left,
    config: params.config,
    env: params.env,
    installRecords: params.installRecords,
  });
  // lyc: right插件 是否已安装 且 来源(origin)必须是 global
  const rightIsInstalled = matchesInstalledPluginRecord({
    pluginId: params.pluginId,
    candidate: params.right,
    config: params.config,
    env: params.env,
    installRecords: params.installRecords,
  });
  // lyc: 如果 left插件 已安装 且 right插件 来源(origin)是 bundled
  // lyc: 或 right插件 已安装 且 left插件 来源(origin)是 bundled
  // lyc: 则返回 true
  return (
    (leftIsInstalled && params.right.origin === "bundled") ||
    (rightIsInstalled && params.left.origin === "bundled")
  );
}

// lyc: 加载插件清单注册表(PluginManifestRegistry)
export function loadPluginManifestRegistry(
  params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    cache?: boolean;
    env?: NodeJS.ProcessEnv;
    candidates?: PluginCandidate[];
    diagnostics?: PluginDiagnostic[];
    installRecords?: Record<string, PluginInstallRecord>;
    bundledChannelConfigCollector?: BundledChannelConfigCollector;
  } = {},
): PluginManifestRegistry {
  const config = params.config ?? {};
  // lyc: 规范化插件配置，config.plugins为openclaw.json.plugins
  const normalized = normalizePluginsConfigWithResolver(config.plugins);
  const env = params.env ?? process.env;
  // lyc: 构建插件清单注册表缓存键
  const cacheKey = buildCacheKey({ workspaceDir: params.workspaceDir, plugins: normalized, env });
  // lyc: params.cache=true && 入参没有提供installRecords && 入参没有提供bundledChannelConfigCollector回调函数
  const cacheEnabled =
    params.cache !== false &&
    !params.installRecords &&
    !params.bundledChannelConfigCollector &&
    // lyc: 是否启用插件清单注册表缓存, 从env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE 和 OPENCLAW_PLUGIN_MANIFEST_CACHE_MS 中判断
    shouldUseManifestCache(env);
  // lyc: 如果缓存启用，且缓存未过期，则直接返回缓存中的注册表
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.registry;
    }
  }

  /* lyc: 发现插件, 发现位置:
    openclaw.json.plugins.load.paths[], 
    workspace/.openclaw/extensions, 
    packageRoot/extensions, 
    packageRoot/.../extensions, 
    openclaw.json的配置目录/extensions
  */
  const discovery = params.candidates
    ? {
        candidates: params.candidates,
        diagnostics: params.diagnostics ?? [],
      }
    : discoverOpenClawPlugins({
        workspaceDir: params.workspaceDir,
        extraPaths: normalized.loadPaths,
        cache: params.cache,
        env,
      });
  const diagnostics: PluginDiagnostic[] = [...discovery.diagnostics];
  const candidates: PluginCandidate[] = discovery.candidates;
  const records: PluginManifestRecord[] = [];
  const seenIds = new Map<string, SeenIdEntry>();
  const realpathCache = new Map<string, string>();
  const currentHostVersion = resolveCompatibilityHostVersion(env);
  // lyc:  安装记录= ~/.openclaw/plugins/installs.json.installRecords 或 .plugins[].installRecord 
  let installRecords = params.installRecords;
  let installRecordsLoaded = Boolean(params.installRecords);
  // lyc: 获取插件安装记录
  const getInstallRecords = (): Record<string, PluginInstallRecord> => {
    if (!installRecordsLoaded) {
      // lyc: 从已安装插件索引(~/.openclaw/plugins/installs.json)中加载插件安装记录(.installRecords或.plugins[].installRecord)
      installRecords = loadInstalledPluginIndexInstallRecordsSync({ env });
      installRecordsLoaded = true;
    }
    return installRecords ?? {};
  };

  // lyc: 遍历所有发现的候选插件
  for (const candidate of candidates) {
    const rejectHardlinks = candidate.origin !== "bundled";
    // lyc: 当前候选插件是否为捆绑插件记录, 即从覆盖目录(packageRoot/extensions)和roots.stock(packageRoot/.../extensions)中发现的插件
    const isBundleRecord = (candidate.format ?? "openclaw") === "bundle";
    // lyc: 当前候选插件的清单文件资源 = {ok: true, manifest: 插件清单文件实例, manifestPath: 插件清单文件路径} | {ok: false, error: 错误信息, manifestPath: 插件清单文件路径}
    // lyc: rootDir + openclaw.plugin.json | .codex-plugin/plugin.json | .cursor-plugin/plugin.json| .claude-plugin/plugin.json
    const manifestRes:
      | ReturnType<typeof loadPluginManifest>
      | ReturnType<typeof loadBundleManifest>
      | { ok: true; manifest: PluginManifest; manifestPath: string } =
      // lyc: 当前候选的起源(origin)是捆绑的(bundled) && 有捆绑插件清单(bundledManifest) && 有捆绑插件清单路径(bundledManifestPath)
      candidate.origin === "bundled" && candidate.bundledManifest && candidate.bundledManifestPath
        ? {
            ok: true,
            manifest: candidate.bundledManifest,
            manifestPath: candidate.bundledManifestPath,
          }
        // lyc: 或者当前候选的格式(format)是捆绑(bundle)格式 && 指定了捆绑格式(bundleFormat=codex|cursor|claude)
        : isBundleRecord && candidate.bundleFormat
          // lyc: 加载捆绑插件的清单manifest文件, 特指codex, cursor, claude的绑定插件清单
          // lyc: rootDir + .codex-plugin/plugin.json | .cursor-plugin/plugin.json|.claude-plugin / plugin.json
          ? loadBundleManifest({
              rootDir: candidate.rootDir,
              bundleFormat: candidate.bundleFormat,
              rejectHardlinks,
            })
            // lyc: 否则在当前候选的根目录(rootDir)中加载插件清单manifest文件(openclaw.plugin.json)
          : loadPluginManifest(candidate.rootDir, rejectHardlinks);
    if (!manifestRes.ok) {
      diagnostics.push({
        level: "error",
        message: manifestRes.error,
        source: manifestRes.manifestPath,
      });
      continue;
    }
    // lyc: 当前候选插件的清单文件实例
    // lyc: rootDir + openclaw.plugin.json | .codex-plugin/plugin.json | .cursor-plugin/plugin.json| .claude-plugin/plugin.json
    const manifest = manifestRes.manifest;
    // lyc: 检查当前主机版本是否符合当前候选插件的最小主机版本要求(从插件包清单package.json中获取)
    const minHostVersionCheck = checkMinHostVersion({
      currentVersion: currentHostVersion,
      minHostVersion: candidate.packageManifest?.install?.minHostVersion,
    });
    // lyc: 如果当前候选插件不符合当前主机版本要求, 则添加警告诊断信息, 跳过后续处理, 处理下一个候选插件
    if (!minHostVersionCheck.ok) {
      const packageManifestSource = path.join(
        candidate.packageDir ?? candidate.rootDir,
        "package.json",
      );
      diagnostics.push({
        level: minHostVersionCheck.kind === "unknown_host_version" ? "warn" : "error",
        pluginId: manifest.id,
        source: packageManifestSource,
        message:
          minHostVersionCheck.kind === "invalid"
            ? `plugin manifest invalid | ${minHostVersionCheck.error}`
            : minHostVersionCheck.kind === "unknown_host_version"
              ? `plugin requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host version could not be determined; skipping load`
              : `plugin requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host is ${minHostVersionCheck.currentVersion}; skipping load`,
      });
      continue;
    }

    const configSchema = "configSchema" in manifest ? manifest.configSchema : undefined;
    const schemaCacheKey = (() => {
      if (!configSchema) {
        return undefined;
      }
      const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
      return manifestMtime
        ? `${manifestRes.manifestPath}:${manifestMtime}`
        : manifestRes.manifestPath;
    })();

    // lyc: 获得 插件清单注册表记录
    const record = isBundleRecord
      // lyc: 当前候选插件是捆绑插件记录, 即从覆盖目录(packageRoot/extensions)和roots.stock(packageRoot/.../extensions)中发现的插件
      // lyc: 构建捆绑的 插件清单注册表记录: 基于 当前候选插件的清单文件实例(openclaw.plugin.json | (codex|cursor|claude)-plugin/plugin.json), 清单文件地址, 候选 创建
      ? buildBundleRecord({
          manifest: manifest as Parameters<typeof buildBundleRecord>[0]["manifest"],
          candidate,
          manifestPath: manifestRes.manifestPath,
        })
      // lyc: 构建 插件清单注册表记录: 基于 当前候选插件的清单文件实例(openclaw.plugin.json | (codex|cursor|claude)-plugin/plugin.json), 清单文件地址, 候选, 插件的清单文件.configSchema
      : buildRecord({
          manifest: manifest as PluginManifest,
          candidate,
          manifestPath: manifestRes.manifestPath,
          schemaCacheKey,
          configSchema,
          ...(params.bundledChannelConfigCollector
            ? { bundledChannelConfigCollector: params.bundledChannelConfigCollector }
            : {}),
        });

    const existing = seenIds.get(manifest.id);
    /* lyc: 如果之前处理过相同的 插件清单文件实例id
    它们路径相同 且 当前候选插件的来源(origin)优先级 高于 已存在插件的来源(origin),
      则使用候选插件的记录来覆盖records和seenIds中已存在的记录 并 继续下一个候选插件的处理
    */ 
    if (existing) {
      // Check whether both candidates point to the same physical directory
      // (e.g. via symlinks or different path representations). If so, this
      // is a false-positive duplicate and can be silently skipped.
      // lyc: 检查两个候选路径是否指向同一个物理目录（例如，通过符号链接或不同的路径表示形式）。如果是这样，则这是一个误报的重复项，可以悄无声息地跳过。
      const samePath = existing.candidate.rootDir === candidate.rootDir;
      const samePlugin = (() => {
        if (samePath) {
          return true;
        }
        const existingReal = safeRealpathSync(existing.candidate.rootDir, realpathCache);
        const candidateReal = safeRealpathSync(candidate.rootDir, realpathCache);
        return Boolean(existingReal && candidateReal && existingReal === candidateReal);
      })();
      // lyc: 如果它们路径相同, 且当前候选插件的来源(origin)优先级 高于 已存在插件的来源(origin), 
      // lyc: 则使用候选插件的记录来覆盖records和seenIds中已存在的记录 并 继续下一个候选插件的处理
      if (samePlugin) {
        // Prefer higher-precedence origins even if candidates are passed in
        // an unexpected order (config > workspace > global > bundled).
        // lyc: 即使候选项以非预期的顺序传递，也优先选择优先级更高的来源（config > workspace > global > bundled）。
        // lyc: 如果候选插件的来源(origin)优先级 高于 已存在插件的来源(origin), 数值越小优先级越高
        // lyc: 则使用候选插件的记录来覆盖records和seenIds中已存在的记录
        if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
          records[existing.recordIndex] = record;
          seenIds.set(manifest.id, { candidate, recordIndex: existing.recordIndex });
          // lyc: 向 诊断记录(diagnostics) 中添加插件清单兼容性诊断信息
          pushManifestCompatibilityDiagnostics({ record, diagnostics });
        }
        continue;
      }

      // lyc: 这里代表 之前处理过id相同的插件清单文件实例, 但它们路径不同

      // lyc: 当前候选插件的等级
      const candidateRank = resolveDuplicatePrecedenceRank({
        pluginId: manifest.id,
        candidate,
        config,
        env,
        installRecords: getInstallRecords(),
      });
      // lyc: 已存在插件的等级
      const existingRank = resolveDuplicatePrecedenceRank({
        pluginId: manifest.id,
        candidate: existing.candidate,
        config,
        env,
        installRecords: getInstallRecords(),
      });
      // lyc: 是否当前候选插件的等级更高 (数值最小的获胜)
      const candidateWins = candidateRank < existingRank;
      // lyc: 获胜的候选插件 = 当前候选插件 | 以处理的候选插件 
      const winnerCandidate = candidateWins ? candidate : existing.candidate;
      // lyc: 被覆盖的候选插件 = 以处理的候选插件 | 当前候选插件
      const overriddenCandidate = candidateWins ? existing.candidate : candidate;
      // lyc: 如果当前候选插件的等级更高 (数值最小的获胜)
      // lyc: 则使用候选插件的记录来覆盖records和seenIds中已存在的记录 并向 诊断记录(diagnostics) 中添加插件清单兼容性诊断信息
      if (candidateWins) {
        records[existing.recordIndex] = record;
        seenIds.set(manifest.id, { candidate, recordIndex: existing.recordIndex });
        pushManifestCompatibilityDiagnostics({ record, diagnostics });
      }
      // lyc: 判断是否是 预期的覆盖行为, 是则不需要警告继续处理下一个候选插件
      // lyc: 预期的覆盖行为: left用户安装的插件 覆盖了 right系统捆绑的插件 或 left系统捆绑的插件 覆盖了 right用户安装的插件
      if (
        isIntentionalInstalledBundledDuplicate({
          pluginId: manifest.id,
          left: candidate,
          right: existing.candidate,
          config,
          env,
          installRecords: getInstallRecords(),
        })
      ) {
        continue;
      }

      // lyc: 如果不是预期的覆盖行为, 则添加警告诊断信息
      diagnostics.push({
        level: "warn",
        pluginId: manifest.id,
        source: overriddenCandidate.source,
        // lyc: 检测到重复的插件ID；被覆盖的插件(origin=bundled) 将被 获胜的插件(origin=config)(/path/to/winner_source)所覆盖
        message: `duplicate plugin id detected; ${overriddenCandidate.origin} plugin will be overridden by ${winnerCandidate.origin} plugin (${winnerCandidate.source})`,
      });
      continue;
    }

    // lyc: 这里代表之前没处理过插件清单
    // lyc: 将当前 候选插件(candidate)添加到 seenIds 中 并将 候选插件的记录(record) 添加到records中
    seenIds.set(manifest.id, { candidate, recordIndex: records.length });
    records.push(record);
    // lyc: 向 诊断记录(diagnostics) 中添加插件清单兼容性诊断信息
    pushManifestCompatibilityDiagnostics({ record, diagnostics });
  }

  // lyc: 
  const registry = { plugins: records, diagnostics };
  if (cacheEnabled) {
    const ttl = resolveManifestCacheMs(env);
    if (ttl > 0) {
      registryCache.set(cacheKey, { expiresAt: Date.now() + ttl, registry });
    }
  }
  return registry;
}
