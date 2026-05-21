import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function toPosixPath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function readJsonFile(filePath, fsImpl) {
  return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
}

function normalizePackageRelativePath(value) {
  const normalized = toPosixPath(value)
    .trim()
    .replace(/^\.\/+/u, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) {
    return "";
  }
  return normalized;
}

function listTrackedExtensionPackageDirs(rootDir, fsImpl) {
  if (fsImpl !== fs) {
    return null;
  }
  const result = spawnSync("git", ["ls-files", "--", ":(glob)extensions/*/package.json"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => toPosixPath(line.trim()))
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = /^extensions\/([^/]+)\/package\.json$/u.exec(line);
      if (!match?.[1]) {
        return [];
      }
      const packageDir = path.join(rootDir, "extensions", match[1]);
      return [
        {
          dirName: match[1],
          hasPackageJson: true,
          packageDir,
          packageJsonPath: path.join(packageDir, "package.json"),
        },
      ];
    })
    .toSorted((left, right) => left.dirName.localeCompare(right.dirName));
}

function listExtensionPackageDirs(rootDir, fsImpl) {
  const trackedDirs = listTrackedExtensionPackageDirs(rootDir, fsImpl);
  if (trackedDirs) {
    return trackedDirs;
  }

  const extensionsRoot = path.join(rootDir, "extensions");
  if (!fsImpl.existsSync(extensionsRoot)) {
    return [];
  }
  return fsImpl
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      dirName: entry.name,
      hasPackageJson: undefined,
      packageDir: path.join(extensionsRoot, entry.name),
      packageJsonPath: path.join(extensionsRoot, entry.name, "package.json"),
    }))
    .toSorted((left, right) => left.dirName.localeCompare(right.dirName));
}

function listDistExtensionPackageDirs(rootDir, fsImpl) {
  const extensionsRoot = path.join(rootDir, "dist", "extensions");
  if (!fsImpl.existsSync(extensionsRoot)) {
    return [];
  }
  return fsImpl
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => ({
      dirName: entry.name,
      packageDir: path.join(extensionsRoot, entry.name),
    }))
    .toSorted((left, right) => left.dirName.localeCompare(right.dirName));
}

function readPackageStaticAssetEntries(packageJson) {
  const entries = packageJson.openclaw?.build?.staticAssets;
  return Array.isArray(entries) ? entries : [];
}

export function discoverStaticExtensionAssets(params = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assets = [];
  for (const { dirName, hasPackageJson, packageJsonPath } of listExtensionPackageDirs(
    rootDir,
    fsImpl,
  )) {
    if (!(hasPackageJson ?? fsImpl.existsSync(packageJsonPath))) {
      continue;
    }
    const packageJson = readJsonFile(packageJsonPath, fsImpl);
    for (const entry of readPackageStaticAssetEntries(packageJson)) {
      const source = normalizePackageRelativePath(entry?.source);
      const output = normalizePackageRelativePath(entry?.output);
      if (!source || !output) {
        continue;
      }
      assets.push({
        pluginDir: dirName,
        src: toPosixPath(path.posix.join("extensions", dirName, source)),
        dest: toPosixPath(path.posix.join("dist", "extensions", dirName, output)),
      });
    }
  }
  return assets.toSorted((left, right) => left.dest.localeCompare(right.dest));
}

function discoverStaticExtensionRuntimeOverlayAssets(params = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assetsByDest = new Map();
  for (const asset of params.assets ?? discoverStaticExtensionAssets({ rootDir, fs: fsImpl })) {
    assetsByDest.set(asset.dest, asset);
  }
  for (const { dirName, packageDir } of listDistExtensionPackageDirs(rootDir, fsImpl)) {
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!fsImpl.existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = readJsonFile(packageJsonPath, fsImpl);
    for (const entry of readPackageStaticAssetEntries(packageJson)) {
      const output = normalizePackageRelativePath(entry?.output);
      if (!output) {
        continue;
      }
      const dest = toPosixPath(path.posix.join("dist", "extensions", dirName, output));
      if (!assetsByDest.has(dest)) {
        assetsByDest.set(dest, { pluginDir: dirName, src: dest, dest });
      }
    }
  }
  return [...assetsByDest.values()].toSorted((left, right) => left.dest.localeCompare(right.dest));
}

 * 获取静态扩展资源的输出路径列表
 *
 * 此函数返回所有静态扩展资源在分发目录中的目标路径列表，
 * 路径使用正斜杠格式并按字母顺序排序。
 * 主要用于构建系统确定输出文件依赖关系。
 *
 * @param {Object} params - 配置参数对象
 * @param {Array} [params.assets] - 静态资源列表，默认使用 STATIC_EXTENSION_ASSETS
 * @returns {string[]} 排序后的输出路径数组
 */
// lyc:aic 注释从 scripts/runtime-postbuild.mjs 迁移过来（v2026.5 抽函数到本文件）
export function listStaticExtensionAssetOutputs(params = {}) {
  const assets = params.assets ?? discoverStaticExtensionAssets(params);
  return assets
    .map(({ dest }) => dest.replace(/\\/g, "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

export function listStaticExtensionAssetSources(params = {}) {
  const assets = params.assets ?? discoverStaticExtensionAssets(params);
  return assets
    .map(({ src }) => src.replace(/\\/g, "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

 * 复制静态扩展资源文件到分发目录
 *
 * 某些扩展在运行时需要引用特定的静态资源文件，这些文件在捆绑的扩展代码中
 * 通过源相对路径引用。此函数将这些预定义的静态资源从源目录复制到分发目录，
 * 确保运行时能够正确找到它们。
 *
 * 当前包含的静态资源：
 * - ACPX MCP 代理 (mcp-proxy.mjs) - 用于 MCP 协议通信
 * - 差异查看器运行时 (viewer-runtime.js) - 用于显示代码差异
 *
 * @param {Object} params - 配置参数对象
 * @param {string} [params.rootDir] - 项目根目录，默认使用 ROOT 常量
 * @param {Array} [params.assets] - 要复制的静态资源列表，默认使用 STATIC_EXTENSION_ASSETS
 * @param {Object} [params.fs] - 文件系统实现，默认使用 node:fs 模块
 * @param {Function} [params.warn] - 警告输出函数，默认使用 console.warn
 */
// lyc:aic 注释从 scripts/runtime-postbuild.mjs 迁移过来（v2026.5 抽函数到本文件）
export function copyStaticExtensionAssets(params = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assets = params.assets ?? discoverStaticExtensionAssets({ rootDir, fs: fsImpl });
  const warn = params.warn ?? console.warn;
  for (const { src, dest } of assets) {
    const srcPath = path.join(rootDir, src);
    const destPath = path.join(rootDir, dest);
    if (fsImpl.existsSync(srcPath)) {
      fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
      fsImpl.copyFileSync(srcPath, destPath);
    } else {
      warn(`[runtime-postbuild] static asset not found, skipping: ${src}`);
    }
  }
}

export function copyStaticExtensionAssetsToRuntimeOverlay(params = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assets = discoverStaticExtensionRuntimeOverlayAssets({ ...params, rootDir, fs: fsImpl });
  const runtimeExtensionsRoot = path.join(rootDir, "dist-runtime", "extensions");
  if (!fsImpl.existsSync(runtimeExtensionsRoot)) {
    return;
  }
  const warn = params.warn ?? console.warn;
  for (const { src, dest } of assets) {
    const normalizedDest = toPosixPath(dest);
    if (!normalizedDest.startsWith("dist/extensions/")) {
      continue;
    }
    const srcPath = path.join(rootDir, src);
    const distPath = path.join(rootDir, dest);
    const copySourcePath = fsImpl.existsSync(srcPath) ? srcPath : distPath;
    const destPath = path.join(rootDir, "dist-runtime", normalizedDest.slice("dist/".length));
    if (fsImpl.existsSync(copySourcePath)) {
      fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
      fsImpl.copyFileSync(copySourcePath, destPath);
    } else {
      warn(`[runtime-postbuild] static asset not found, skipping: ${src}`);
    }
  }
}

export function copyStaticExtensionAssetsForPackage(params) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assets = params.assets ?? discoverStaticExtensionAssets({ rootDir, fs: fsImpl });
  const packagePrefix = `extensions/${params.pluginDir}/`;
  const rootDistPrefix = `dist/extensions/${params.pluginDir}/`;
  const copied = [];
  for (const { src, dest } of assets) {
    const normalizedSrc = src.replaceAll("\\", "/");
    const normalizedDest = dest.replaceAll("\\", "/");
    if (!normalizedSrc.startsWith(packagePrefix) || !normalizedDest.startsWith(rootDistPrefix)) {
      continue;
    }
    const srcPath = path.join(rootDir, src);
    if (!fsImpl.existsSync(srcPath)) {
      continue;
    }
    const packageRelativeDest = normalizedDest.slice(rootDistPrefix.length);
    const destPath = path.join(rootDir, packagePrefix, "dist", packageRelativeDest);
    fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
    fsImpl.copyFileSync(srcPath, destPath);
    copied.push(`dist/${packageRelativeDest}`);
  }
  return copied.toSorted((left, right) => left.localeCompare(right));
}
