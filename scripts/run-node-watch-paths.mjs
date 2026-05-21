import path from "node:path";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";

export const runNodeSourceRoots = ["src", BUNDLED_PLUGIN_ROOT_DIR];
export const runNodeConfigFiles = ["tsconfig.json", "package.json", "tsdown.config.ts"];
export const runNodeWatchedPaths = [...runNodeSourceRoots, ...runNodeConfigFiles];
export const extensionRestartMetadataFiles = new Set(["openclaw.plugin.json", "package.json"]);

const ignoredRunNodeRepoPathPatterns = [
  /^extensions\/[^/]+\/src\/host\/.+\/\.bundle\.hash$/u,
  /^extensions\/[^/]+\/src\/host\/.+\/[^/]+\.bundle\.js$/u,
];
/* lyc: 匹配以下扩展名: js, jsx, ts, tsx, cjs, cjsx, cts, csx, mjs, mjsx, mts, mtx
*/
// lyc:aic 从 scripts/run-node.mjs 迁移过来（v2026.5 把 watch-path helpers 抽到本文件）
const extensionSourceFilePattern = /\.(?:[cm]?[jt]sx?)$/;

export const normalizeRunNodePath = (filePath) => String(filePath ?? "").replaceAll("\\", "/");

// lyc: 忽略以下结尾的文件: .test.ts, .test.tsx, test-helpers.ts
const isIgnoredSourcePath = (relativePath) => {
  const normalizedPath = normalizeRunNodePath(relativePath);
  return (
    normalizedPath.endsWith(".test.ts") ||
    normalizedPath.endsWith(".test.tsx") ||
    normalizedPath.endsWith("test-helpers.ts")
  );
};

// lyc: Build 阶段：relativePath 是否是可构建|编译的源文件
const isBuildRelevantSourcePath = (relativePath) => {
  const normalizedPath = normalizeRunNodePath(relativePath);
  // lyc: 以源文件扩展名结尾的文件, 且不是忽略的文件, 则认为 relativePath 是可以被构造的
  return extensionSourceFilePattern.test(normalizedPath) && !isIgnoredSourcePath(normalizedPath);
};

// lyc: Restart 阶段：relativePath 是否是可构建|编译的源文件
const isRestartRelevantExtensionPath = (relativePath) => {
  const normalizedPath = normalizeRunNodePath(relativePath);
  // lyc: 是 openclaw.plugin.json, package.json
  if (extensionRestartMetadataFiles.has(path.posix.basename(normalizedPath))) {
    return true;
  }
  return isBuildRelevantSourcePath(normalizedPath);
};

/* lyc: 是否是和 openclaw 相关的路径, 即 repoPath 是否是可构建|编译的源文件
*/
// lyc:aic v2026.5：原本用 ignoredRunNodeRepoPaths(Set) 改成了 ignoredRunNodeRepoPathPatterns(正则数组)，匹配更灵活
const isRelevantRunNodePath = (repoPath, isRelevantBundledPluginPath) => {
  const normalizedPath = normalizeRunNodePath(repoPath).replace(/^\.\/+/, "");
  // lyc: 忽略匹配 ignoredRunNodeRepoPathPatterns 的文件（如 .bundle.hash / *.bundle.js 等）
  if (ignoredRunNodeRepoPathPatterns.some((pattern) => pattern.test(normalizedPath))) {
    return false;
  }
  // lyc: 是相关的配置文件: tsconfig.json, package.json, tsdown.config.ts
  if (runNodeConfigFiles.includes(normalizedPath)) {
    return true;
  }
  // lyc: 如果以 "src/" 目录开头, 且不是忽略的文件, 则需要构造
  if (normalizedPath.startsWith("src/")) {
    return !isIgnoredSourcePath(normalizedPath.slice("src/".length));
  }
  // lyc: 如果以 "extensions/" 目录开头, 且是可构建|编译的源文件, 则需要构造
  if (normalizedPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return isRelevantBundledPluginPath(normalizedPath.slice(BUNDLED_PLUGIN_PATH_PREFIX.length));
  }
  return false;
};

// lyc: 是否是构建相关的当前运行的 openclaw 程序所关注的路径
export const isBuildRelevantRunNodePath = (repoPath) =>
  isRelevantRunNodePath(repoPath, isBuildRelevantSourcePath);

// lyc: 是否是重启相关的当前运行的 openclaw 程序所关注的路径
export const isRestartRelevantRunNodePath = (repoPath) =>
  isRelevantRunNodePath(repoPath, isRestartRelevantExtensionPath);
