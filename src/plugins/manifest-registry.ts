import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "./config-state.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "./discovery.js";
import { loadPluginManifest, type PluginManifest } from "./manifest.js";
import { safeRealpathSync } from "./path-safety.js";
import type { PluginConfigUiHint, PluginDiagnostic, PluginKind, PluginOrigin } from "./types.js";

type SeenIdEntry = {
  candidate: PluginCandidate;
  recordIndex: number;
};

// Precedence: config > workspace > global > bundled
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
  kind?: PluginKind;
  channels: string[];
  providers: string[];
  skills: string[];
  origin: PluginOrigin;
  workspaceDir?: string;
  rootDir: string;
  source: string;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
};

export type PluginManifestRegistry = {
  plugins: PluginManifestRecord[];
  diagnostics: PluginDiagnostic[];
};

const registryCache = new Map<string, { expiresAt: number; registry: PluginManifestRegistry }>();

const DEFAULT_MANIFEST_CACHE_MS = 200;

export function clearPluginManifestRegistryCache(): void {
  registryCache.clear();
}

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

function shouldUseManifestCache(env: NodeJS.ProcessEnv): boolean {
  const disabled = env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE?.trim();
  if (disabled) {
    return false;
  }
  return resolveManifestCacheMs(env) > 0;
}

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
}): string {
  const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
  // The manifest registry only depends on where plugins are discovered from (workspace + load paths).
  // It does not depend on allow/deny/entries enable-state, so exclude those for higher cache hit rates.
  const loadPaths = params.plugins.loadPaths
    .map((p) => resolveUserPath(p))
    .map((p) => p.trim())
    .filter(Boolean)
    .toSorted();
  return `${workspaceKey}::${JSON.stringify(loadPaths)}`;
}

function safeStatMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function normalizeManifestLabel(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/* lyc:
candidate: discoverOpenClawPlugins()返回值的candiate属性,即发现的插件={
        idHint: package.json.name(最后一个反斜线后的名字)+/+package.json.openclaw.extensions[i]只保留文件名 
                或 extraPath(目录地址)获取路径中最后的名字(即最终目录名)
        source: extraPath(目录地址)+package.json.openclaw.extensions[i]指定的文件 
                或 extraPath(目录地址)+index.ts|js|mjs|cjs
        rootDir: extraPath(目录地址),
        origin: "config", 也可以是"workspace", "bundeled", "global"
        workspaceDir: extraPath(目录地址),
        packageName: package.json.name,
        packageVersion: package.json..version,
        packageDescription: package.json.description,
        packageDir: extraPath(目录地址),
        packageManifest: package.json.openclaw的配置内容,
    } 
manifest: openclaw.plugin.json
manifestPath: openclaw.plugin.json的路径
schemaCacheKey: 缓存key, 基于manifestPath和时间
configSchema: openclaw.plugin.json中的configSchema属性
*/
function buildRecord(params: {
  manifest: PluginManifest;
  candidate: PluginCandidate;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
}): PluginManifestRecord {
  return {
    id: params.manifest.id,
    name: normalizeManifestLabel(params.manifest.name) ?? params.candidate.packageName,
    description:
      normalizeManifestLabel(params.manifest.description) ?? params.candidate.packageDescription,
    version: normalizeManifestLabel(params.manifest.version) ?? params.candidate.packageVersion,
    kind: params.manifest.kind,
    channels: params.manifest.channels ?? [],
    providers: params.manifest.providers ?? [],
    skills: params.manifest.skills ?? [],
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    manifestPath: params.manifestPath,
    schemaCacheKey: params.schemaCacheKey,
    configSchema: params.configSchema,
    configUiHints: params.manifest.uiHints,
  };
}

/* lyc: 加载plugins的manifest
  1. discoverOpenClawPlugins: 从params.workspaceDir和params.config.plugins.load.paths[]中搜索插件package.json中openclaw.extensions配置并加载plugins
  2. 再从discoverOpenClawPlugins加载的每一个插件跟目录(rootDir)下加载openclaw.plugin.json(manifest), 将其记录在records中
  3. 返回: { plugins: records, discoverOpenClawPlugins.diagnostics };
 */
export function loadPluginManifestRegistry(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  cache?: boolean;
  env?: NodeJS.ProcessEnv;
  candidates?: PluginCandidate[];
  diagnostics?: PluginDiagnostic[];
}): PluginManifestRegistry {
  const config = params.config ?? {};
  // lyc: 归一化plugins配置
  const normalized = normalizePluginsConfig(config.plugins);
  // lyc: 构建缓存key, 基于workspaceDir和loadPaths(config.plugins.load.paths[])
  const cacheKey = buildCacheKey({ workspaceDir: params.workspaceDir, plugins: normalized });
  const env = params.env ?? process.env;
  const cacheEnabled = params.cache !== false && shouldUseManifestCache(env);
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.registry;
    }
  }

  // lyc: 发现plugins, 在workspaceDir和extraPaths=loadPaths(config.plugins.load.paths[])中搜索
  const discovery = params.candidates
    ? {
        candidates: params.candidates,
        diagnostics: params.diagnostics ?? [],
      }
    : discoverOpenClawPlugins({
        workspaceDir: params.workspaceDir,
        extraPaths: normalized.loadPaths,
      });
  const diagnostics: PluginDiagnostic[] = [...discovery.diagnostics];
  const candidates: PluginCandidate[] = discovery.candidates;
  const records: PluginManifestRecord[] = [];
  const seenIds = new Map<string, SeenIdEntry>();
  const realpathCache = new Map<string, string>();

  /* lyc: 加载已发现的plugins的manifest*/
  for (const candidate of candidates) {
    const rejectHardlinks = candidate.origin !== "bundled";
    // lyc: 加载当前发现的plugin(candidate)的manifest(candidate.rootDir/openclaw.plugin.json)
    const manifestRes = loadPluginManifest(candidate.rootDir, rejectHardlinks);
    if (!manifestRes.ok) {
      diagnostics.push({
        level: "error",
        message: manifestRes.error,
        source: manifestRes.manifestPath,
      });
      continue;
    }
    const manifest = manifestRes.manifest;
    // lyc: 当前发现的plugin(candidate)的idHint与当前plugin的manifest.id不一致, 仅添加诊断信息(diagnostics)
    if (candidate.idHint && candidate.idHint !== manifest.id) {
      diagnostics.push({
        level: "warn",
        pluginId: manifest.id,
        source: candidate.source,
        message: `plugin id mismatch (manifest uses "${manifest.id}", entry hints "${candidate.idHint}")`,
      });
    }

    const configSchema = manifest.configSchema;
    // lyc: 构建缓存key, 基于manifestPath和mtimeMs
    const schemaCacheKey = (() => {
      if (!configSchema) {
        return undefined;
      }
      const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
      return manifestMtime
        ? `${manifestRes.manifestPath}:${manifestMtime}`
        : manifestRes.manifestPath;
    })();

    // lyc: 是否处理过当前manifest
    const existing = seenIds.get(manifest.id);
    if (existing) {
      // Check whether both candidates point to the same physical directory
      // (e.g. via symlinks or different path representations). If so, this
      // is a false-positive duplicate and can be silently skipped.
      // lyc:  检查两个候选路径是否指向同一个物理目录（例如，通过符号链接或不同的路径表示形式）。如果是，则这是一个误报的重复项，可以静默跳过。
      // lyc: 之前处理过的plugin(existing.candidate)的rootDir与当前发现的plugin(candidate)的rootDir一致
      const samePath = existing.candidate.rootDir === candidate.rootDir;
      /* lyc: 是否是同一个plugin
        之前处理过的plugin(existing.candidate)的rootDir与当前发现的plugin(candidate)的rootDir一致
        或它们的真实路径一致, 则认为是一个plugin
      */
      const samePlugin = (() => {
        if (samePath) {
          return true;
        }
        // lyc: 之前处理过的plugin(existing.candidate)的rootDir的绝对路径
        const existingReal = safeRealpathSync(existing.candidate.rootDir, realpathCache);
        // lyc: 当前发现的plugin(candidate)的rootDir的绝对路径
        const candidateReal = safeRealpathSync(candidate.rootDir, realpathCache);
        return Boolean(existingReal && candidateReal && existingReal === candidateReal);
      })();
      // lyc: 当前plugin和之前处理过的plugin(existing.candidate)是同一个plugin
      if (samePlugin) {
        // Prefer higher-precedence origins even if candidates are passed in
        // an unexpected order (config > workspace > global > bundled).
        // lyc: 即使候选项以非预期的顺序传递，也优先选择优先级更高的来源（配置文件 > 工作区 > 全局 > 捆绑）。
        // 当前plugin的origin优先级比之前处理过的plugin(existing.candidate)的origin优先级高
        if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
          // lyc: records更新当前plugin的manifest
          records[existing.recordIndex] = buildRecord({
            manifest,
            candidate,
            manifestPath: manifestRes.manifestPath,
            schemaCacheKey,
            configSchema,
          });
          // lyc: seenIds更新当前manifest
          seenIds.set(manifest.id, { candidate, recordIndex: existing.recordIndex });
        }
        continue;
      }
      // lyc: id一样但不是同一个plugin manifest, 仅添加诊断信息(diagnostics)
      diagnostics.push({
        level: "warn",
        pluginId: manifest.id,
        source: candidate.source,
        message: `duplicate plugin id detected; later plugin may be overridden (${candidate.source})`,
      });
    } else {
      // lyc: 第一次处理当前manifest, recordIndex记录了当前manifest在records中的索引
      seenIds.set(manifest.id, { candidate, recordIndex: records.length });
    }

    // lyc: records添加当前manifest
    records.push(
      buildRecord({
        manifest,
        candidate,
        manifestPath: manifestRes.manifestPath,
        schemaCacheKey,
        configSchema,
      }),
    );
  }

  const registry = { plugins: records, diagnostics };
  if (cacheEnabled) {
    const ttl = resolveManifestCacheMs(env);
    if (ttl > 0) {
      registryCache.set(cacheKey, { expiresAt: Date.now() + ttl, registry });
    }
  }
  return registry;
}
