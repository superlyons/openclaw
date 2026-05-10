import path from "node:path";
import { isPathInside } from "./path-safety.js";

export type BundledPluginLoadPathAliasKind = "current" | "legacy";

export type BundledPluginLoadPathAlias = {
  kind: BundledPluginLoadPathAliasKind;
  path: string;
};

const PACKAGED_BUNDLED_ROOTS = [
  path.join("dist", "extensions"),
  path.join("dist-runtime", "extensions"),
] as const;

export function normalizeBundledLookupPath(targetPath: string): string {
  const normalized = path.normalize(targetPath);
  const root = path.parse(normalized).root;
  let trimmed = normalized;
  while (trimmed.length > root.length && (trimmed.endsWith(path.sep) || trimmed.endsWith("/"))) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/* lyc: 查找OpenClaw插件的packageRoot(插件打包根目录)和bundledRoot(插件捆绑根目录), 不符合要求的路径返回null
localPath 必须以 marker路径(dist/extensions或dist-runtime/extensions) 结尾
packageRoot: 插件打包根目录, 值为 localPath 中的 marker路径之前的路径
bundledRoot: 插件捆绑根目录, 值为 localPath 去掉最后反斜线
*/
function findPackagedBundledRoot(localPath: string): {
  packageRoot: string;
  bundledRoot: string;
} | null {
  const normalized = normalizeBundledLookupPath(localPath);
  for (const packagedRoot of PACKAGED_BUNDLED_ROOTS) {
    const marker = `${path.sep}${packagedRoot}`;
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex === -1) {
      continue;
    }
    const markerEnd = markerIndex + marker.length;
    if (normalized.length !== markerEnd && normalized[markerEnd] !== path.sep) {
      continue;
    }
    return {
      packageRoot: normalized.slice(0, markerIndex),
      bundledRoot: normalized.slice(0, markerEnd),
    };
  }
  return null;
}

export function buildLegacyBundledPath(localPath: string): string | null {
  const packaged = findPackagedBundledRoot(localPath);
  if (!packaged) {
    return null;
  }
  const normalized = normalizeBundledLookupPath(localPath);
  const bundledLeaf =
    normalized === packaged.bundledRoot
      ? ""
      : normalized.slice(packaged.bundledRoot.length + path.sep.length);
  return bundledLeaf ? path.join(packaged.packageRoot, "extensions", bundledLeaf) : null;
}

export function buildLegacyBundledRootPath(localPath: string): string | null {
  const packaged = findPackagedBundledRoot(localPath);
  return packaged ? path.join(packaged.packageRoot, "extensions") : null;
}

export function buildBundledPluginLoadPathAliases(localPath: string): BundledPluginLoadPathAlias[] {
  const legacyPath = buildLegacyBundledPath(localPath);
  if (!legacyPath) {
    return [];
  }
  return [
    { kind: "current", path: localPath },
    { kind: "legacy", path: legacyPath },
  ];
}

function isSameOrInside(baseDir: string, targetPath: string): boolean {
  const base = path.resolve(normalizeBundledLookupPath(baseDir));
  const target = path.resolve(normalizeBundledLookupPath(targetPath));
  return target === base || isPathInside(base, target);
}

// lyc: 解析OpenClaw插件的捆绑加载路径别名: loadPath是具体插件的加载路径, 判断这个路径是否在bundledRoot(插件捆绑根目录)或legacyRoot(遗留的插件捆绑根目录)中
// lyc: 即loadPath在bundledRoot中, 则kind=current, 在legacyRoot中, 则kind=legacy, 同时返回{kind, path: loadPath}, 否则返回null
export function resolvePackagedBundledLoadPathAlias(params: {
  bundledRoot?: string;
  loadPath: string;
}): BundledPluginLoadPathAlias | null {
  if (!params.bundledRoot) {
    return null;
  }
  // lyc: 查找OpenClaw插件的packageRoot(插件打包根目录)和bundledRoot(插件捆绑根目录), 不符合要求的路径返回null
  const packaged = findPackagedBundledRoot(params.bundledRoot);
  if (!packaged) {
    return null;
  }
  // lyc: 遗留的插件捆绑根目录(packageRoot/extensions)
  const legacyRoot = path.join(packaged.packageRoot, "extensions");
  // lyc: loadPath是具体插件的加载路径, 如果这个路径在bundledRoot(插件捆绑根目录)(dist/extensions或dist-runtime/extensions)中, 则kind=current
  if (isSameOrInside(params.bundledRoot, params.loadPath)) {
    return { kind: "current", path: params.loadPath };
  }
  // lyc: 如果loadPath在legacyRoot(遗留的插件捆绑根目录)中, 则kind=legacy
  if (isSameOrInside(legacyRoot, params.loadPath)) {
    return { kind: "legacy", path: params.loadPath };
  }
  // lyc: loadPath不在bundledRoot或legacyRoot中, 返回null
  return null;
}
