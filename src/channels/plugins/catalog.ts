import fs from "node:fs";
import path from "node:path";
import { MANIFEST_KEY } from "../../compat/legacy-names.js";
import { discoverOpenClawPlugins } from "../../plugins/discovery.js";
import type { OpenClawPackageManifest } from "../../plugins/manifest.js";
import type { PluginOrigin } from "../../plugins/types.js";
import { CONFIG_DIR, isRecord, resolveUserPath } from "../../utils.js";
import type { ChannelMeta } from "./types.js";

export type ChannelUiMetaEntry = {
  id: string;
  label: string;
  detailLabel: string;
  systemImage?: string;
};

export type ChannelUiCatalog = {
  entries: ChannelUiMetaEntry[];
  order: string[];
  labels: Record<string, string>;
  detailLabels: Record<string, string>;
  systemImages: Record<string, string>;
  byId: Record<string, ChannelUiMetaEntry>;
};

export type ChannelPluginCatalogEntry = {
  id: string;
  meta: ChannelMeta;
  install: {
    npmSpec: string;
    localPath?: string;
    defaultChoice?: "npm" | "local";
  };
};

type CatalogOptions = {
  workspaceDir?: string;
  catalogPaths?: string[];
};

const ORIGIN_PRIORITY: Record<PluginOrigin, number> = {
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

type ExternalCatalogEntry = {
  name?: string;
  version?: string;
  description?: string;
} & Partial<Record<ManifestKey, OpenClawPackageManifest>>;

const DEFAULT_CATALOG_PATHS = [
  path.join(CONFIG_DIR, "mpm", "plugins.json"),
  path.join(CONFIG_DIR, "mpm", "catalog.json"),
  path.join(CONFIG_DIR, "plugins", "catalog.json"),
];

const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];

type ManifestKey = typeof MANIFEST_KEY;

// lyc: 解析外部插件目录条目, raw是Array(ExternalCatalogEntry)类型
function parseCatalogEntries(raw: unknown): ExternalCatalogEntry[] {
  if (Array.isArray(raw)) {
    // lyc: 如果raw是数组, 则过滤出所有ExternalCatalogEntry类型的元素, 注意是多个ExternalCatalogEntry类型的元素不是一个
    return raw.filter((entry): entry is ExternalCatalogEntry => isRecord(entry));
  }
  if (!isRecord(raw)) {
    return [];
  }
  const list = raw.entries ?? raw.packages ?? raw.plugins;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is ExternalCatalogEntry => isRecord(entry));
}

function splitEnvPaths(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/[;,]/g)
    .flatMap((chunk) => chunk.split(path.delimiter))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// lyc: 获得外部插件目录条目地址: 从入参options.catalogPaths获取 或 环境变量OPENCLAW_PLUGIN_CATALOG_PATHS|OPENCLAW_MPM_CATALOG_PATHS 中获取 或 DEFAULT_CATALOG_PATHS 获取
// 默认为DEFAULT_CATALOG_PATHS: resolveConfigDir函数(home目录/.openclaw/) + {mpm/plugins.json, mpm/catalog.json, plugins/catalog.json}
function resolveExternalCatalogPaths(options: CatalogOptions): string[] {
  if (options.catalogPaths && options.catalogPaths.length > 0) {
    return options.catalogPaths.map((entry) => entry.trim()).filter(Boolean);
  }
  for (const key of ENV_CATALOG_PATHS) {
    const raw = process.env[key];
    if (raw && raw.trim()) {
      return splitEnvPaths(raw);
    }
  }
  return DEFAULT_CATALOG_PATHS;
}

// lyc: 加载外部插件目录条目
function loadExternalCatalogEntries(options: CatalogOptions): ExternalCatalogEntry[] {
  const paths = resolveExternalCatalogPaths(options);
  const entries: ExternalCatalogEntry[] = [];
  for (const rawPath of paths) {
    const resolved = resolveUserPath(rawPath);
    if (!fs.existsSync(resolved)) {
      continue;
    }
    try {
      const payload = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
      entries.push(...parseCatalogEntries(payload));
    } catch {
      // Ignore invalid catalog files.
    }
  }
  return entries;
}

function toChannelMeta(params: {
  channel: NonNullable<OpenClawPackageManifest["channel"]>;
  id: string;
}): ChannelMeta | null {
  const label = params.channel.label?.trim();
  if (!label) {
    return null;
  }
  const selectionLabel = params.channel.selectionLabel?.trim() || label;
  const detailLabel = params.channel.detailLabel?.trim();
  const docsPath = params.channel.docsPath?.trim() || `/channels/${params.id}`;
  const blurb = params.channel.blurb?.trim() || "";
  const systemImage = params.channel.systemImage?.trim();

  return {
    id: params.id,
    label,
    selectionLabel,
    ...(detailLabel ? { detailLabel } : {}),
    docsPath,
    docsLabel: params.channel.docsLabel?.trim() || undefined,
    blurb,
    ...(params.channel.aliases ? { aliases: params.channel.aliases } : {}),
    ...(params.channel.preferOver ? { preferOver: params.channel.preferOver } : {}),
    ...(params.channel.order !== undefined ? { order: params.channel.order } : {}),
    ...(params.channel.selectionDocsPrefix
      ? { selectionDocsPrefix: params.channel.selectionDocsPrefix }
      : {}),
    ...(params.channel.selectionDocsOmitLabel !== undefined
      ? { selectionDocsOmitLabel: params.channel.selectionDocsOmitLabel }
      : {}),
    ...(params.channel.selectionExtras ? { selectionExtras: params.channel.selectionExtras } : {}),
    ...(systemImage ? { systemImage } : {}),
    ...(params.channel.showConfigured !== undefined
      ? { showConfigured: params.channel.showConfigured }
      : {}),
    ...(params.channel.quickstartAllowFrom !== undefined
      ? { quickstartAllowFrom: params.channel.quickstartAllowFrom }
      : {}),
    ...(params.channel.forceAccountBinding !== undefined
      ? { forceAccountBinding: params.channel.forceAccountBinding }
      : {}),
    ...(params.channel.preferSessionLookupForAnnounceTarget !== undefined
      ? {
          preferSessionLookupForAnnounceTarget: params.channel.preferSessionLookupForAnnounceTarget,
        }
      : {}),
  };
}

function resolveInstallInfo(params: {
  manifest: OpenClawPackageManifest;
  packageName?: string;
  packageDir?: string;
  workspaceDir?: string;
}): ChannelPluginCatalogEntry["install"] | null {
  const npmSpec = params.manifest.install?.npmSpec?.trim() ?? params.packageName?.trim();
  if (!npmSpec) {
    return null;
  }
  let localPath = params.manifest.install?.localPath?.trim() || undefined;
  if (!localPath && params.workspaceDir && params.packageDir) {
    localPath = path.relative(params.workspaceDir, params.packageDir) || undefined;
  }
  const defaultChoice = params.manifest.install?.defaultChoice ?? (localPath ? "local" : "npm");
  return {
    npmSpec,
    ...(localPath ? { localPath } : {}),
    ...(defaultChoice ? { defaultChoice } : {}),
  };
}

// lyc: 从packageManifest(来自配置文件)中获取插件配置内容包括: {id: channel.id, meta: channelMeta, install: installInfo} 缺少任意一个, 则返回null
function buildCatalogEntry(candidate: {
  packageName?: string;
  packageDir?: string;
  workspaceDir?: string;
  packageManifest?: OpenClawPackageManifest;
}): ChannelPluginCatalogEntry | null {
  const manifest = candidate.packageManifest;
  if (!manifest?.channel) {
    return null;
  }
  const id = manifest.channel.id?.trim();
  if (!id) {
    return null;
  }
  const meta = toChannelMeta({ channel: manifest.channel, id });
  if (!meta) {
    return null;
  }
  const install = resolveInstallInfo({
    manifest,
    packageName: candidate.packageName,
    packageDir: candidate.packageDir,
    workspaceDir: candidate.workspaceDir,
  });
  if (!install) {
    return null;
  }
  return { id, meta, install };
}

function buildExternalCatalogEntry(entry: ExternalCatalogEntry): ChannelPluginCatalogEntry | null {
  const manifest = entry[MANIFEST_KEY];
  return buildCatalogEntry({
    packageName: entry.name,
    packageManifest: manifest,
  });
}

export function buildChannelUiCatalog(
  plugins: Array<{ id: string; meta: ChannelMeta }>,
): ChannelUiCatalog {
  const entries: ChannelUiMetaEntry[] = plugins.map((plugin) => {
    const detailLabel = plugin.meta.detailLabel ?? plugin.meta.selectionLabel ?? plugin.meta.label;
    return {
      id: plugin.id,
      label: plugin.meta.label,
      detailLabel,
      ...(plugin.meta.systemImage ? { systemImage: plugin.meta.systemImage } : {}),
    };
  });
  const order = entries.map((entry) => entry.id);
  const labels: Record<string, string> = {};
  const detailLabels: Record<string, string> = {};
  const systemImages: Record<string, string> = {};
  const byId: Record<string, ChannelUiMetaEntry> = {};
  for (const entry of entries) {
    labels[entry.id] = entry.label;
    detailLabels[entry.id] = entry.detailLabel;
    if (entry.systemImage) {
      systemImages[entry.id] = entry.systemImage;
    }
    byId[entry.id] = entry;
  }
  return { entries, order, labels, detailLabels, systemImages, byId };
}

/* lyc: 
  列出插件的渠道(Channel Plugin)目录条目
  resolved = {
    manifest.channel.id: {
      插件来自:
      - 通过discoverOpenClawPlugins发现的插件:
        - 指定的符合要求的扩展文件, 无package信息(packageManifest 简称manifest)
        - .../.openclaw/extensions/package.json中openclaw.extensions中配置的符合要求的扩展文件, package信息为package.json.openclaw内容(packageManifest 简称manifest)
        - .../.openclaw/extensions下符合要求的扩展文件, package信息为package.json.openclaw内容(packageManifest 简称manifest)
      - 通过外部插件目录条目发现的插件(优先级最低):
        - 入参options.catalogPaths[]指定的文件
        - 环境变量OPENCLAW_PLUGIN_CATALOG_PATHS|OPENCLAW_MPM_CATALOG_PATHS中指定的文件
        - DEFAULT_CATALOG_PATHS: resolveConfigDir函数返回的目录/(mpm/plugins.json | mpm/catalog.json | plugins/catalog.json)
      从插件的manifest配置信息中获取频道目录条目
      entry: ChannelPluginCatalogEntry {
        id: manifest.channel.id
        meta: ChannelMeta = manifest.channel
        install?: {
          npmSpec: manifest.install.npmSpec | package.json.name
          localPath: manifest.install.localPath | 插件所在目录 | undefined
          defaultChoice: "npm" | "local"; manifest.install?.defaultChoice | localPath ? "local" : "npm"
        }
      }
      priority: 优先级
    }
  , ...}
 */
export function listChannelPluginCatalogEntries(
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry[] {
  // lyc: 发现openclaw插件
  const discovery = discoverOpenClawPlugins({ workspaceDir: options.workspaceDir });
  const resolved = new Map<string, { entry: ChannelPluginCatalogEntry; priority: number }>();
  // lyc: discovery.candidates是发现的插件候选列表, 发现插件的目的是为了加载其渠道目录条目ChannelPluginCatalogEntry
  for (const candidate of discovery.candidates) {
    // lyc: 从配置文件中获取插件配置内容包括: {id: channel.id, meta: channelMeta, install: installInfo}
    const entry = buildCatalogEntry(candidate);
    if (!entry) {
      continue;
    }
    // lyc: 通过candidate.origin获取插件优先级, 数值越小, 优先级越高, config > workspace > bundled > global
    const priority = ORIGIN_PRIORITY[candidate.origin] ?? 99;
    // lyc: 是否已被解析过
    const existing = resolved.get(entry.id);
    // lyc: 如果插件不存在(没有被解析过), 或优先级更高, 则添加插件
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

  // lyc: 加载外部插件目录条目, 外部插件目录条目优先级最低
  const externalEntries = loadExternalCatalogEntries(options)
    .map((entry) => buildExternalCatalogEntry(entry))
    .filter((entry): entry is ChannelPluginCatalogEntry => Boolean(entry));
  for (const entry of externalEntries) {
    if (!resolved.has(entry.id)) {
      resolved.set(entry.id, { entry, priority: 99 });
    }
  }
  // lyc: 按插件优先级排序
  return Array.from(resolved.values())
    .map(({ entry }) => entry)
    .toSorted((a, b) => {
      const orderA = a.meta.order ?? 999;
      const orderB = b.meta.order ?? 999;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return a.meta.label.localeCompare(b.meta.label);
    });
}

export function getChannelPluginCatalogEntry(
  id: string,
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry | undefined {
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  return listChannelPluginCatalogEntries(options).find((entry) => entry.id === trimmed);
}
