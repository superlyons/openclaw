import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tryReadJsonSync } from "../infra/json-files.js";
import { collectBundledChannelConfigs } from "./bundled-channel-config-metadata.js";
import {
  collectBundledPluginPublicSurfaceArtifacts,
  collectBundledPluginRuntimeSidecarArtifacts,
  deriveBundledPluginIdHint,
  normalizeBundledPluginStringList,
  rewriteBundledPluginEntryToBuiltPath,
  resolveBundledPluginScanDir,
  trimBundledPluginString,
} from "./bundled-plugin-scan.js";
import {
  getPackageManifestMetadata,
  loadPluginManifest,
  type OpenClawPackageManifest,
  type PackageManifest,
  type PluginManifest,
} from "./manifest.js";
import { resolveLoaderPackageRoot } from "./sdk-alias.js";

// lyc: 解析加载器模块的 根package.json 所在的目录, 从modulePath, argv1, cwd, moduleUrl 中获取
// lyc: 如果无法解析, 则返回当前模块的目录
const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
// lyc: 从已构建工件中运行: 当前文件是否在 dist 或 dist-runtime 目录下则代表从已构建工件中运行
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

type BundledPluginPathPair = {
  source: string;
  built: string;
};

export type BundledPluginMetadata = {
  dirName: string;
  idHint: string;
  source: BundledPluginPathPair;
  setupSource?: BundledPluginPathPair;
  publicSurfaceArtifacts?: readonly string[];
  runtimeSidecarArtifacts?: readonly string[];
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageManifest?: OpenClawPackageManifest;
  manifest: PluginManifest;
};

// lyc:aic v2026.5：删除了 bundledPluginMetadataCache (Map) 及 clearBundledPluginMetadataCache 函数——
//                  upstream 把缓存策略改到调用方层面（避免全局状态）
// lyc: 读取插件的 package.json 文件, 并解析为 PackageManifest 实例对象
function readPackageManifest(pluginDir: string): PackageManifest | undefined {
  const packagePath = path.join(pluginDir, "package.json");
  return tryReadJsonSync<PackageManifest>(packagePath) ?? undefined;
}

// lyc: 解析捆绑插件元数据扫描目录, 如果提供了scanDir, 则返回该目录, 否则返回捆绑插件的扫描目录
// lyc: packageRoot 目录下的 extensions | dist-runtime/extensions | dist/extensions | undefined 目录
function resolveBundledPluginMetadataScanDir(
  packageRoot: string,
  scanDir?: string,
): string | undefined {
  if (scanDir) {
    return path.resolve(scanDir);
  }
  return resolveBundledPluginScanDir({
    packageRoot,
    runningFromBuiltArtifact: RUNNING_FROM_BUILT_ARTIFACT,
  });
}

function resolveBundledPluginLookupParams(params: { rootDir: string; scanDir?: string }): {
  rootDir: string;
  scanDir?: string;
} {
  return params.scanDir ? params : { rootDir: params.rootDir };
}

// lyc: 收集捆绑插件元数据
function collectBundledPluginMetadata(
  resolvedScanDir: string | undefined,
  includeChannelConfigs: boolean,
  includeSyntheticChannelConfigs: boolean,
): readonly BundledPluginMetadata[] {
  // lyc:aic v2026.5：把"扫描目录解析 + 不存在检查"的责任上移到了调用方（参数直接传 resolvedScanDir），
  //                  本函数只负责"扫描已知目录"
  // lyc: 如果扫描目录不存在, 则返回空数组
  if (!resolvedScanDir || !fs.existsSync(resolvedScanDir)) {
    return [];
  }

  const entries: BundledPluginMetadata[] = [];
  // lyc: 遍历扫描目录下的所有子目录, 并收集插件元数据
  for (const dirName of fs
    .readdirSync(resolvedScanDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right))) {
    const pluginDir = path.join(resolvedScanDir, dirName);
    // lyc: 加载插件元数据 rootDir/openclaw.plugin.json 文件的实例对象
    const manifestResult = loadPluginManifest(pluginDir, false);
    if (!manifestResult.ok) {
      continue;
    }
    // lyc: 读取插件的 rootDir/package.json 文件, 并解析为 OpenClawPackageManifest 实例对象

    const packageJson = readPackageManifest(pluginDir);
    const packageManifest = getPackageManifestMetadata(packageJson);
    const extensions = normalizeBundledPluginStringList(packageManifest?.extensions);
    if (extensions.length === 0) {
      continue;
    }
    const sourceEntry = trimBundledPluginString(extensions[0]);
    const builtEntry = rewriteBundledPluginEntryToBuiltPath(sourceEntry);
    if (!sourceEntry || !builtEntry) {
      continue;
    }

    const setupSourcePath = trimBundledPluginString(packageManifest?.setupEntry);
    const setupSource =
      setupSourcePath && rewriteBundledPluginEntryToBuiltPath(setupSourcePath)
        ? {
            source: setupSourcePath,
            built: rewriteBundledPluginEntryToBuiltPath(setupSourcePath)!,
          }
        : undefined;
    const publicSurfaceArtifacts = collectBundledPluginPublicSurfaceArtifacts({
      pluginDir,
      sourceEntry,
      ...(setupSourcePath ? { setupEntry: setupSourcePath } : {}),
    });
    const runtimeSidecarArtifacts =
      collectBundledPluginRuntimeSidecarArtifacts(publicSurfaceArtifacts);
    const channelConfigs =
      includeChannelConfigs && includeSyntheticChannelConfigs
        ? collectBundledChannelConfigs({
            pluginDir,
            manifest: manifestResult.manifest,
            packageManifest,
          })
        : manifestResult.manifest.channelConfigs;

    entries.push({
      dirName,
      idHint: deriveBundledPluginIdHint({
        entryPath: sourceEntry,
        manifestId: manifestResult.manifest.id,
        packageName: trimBundledPluginString(packageJson?.name),
        hasMultipleExtensions: extensions.length > 1,
      }),
      source: {
        source: sourceEntry,
        built: builtEntry,
      },
      ...(setupSource ? { setupSource } : {}),
      ...(publicSurfaceArtifacts ? { publicSurfaceArtifacts } : {}),
      ...(runtimeSidecarArtifacts ? { runtimeSidecarArtifacts } : {}),
      ...(trimBundledPluginString(packageJson?.name)
        ? { packageName: trimBundledPluginString(packageJson?.name) }
        : {}),
      ...(trimBundledPluginString(packageJson?.version)
        ? { packageVersion: trimBundledPluginString(packageJson?.version) }
        : {}),
      ...(trimBundledPluginString(packageJson?.description)
        ? { packageDescription: trimBundledPluginString(packageJson?.description) }
        : {}),
      ...(packageManifest ? { packageManifest } : {}),
      manifest: {
        ...manifestResult.manifest,
        ...(channelConfigs ? { channelConfigs } : {}),
      },
    });
  }

  return entries;
}
// lyc: 列出捆绑插件元数据

export function listBundledPluginMetadata(params?: {
  rootDir?: string;
  scanDir?: string;
  includeChannelConfigs?: boolean;
  includeSyntheticChannelConfigs?: boolean;
}): readonly BundledPluginMetadata[] {
  // lyc: 根package.json 所在的目录
  const rootDir = path.resolve(params?.rootDir ?? OPENCLAW_PACKAGE_ROOT);
  const scanDir = params?.scanDir ? path.resolve(params.scanDir) : undefined;
  // lyc: 解析捆绑插件元数据扫描目录（v2026.5 把这一步从 collectBundledPluginMetadata 内部挪到了调用方）
  const resolvedScanDir = resolveBundledPluginMetadataScanDir(rootDir, scanDir);
  // lyc: !RUNNING_FROM_BUILT_ARTIFACT: 如果是在已构建的代码中运行, 则不包含通道配置
  const includeChannelConfigs = params?.includeChannelConfigs ?? !RUNNING_FROM_BUILT_ARTIFACT;
  // lyc: includeSyntheticChannelConfigs: 是否包含合成通道配置
  const includeSyntheticChannelConfigs =
    params?.includeSyntheticChannelConfigs ?? includeChannelConfigs;
  const metadata = Object.freeze(
    collectBundledPluginMetadata(
      resolvedScanDir,
      includeChannelConfigs,
      includeSyntheticChannelConfigs,
    ),
  );
  return metadata;
}

export function findBundledPluginMetadataById(
  pluginId: string,
  params?: {
    rootDir?: string;
    scanDir?: string;
    includeChannelConfigs?: boolean;
    includeSyntheticChannelConfigs?: boolean;
  },
): BundledPluginMetadata | undefined {
  return listBundledPluginMetadata(params).find((entry) => entry.manifest.id === pluginId);
}

export function resolveBundledPluginWorkspaceSourcePath(params: {
  rootDir: string;
  scanDir?: string;
  pluginId: string;
}): string | null {
  const metadata = findBundledPluginMetadataById(params.pluginId, {
    ...resolveBundledPluginLookupParams({
      rootDir: params.rootDir,
      scanDir: params.scanDir,
    }),
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  });
  if (!metadata) {
    return null;
  }
  if (params.scanDir) {
    return path.resolve(params.scanDir, metadata.dirName);
  }
  return path.resolve(params.rootDir, "extensions", metadata.dirName);
}

function listBundledPluginEntryBaseDirs(params: {
  rootDir: string;
  pluginDirName?: string;
  scanDir?: string;
}): string[] {
  const baseDirs = [
    ...(params.scanDir ? [path.resolve(params.scanDir, params.pluginDirName ?? "")] : []),
    path.resolve(params.rootDir, "dist", "extensions", params.pluginDirName ?? ""),
    path.resolve(params.rootDir, "dist-runtime", "extensions", params.pluginDirName ?? ""),
    path.resolve(params.rootDir, "extensions", params.pluginDirName ?? ""),
  ];
  return baseDirs.filter((entry, index, all) => all.indexOf(entry) === index);
}

export function resolveBundledPluginGeneratedPath(
  rootDir: string,
  entry: BundledPluginPathPair | undefined,
  pluginDirName?: string,
  scanDir?: string,
): string | null {
  if (!entry) {
    return null;
  }
  const entryOrder = [entry.built, entry.source].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  const baseDirs = listBundledPluginEntryBaseDirs({
    rootDir,
    pluginDirName,
    ...(scanDir ? { scanDir } : {}),
  });
  for (const baseDir of baseDirs) {
    for (const entryPath of entryOrder) {
      const candidate = resolveBundledPluginEntryCandidate(baseDir, entryPath);
      if (!candidate) {
        continue;
      }
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function normalizeRelativePluginEntryPath(entryPath: string): string {
  return entryPath.replace(/^\.\//u, "");
}

function resolveBundledPluginEntryCandidate(baseDir: string, entryPath: string): string | null {
  const normalizedEntryPath = normalizeRelativePluginEntryPath(entryPath);
  const candidate = path.isAbsolute(normalizedEntryPath)
    ? path.normalize(normalizedEntryPath)
    : path.resolve(baseDir, normalizedEntryPath);
  const relative = path.relative(baseDir, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}

export function resolveBundledPluginRepoEntryPath(params: {
  rootDir: string;
  pluginId: string;
  preferBuilt?: boolean;
  scanDir?: string;
}): string | null {
  const metadata = findBundledPluginMetadataById(params.pluginId, {
    ...resolveBundledPluginLookupParams({
      rootDir: params.rootDir,
      scanDir: params.scanDir,
    }),
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  });
  if (!metadata) {
    return null;
  }

  const entryOrder = params.preferBuilt
    ? [metadata.source.built, metadata.source.source]
    : [metadata.source.source, metadata.source.built];
  const baseDirs = listBundledPluginEntryBaseDirs({
    rootDir: params.rootDir,
    pluginDirName: metadata.dirName,
    ...(params.scanDir ? { scanDir: params.scanDir } : {}),
  });

  for (const baseDir of baseDirs) {
    for (const entryPath of entryOrder) {
      const candidate = resolveBundledPluginEntryCandidate(baseDir, entryPath);
      if (!candidate) {
        continue;
      }
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
