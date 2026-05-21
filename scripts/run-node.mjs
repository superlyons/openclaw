#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  collectBundledPluginBuildEntries,
  NON_PACKAGED_BUNDLED_PLUGIN_DIRS,
} from "./lib/bundled-plugin-build-entries.mjs";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
  resolveGitHead,
  writeBuildStamp as writeDistBuildStamp,
  writeRuntimePostBuildStamp as writeDistRuntimePostBuildStamp,
} from "./lib/local-build-metadata.mjs";
import {
  discoverStaticExtensionAssets,
  listStaticExtensionAssetSources,
} from "./lib/static-extension-assets.mjs";
import {
  extensionRestartMetadataFiles,
  isBuildRelevantRunNodePath,
  isRestartRelevantRunNodePath,
  normalizeRunNodePath as normalizePath,
  runNodeConfigFiles,
  runNodeSourceRoots,
  runNodeWatchedPaths,
} from "./run-node-watch-paths.mjs";
import { listCoreRuntimePostBuildOutputs, runRuntimePostBuild } from "./runtime-postbuild.mjs";

export { isBuildRelevantRunNodePath, isRestartRelevantRunNodePath, runNodeWatchedPaths };

const buildScript = "scripts/tsdown-build.mjs";
const bundledPluginAssetsScript = "scripts/bundled-plugin-assets.mjs";
const compilerArgs = [buildScript, "--no-clean"];
const bundledPluginAssetBuildArgs = [bundledPluginAssetsScript, "--phase", "build"];

const runtimePostBuildWatchedPaths = [
  "scripts/copy-bundled-plugin-metadata.mjs",
  "scripts/copy-plugin-sdk-root-alias.mjs",
  "scripts/lib",
  "scripts/lib/local-build-metadata.mjs",
  "scripts/lib/local-build-metadata-paths.mjs",
  "scripts/npm-runner.mjs",
  "scripts/runtime-postbuild-stamp.mjs",
  "scripts/runtime-postbuild-shared.mjs",
  "scripts/runtime-postbuild.mjs",
  "scripts/stage-bundled-plugin-runtime.mjs",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/write-official-channel-catalog.mjs",
  "src/plugin-sdk/root-alias.cjs",
  BUNDLED_PLUGIN_ROOT_DIR,
];
const runtimePostBuildScriptPaths = new Set(
  runtimePostBuildWatchedPaths.filter((entry) => entry.startsWith("scripts/")),
);
// lyc:aic v2026.5：硬编码的资源路径列表换成了动态 listStaticExtensionAssetSources()，
//         上面那一堆 watch-path helper / lyc 注释全部搬到了 ./run-node-watch-paths.mjs
const runtimePostBuildStaticAssetPaths = new Set(listStaticExtensionAssetSources());

const statMtime = (filePath, fsImpl = fs) => {
  try {
    return fsImpl.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const resolvePrivateQaRequiredDistEntries = (distRoot) => [
  path.join(distRoot, "plugin-sdk", "qa-lab.js"),
  path.join(distRoot, "plugin-sdk", "qa-runtime.js"),
];
const shouldIncludePrivateQaBundledOutputs = (env = process.env) =>
  env.OPENCLAW_BUILD_PRIVATE_QA === "1";

const shouldRequireBundledPluginRuntimeOutput = (pluginId, env = process.env) =>
  shouldIncludePrivateQaBundledOutputs(env) || !NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(pluginId);

const isExcludedSource = (filePath, sourceRoot, sourceRootName) => {
  const relativePath = normalizePath(path.relative(sourceRoot, filePath));
  if (relativePath.startsWith("..")) {
    return false;
  }
  return !isBuildRelevantRunNodePath(path.posix.join(sourceRootName, relativePath));
};

// lyc: 查找最后修改时间, 即获得dirPath目录下所有文件中最新的修改时间, 单位毫秒
const findLatestMtime = (dirPath, shouldSkip, deps) => {
  let latest = null;
  const queue = [dirPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = deps.fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (shouldSkip?.(fullPath)) {
        continue;
      }
      const mtime = statMtime(fullPath, deps.fs);
      if (mtime == null) {
        continue;
      }
      if (latest == null || mtime > latest) {
        latest = mtime;
      }
    }
  }
  return latest;
};

/* lyc: 
*/
const readGitStatus = (deps, paths = runNodeWatchedPaths) => {
  try {
    const result = deps.spawnSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal", "--", ...paths],
      {
        cwd: deps.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (result.status !== 0) {
      return null;
    }
    return result.stdout ?? "";
  } catch {
    return null;
  }
};

/* lyc: 获得git status命令输出中所有的文件路径名
*/
const parseGitStatusPaths = (output) =>
  output
    .split("\n")
    /* lyc: 切掉前3个字符(状态码)，然后按" -> "分割(处理重命名情况), 之后再扁平化, 即先map在flat(1) 即先映射再扁平化一层。
      */
    .flatMap((line) => line.slice(3).split(" -> "))
    .map((entry) => normalizePath(entry.trim()))
    .filter(Boolean);

// lyc: 有脏的源树修改, 检查git修改状态中是否有未提交的更改或新添加的文件需要被处理
const hasDirtySourceTree = (deps) => {
  const output = readGitStatus(deps);
  if (output === null) {
    return null;
  }
  // lyc: 获得 git status 命令输出中所有的文件路径名, 并检查是否有构建相关路径
  // lyc:aic v2026.5：除了"构建相关路径"，还多了一种"插件 package entry 变了但还没出 dist 产物"的脏判断
  return parseGitStatusPaths(output).some((repoPath) => {
    const normalizedPath = normalizePath(repoPath).replace(/^\.\/+/, "");
    return (
      isBuildRelevantRunNodePath(normalizedPath) ||
      isDirtyBundledPluginPackageEntryChangeWithoutBuiltOutputs(normalizedPath, deps)
    );
  });
};

// lyc: 是否是运行时后构建相关路径
const isRuntimePostBuildRelevantPath = (repoPath) => {
  const normalizedPath = normalizePath(repoPath).replace(/^\.\/+/, "");
  if (normalizedPath === "src/plugin-sdk/root-alias.cjs") {
    return true;
  }
  if (runtimePostBuildStaticAssetPaths.has(normalizedPath)) {
    return true;
  }
  if (
    normalizedPath.startsWith("scripts/") &&
    (runtimePostBuildScriptPaths.has(normalizedPath) || normalizedPath.startsWith("scripts/lib/"))
  ) {
    return true;
  }
  if (!normalizedPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return false;
  }
  const pluginRelativePath = normalizedPath.slice(BUNDLED_PLUGIN_PATH_PREFIX.length);
  const pluginLocalPath = pluginRelativePath.split("/").slice(1).join("/");
  if (pluginLocalPath === "skills" || pluginLocalPath.startsWith("skills/")) {
    return true;
  }
  return extensionRestartMetadataFiles.has(path.posix.basename(pluginRelativePath));
};

// lyc: 是否有脏的运行时后构建输入(特指runtimePostBuildWatchedPaths指定的文件和目录), 
// lyc: 即git修改状态中是否有未提交的更改或新添加的文件需要被处理, 特指 runtimePostBuildWatchedPaths 指定的文件和目录
const hasDirtyRuntimePostBuildInputs = (deps) => {
  const output = readGitStatus(deps, runtimePostBuildWatchedPaths);
  if (output === null) {
    return null;
  }
  // 获得git status命令输出中所有的文件路径名, 并检查是否有是运行时后构建相关路径
  return parseGitStatusPaths(output).some((repoPath) => isRuntimePostBuildRelevantPath(repoPath));
};

// lyc: 读取构建戳文件(/home/openclaw/dist/.openclaw/.buildstamp文件), 
// lyc: 返回{mtime: 文件修改时间|null, head: 文件.head内容|null}
const readJsonStamp = (filePath, deps) => {
  const mtime = statMtime(filePath, deps.fs);
  if (mtime == null) {
    return { mtime: null, head: null };
  }
  try {
    const raw = deps.fs.readFileSync(filePath, "utf8").trim();
    if (!raw.startsWith("{")) {
      return { mtime, head: null };
    }
    const parsed = JSON.parse(raw);
    const head = typeof parsed?.head === "string" && parsed.head.trim() ? parsed.head.trim() : null;
    return { mtime, head };
  } catch {
    return { mtime, head: null };
  }
};

// lyc: 读取构建戳文件(/home/openclaw/dist/.openclaw/.buildstamp文件), 
const readBuildStamp = (deps) => readJsonStamp(deps.buildStampPath, deps);

// lyc: 读取运行时后构建戳文件(/home/openclaw/dist/.openclaw/.runtime_post_build_stamp文件), 
const readRuntimePostBuildStamp = (deps) => {
  return readJsonStamp(deps.runtimePostBuildStampPath, deps);
};

// lyc: 源文件修改时间是否被更改, 即检查deps.sourceRoots中是否有文件修改时间大于stampMtime
const hasSourceMtimeChanged = (stampMtime, deps) => {
  let latestSourceMtime = null;
  for (const sourceRoot of deps.sourceRoots) {
    const sourceMtime = findLatestMtime(
      sourceRoot.path,
      (candidate) => isExcludedSource(candidate, sourceRoot.path, sourceRoot.name),
      deps,
    );
    if (sourceMtime != null && (latestSourceMtime == null || sourceMtime > latestSourceMtime)) {
      latestSourceMtime = sourceMtime;
    }
  }
  return latestSourceMtime != null && latestSourceMtime > stampMtime;
};

// lyc: 查找最后的运行时后构建输入 修改时间
const findLatestRuntimePostBuildInputMtime = (absolutePath, relativePath, deps) => {
  const normalizedRelativePath = normalizePath(relativePath);
  const statsMtime = statMtime(absolutePath, deps.fs);
  if (statsMtime == null) {
    return null;
  }
  let stat;
  try {
    stat = deps.fs.statSync(absolutePath);
  } catch {
    return null;
  }
  // lyc: 如果是文件, 则先判断是否是运行时后构建相关路径, 如果是则返回文件的修改时间, 如果不是则返回null
  if (!stat.isDirectory()) {
    return isRuntimePostBuildRelevantPath(normalizedRelativePath) ? statsMtime : null;
  }
  // lyc: 如果是目录, 则递归查找目录下的所有文件中最新的修改时间, 只有是 运行时后构建相关路径 的文件才会被考虑, 其他文件会被忽略
  return findLatestMtime(
    absolutePath,
    (candidate) => {
      const candidateRelativePath = path.relative(deps.cwd, candidate);
      return !isRuntimePostBuildRelevantPath(candidateRelativePath);
    },
    deps,
  );
};

// lyc: 运行时后构建输入 修改时间是否被更改, 即检查runtimePostBuildWatchedPaths指定的文件和目录中是否有文件修改时间大于stampMtime
// lyc: RuntimePostBuildInput: 运行时后构建输入 可能是文件, 也可能是一个目录
// lyc: 无论是文件还是目录都会检查其是否是运行时后构建相关路径, 如果是文件则判断文件的修改时间是否大于stampMtime, 如果是目录则判断目录下的所有文件中最新的修改时间是否大于stampMtime
const hasRuntimePostBuildInputMtimeChanged = (stampMtime, deps) => {
  let latestInputMtime = null;
  for (const relativePath of runtimePostBuildWatchedPaths) {
    const absolutePath = path.join(deps.cwd, relativePath);
    // lyc: 运行时后构建输入 修改时间; absolutePath如果是文件且是 运行时后构建相关路径则 返回它的修改时间
    // lyc: 如果是目录, 则递归查找 运行时后构建输入(absolutePath)目录 下的所有文件中最新的修改时间, (absolutePath是目录且是 运行时后构建相关路径 则返回目录下的所有文件中最新的修改时间)
    const inputMtime = findLatestRuntimePostBuildInputMtime(absolutePath, relativePath, deps);
    if (inputMtime != null && (latestInputMtime == null || inputMtime > latestInputMtime)) {
      latestInputMtime = inputMtime;
    }
  }
  return latestInputMtime != null && latestInputMtime > stampMtime;
};

const resolveRuntimePostBuildDistRoot = (deps) => deps.distRoot ?? path.join(deps.cwd, "dist");
const resolveRuntimePostBuildRuntimeRoot = (deps) => path.join(deps.cwd, "dist-runtime");

const collectRunNodeBundledPluginBuildEntries = (deps) => {
  if (!deps.fs.existsSync(path.join(deps.cwd, BUNDLED_PLUGIN_ROOT_DIR))) {
    return [];
  }
  return collectBundledPluginBuildEntries({ cwd: deps.cwd, env: deps.env });
};

const resolveBuiltBundledPluginRuntimeEntryPath = (distRoot, pluginId, sourceEntry) =>
  path.join(
    distRoot,
    "extensions",
    pluginId,
    sourceEntry.replace(/^\.\//, "").replace(/\.[^.]+$/u, ".js"),
  );

const listBundledPluginRuntimeEntryPaths = (pluginEntry, deps) => {
  const distRoot = resolveRuntimePostBuildDistRoot(deps);
  return pluginEntry.sourceEntries
    .map((sourceEntry) =>
      resolveBuiltBundledPluginRuntimeEntryPath(distRoot, pluginEntry.id, sourceEntry),
    )
    .toSorted((left, right) => left.localeCompare(right));
};

const isDirtyBundledPluginPackageEntryChangeWithoutBuiltOutputs = (normalizedPath, deps) => {
  if (!normalizedPath.startsWith("extensions/") || !normalizedPath.endsWith("/package.json")) {
    return false;
  }
  const [, pluginId] = normalizedPath.split("/");
  if (!pluginId || !shouldRequireBundledPluginRuntimeOutput(pluginId, deps.env)) {
    return false;
  }
  const pluginEntry = collectRunNodeBundledPluginBuildEntries(deps).find(
    (entry) => entry.id === pluginId,
  );
  if (!pluginEntry) {
    return false;
  }
  return listBundledPluginRuntimeEntryPaths(pluginEntry, deps).some(
    (filePath) => !deps.fs.existsSync(filePath),
  );
};

const hasMissingBuiltBundledPluginRuntimeEntryOutput = (deps) => {
  return collectRunNodeBundledPluginBuildEntries(deps)
    .filter(({ id }) => shouldRequireBundledPluginRuntimeOutput(id, deps.env))
    .some((pluginEntry) => {
      const entryPaths = listBundledPluginRuntimeEntryPaths(pluginEntry, deps);
      return entryPaths.some((filePath) => !deps.fs.existsSync(filePath));
    });
};

const listBuiltBundledPluginEntries = (deps) => {
  return collectRunNodeBundledPluginBuildEntries(deps)
    .filter(({ id }) => shouldRequireBundledPluginRuntimeOutput(id, deps.env))
    .filter((pluginEntry) =>
      listBundledPluginRuntimeEntryPaths(pluginEntry, deps).some((filePath) =>
        deps.fs.existsSync(filePath),
      ),
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
};

const listBuiltBundledPluginRuntimeOverlayDirs = (deps) => {
  const distExtensionsRoot = path.join(resolveRuntimePostBuildDistRoot(deps), "extensions");
  let entries = [];
  try {
    entries = deps.fs.readdirSync(distExtensionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));
};

const listRequiredBundledPluginMetadataOutputs = (pluginEntries, deps) =>
  pluginEntries.flatMap(({ id, hasManifest, hasPackageJson }) => {
    const builtPluginDir = path.join(resolveRuntimePostBuildDistRoot(deps), "extensions", id);
    const requiredPaths = [];
    if (hasPackageJson) {
      requiredPaths.push(path.join(builtPluginDir, "package.json"));
    }
    if (hasManifest) {
      requiredPaths.push(path.join(builtPluginDir, "openclaw.plugin.json"));
    }
    return requiredPaths;
  });

const listRuntimeOverlaySourcePaths = (sourceDir, deps) => {
  const paths = [];
  const queue = [sourceDir];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = deps.fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        paths.push(entryPath);
      }
    }
  }
  return paths.toSorted((left, right) => left.localeCompare(right));
};

const listRequiredBundledPluginRuntimeOverlayOutputs = (deps) => {
  const distRoot = resolveRuntimePostBuildDistRoot(deps);
  const runtimeRoot = resolveRuntimePostBuildRuntimeRoot(deps);
  const runtimePaths = [];
  for (const pluginId of listBuiltBundledPluginRuntimeOverlayDirs(deps)) {
    const distPluginDir = path.join(distRoot, "extensions", pluginId);
    const runtimePluginDir = path.join(runtimeRoot, "extensions", pluginId);
    for (const sourcePath of listRuntimeOverlaySourcePaths(distPluginDir, deps)) {
      runtimePaths.push(path.join(runtimePluginDir, path.relative(distPluginDir, sourcePath)));
    }
  }
  return [...new Set(runtimePaths)].toSorted((left, right) => left.localeCompare(right));
};

const listRequiredOpenClawExtensionAliasOutputs = (deps) => {
  const distRoot = resolveRuntimePostBuildDistRoot(deps);
  const distExtensionsRoot = path.join(distRoot, "extensions");
  if (!deps.fs.existsSync(distExtensionsRoot)) {
    return [];
  }
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  let dirents = [];
  try {
    dirents = deps.fs.readdirSync(pluginSdkDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const aliasDir = path.join(distRoot, "extensions", "node_modules", "openclaw");
  return [
    path.join(aliasDir, "package.json"),
    ...dirents
      .filter((dirent) => dirent.isFile() && path.extname(dirent.name) === ".js")
      .map((dirent) => path.join(aliasDir, "plugin-sdk", dirent.name)),
  ].toSorted((left, right) => left.localeCompare(right));
};

const listRequiredStaticExtensionAssetOutputs = (deps) => {
  const distRoot = resolveRuntimePostBuildDistRoot(deps);
  return discoverStaticExtensionAssets({ rootDir: deps.cwd, fs: deps.fs })
    .filter((asset) => deps.fs.existsSync(path.join(deps.cwd, asset.src)))
    .map((asset) => path.join(distRoot, normalizePath(asset.dest).replace(/^dist\//u, "")))
    .toSorted((left, right) => left.localeCompare(right));
};

const listRequiredCoreRuntimePostBuildOutputs = (deps) =>
  listCoreRuntimePostBuildOutputs({ rootDir: deps.cwd, fs: deps.fs }).map((relativePath) =>
    path.join(deps.cwd, normalizePath(relativePath)),
  );

export const listRequiredRuntimePostBuildOutputs = (deps) => {
  const builtPluginEntries = listBuiltBundledPluginEntries(deps);
  return [
    ...listRequiredCoreRuntimePostBuildOutputs(deps),
    ...listRequiredOpenClawExtensionAliasOutputs(deps),
    ...listRequiredStaticExtensionAssetOutputs(deps),
    ...listRequiredBundledPluginMetadataOutputs(builtPluginEntries, deps),
    ...listRequiredBundledPluginRuntimeOverlayOutputs(deps),
  ];
};

const hasMissingRequiredRuntimePostBuildOutput = (deps) =>
  listRequiredRuntimePostBuildOutputs(deps).some(
    (filePath) => statMtime(filePath, deps.fs) == null,
  );

// lyc: 解决构建需求, 检查是否需要构建
// lyc:aic v2026.5 新增上面一大堆 listRequired*/hasMissing*/isDirty* helper，把"需要构建吗"的判断细化了
export const resolveBuildRequirement = (deps) => {
  // lyc: 强制构建, 无论是否需要构建
  if (deps.env.OPENCLAW_FORCE_BUILD === "1") {
    return { shouldBuild: true, reason: "force_build" };
  }
  // lyc: 如果在构建过程中需要执行私有的QA测试, 并且私有的QA测试文件不存在, 则需要构建
  if (
    deps.env.OPENCLAW_BUILD_PRIVATE_QA === "1" &&
    (deps.privateQaRequiredDistEntries ?? resolvePrivateQaRequiredDistEntries(deps.distRoot)).some(
      (entry) => statMtime(entry, deps.fs) == null,
    )
  ) {
    return { shouldBuild: true, reason: "missing_private_qa_dist" };
  }
  // lyc: 读取构建戳文件(/home/openclaw/dist/.openclaw/.buildstamp文件), 
  const stamp = readBuildStamp(deps);
  // lyc: 如果构建戳文件不存在, 则需要构建
  if (stamp.mtime == null) {
    return { shouldBuild: true, reason: "missing_build_stamp" };
  }
  // lyc: 如果分发目录下的入口文件不存在(/home/openclaw/dist/entry.js), 则需要构建
  if (statMtime(deps.distEntry, deps.fs) == null) {
    return { shouldBuild: true, reason: "missing_dist_entry" };
  }

  /* lyc: 遍历配置文件路径, 检查是否需要构建
    */
  for (const filePath of deps.configFiles) {
    const mtime = statMtime(filePath, deps.fs);
    if (mtime != null && mtime > stamp.mtime) {
      return { shouldBuild: true, reason: "config_newer" };
    }
  }

  // lyc: resolveGitHead实现: scripts\build-stamp.mjs
  // lyc: 解析当前Git分支的HEAD, 返回HEAD值|null
  const currentHead = resolveGitHead(deps);
  // lyc: 如果当前Git分支的HEAD与构建戳文件中的HEAD不同, 则需要构建
  if (currentHead && !stamp.head) {
    return { shouldBuild: true, reason: "build_stamp_missing_head" };
  }
  if (currentHead && stamp.head && currentHead !== stamp.head) {
    return { shouldBuild: true, reason: "git_head_changed" };
  }
  // lyc: 如果当前Git分支的HEAD与构建戳文件中的HEAD相同, 则需要检查是否有脏的源树修改, 即检查git修改状态中是否有未提交的更改或新添加的文件需要被处理
  if (currentHead) {
    const dirty = hasDirtySourceTree(deps);
    if (dirty === true) {
      return { shouldBuild: true, reason: "dirty_watched_tree" };
    }
    if (dirty === false) {
      if (hasMissingBuiltBundledPluginRuntimeEntryOutput(deps)) {
        return { shouldBuild: true, reason: "missing_bundled_plugin_dist_entry" };
      }
      return { shouldBuild: false, reason: "clean" };
    }
  }

  // lyc:aic v2026.5 新增：如果有捆绑插件的 runtime entry 输出文件缺失（编译产物没生成全），也判定为需要构建
  if (hasMissingBuiltBundledPluginRuntimeEntryOutput(deps)) {
    return { shouldBuild: true, reason: "missing_bundled_plugin_dist_entry" };
  }

  // lyc: 执行到此代表没有 git 环境（或前置检查都通过），则通过检查源文件修改时间来判断是否需要构建
  if (hasSourceMtimeChanged(stamp.mtime, deps)) {
    return { shouldBuild: true, reason: "source_mtime_newer" };
  }
  return { shouldBuild: false, reason: "clean" };
};

// lyc: 解决运行时后构建需求, 检查是否需要运行时后构建
export const resolveRuntimePostBuildRequirement = (deps) => {
  // lyc: 强制运行时后构建, 无论是否需要运行时后构建
  if (deps.env.OPENCLAW_FORCE_RUNTIME_POSTBUILD === "1") {
    return { shouldSync: true, reason: "force_runtime_postbuild" };
  }
  // lyc: 读取运行时后构建戳文件(/home/openclaw/dist/.openclaw/.runtime_post_build_stamp文件), 

  const stamp = readRuntimePostBuildStamp(deps);
  // lyc: 如果运行时后构建戳文件不存在, 则需要运行时后构建
  if (stamp.mtime == null) {
    return { shouldSync: true, reason: "missing_runtime_postbuild_stamp" };
  }
  // lyc: 读取构建戳文件(/home/openclaw/dist/.openclaw/.buildstamp文件), 

  const buildStamp = readBuildStamp(deps);
  // lyc: 如果构建戳文件不存在, 则需要运行时后构建
  if (buildStamp.mtime == null) {
    return { shouldSync: true, reason: "missing_build_stamp" };
  }
  // lyc: 如果构建戳文件修改时间大于运行时后构建戳文件修改时间, 则需要运行时后构建
  if (buildStamp.mtime > stamp.mtime) {
    return { shouldSync: true, reason: "build_stamp_newer" };
  }
  // lyc: 解析当前Git分支的HEAD, 返回HEAD值|null

  const currentHead = resolveGitHead(deps);
  // lyc: Git有改变但运行时后构建戳文件中没有HEAD, 则需要运行时后构建
  if (currentHead && !stamp.head) {
    return { shouldSync: true, reason: "runtime_postbuild_stamp_missing_head" };
  }
  // lyc: 如果当前Git分支的HEAD与运行时后构建戳文件中的HEAD不同, 代表当前Git分支的HEAD已改变, 则需要运行时后构建  
  if (currentHead && stamp.head && currentHead !== stamp.head) {
    return { shouldSync: true, reason: "git_head_changed" };
  }
   // lyc: 如果当前Git分支的HEAD与运行时后构建戳文件中的HEAD相同, 则需要检查是否有脏的运行时后构建输入(特指runtimePostBuildWatchedPaths指定的文件和目录), 即是否有未提交的更改或新添加的文件需要被处理
  if (currentHead) {
    const dirty = hasDirtyRuntimePostBuildInputs(deps);
    if (dirty === true) {
      return { shouldSync: true, reason: "dirty_runtime_postbuild_inputs" };
    }
    if (dirty === false) {
      if (hasMissingRequiredRuntimePostBuildOutput(deps)) {
        return { shouldSync: true, reason: "missing_runtime_postbuild_output" };
      }
      return { shouldSync: false, reason: "clean" };
    }
  }

   // lyc: 执行到此代表没有git环境, 则需要通过检查 运行时后构建输入 修改时间来判断是否需要运行时后构建  
  if (hasRuntimePostBuildInputMtimeChanged(stamp.mtime, deps)) {
    return { shouldSync: true, reason: "runtime_postbuild_input_mtime_newer" };
  }

  if (hasMissingRequiredRuntimePostBuildOutput(deps)) {
    return { shouldSync: true, reason: "missing_runtime_postbuild_output" };
  }

  return { shouldSync: false, reason: "clean" };
};

const BUILD_REASON_LABELS = {
  force_build: "forced by OPENCLAW_FORCE_BUILD",
  missing_build_stamp: "build stamp missing",
  missing_dist_entry: "dist entry missing",
  config_newer: "config newer than build stamp",
  build_stamp_missing_head: "build stamp missing git head",
  git_head_changed: "git head changed",
  dirty_watched_tree: "dirty watched source tree",
  missing_bundled_plugin_dist_entry: "bundled plugin dist entry missing",
  source_mtime_newer: "source mtime newer than build stamp",
  missing_private_qa_dist: "private QA dist entry missing",
  clean: "clean",
};

const RUNTIME_POSTBUILD_REASON_LABELS = {
  force_runtime_postbuild: "forced by OPENCLAW_FORCE_RUNTIME_POSTBUILD",
  missing_runtime_postbuild_output: "required runtime postbuild output missing",
  missing_runtime_postbuild_stamp: "runtime postbuild stamp missing",
  missing_build_stamp: "build stamp missing",
  build_stamp_newer: "build stamp newer than runtime postbuild stamp",
  runtime_postbuild_stamp_missing_head: "runtime postbuild stamp missing git head",
  git_head_changed: "git head changed",
  dirty_runtime_postbuild_inputs: "dirty runtime postbuild inputs",
  runtime_postbuild_input_mtime_newer: "runtime postbuild input mtime newer than stamp",
  clean: "clean",
};

const formatBuildReason = (reason) => BUILD_REASON_LABELS[reason] ?? reason;
const formatRuntimePostBuildReason = (reason) => RUNTIME_POSTBUILD_REASON_LABELS[reason] ?? reason;

const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
};

const isSignalKey = (signal) => Object.hasOwn(SIGNAL_EXIT_CODES, signal);

const getSignalExitCode = (signal) => (isSignalKey(signal) ? SIGNAL_EXIT_CODES[signal] : 1);

const RUN_NODE_OUTPUT_LOG_ENV = "OPENCLAW_RUN_NODE_OUTPUT_LOG";
const RUN_NODE_CPU_PROF_DIR_ENV = "OPENCLAW_RUN_NODE_CPU_PROF_DIR";
const RUN_NODE_FILTER_SYNC_IO_STDERR_ENV = "OPENCLAW_RUN_NODE_FILTER_SYNC_IO_STDERR";
const RUN_NODE_BUILD_LOCK_TIMEOUT_ENV = "OPENCLAW_RUN_NODE_BUILD_LOCK_TIMEOUT_MS";
const RUN_NODE_BUILD_LOCK_POLL_ENV = "OPENCLAW_RUN_NODE_BUILD_LOCK_POLL_MS";
const RUN_NODE_BUILD_LOCK_STALE_ENV = "OPENCLAW_RUN_NODE_BUILD_LOCK_STALE_MS";
const DEFAULT_BUILD_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BUILD_LOCK_POLL_MS = 100;
const DEFAULT_BUILD_LOCK_STALE_MS = 10 * 60 * 1000;

const parsePositiveIntegerEnv = (env, name, fallback) => {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveRunNodeOutputLogPath = (deps) => {
  const outputLog = deps.env[RUN_NODE_OUTPUT_LOG_ENV]?.trim();
  if (!outputLog) {
    return null;
  }
  return path.resolve(deps.cwd, outputLog);
};

// lyc: 创建 正在运行的openclaw程序 的输出tee流, 将所有输出都写入outputLogPath(由cwd()/env.RUN_NODE_OUTPUT_LOG_ENV指定)文件
// lyc: RunNode = Running Node = 正在运行的 Node.js 进程/程序 = 正在运行的openclaw程序 = openclaw
const createRunNodeOutputTee = (deps) => {
  const outputLogPath = resolveRunNodeOutputLogPath(deps);
  if (!outputLogPath) {
    return null;
  }
  deps.fs.mkdirSync(path.dirname(outputLogPath), { recursive: true });
  // lyc: 创建一个outputLogPath文件的可写流, 并设置为追加模式
  const stream = deps.fs.createWriteStream(outputLogPath, {
    flags: "a",
    mode: 0o600,
  });
  let streamError = null;
  stream.on("error", (error) => {
    streamError = error;
  });
  deps.env[RUN_NODE_OUTPUT_LOG_ENV] = outputLogPath;
  return {
    outputLogPath,
    write(chunk) {
      if (!streamError) {
        stream.write(chunk);
      }
    },
    async close() {
      if (streamError) {
        throw streamError;
      }
      await new Promise((resolve, reject) => {
        stream.once("error", reject);
        stream.end(resolve);
      });
      if (streamError) {
        throw streamError;
      }
    },
  };
};

const logRunner = (message, deps) => {
  if (deps.env.OPENCLAW_RUNNER_LOG === "0") {
    return;
  }
  const line = `[openclaw] ${message}\n`;
  deps.runNodeProgress?.clearLine();
  deps.stderr.write(line);
  deps.runNodeProgress?.render();
  deps.outputTee?.write(line);
};

// lyc:aic v2026.5 新增：终端进度旋转字符 + 多个 CPU profile / progress 相关 helper（约 110 行）
const RUN_NODE_PROGRESS_FRAMES = ["-", "\\", "|", "/"];

const shouldUseRunNodeProgress = (deps) =>
  deps.stderr?.isTTY === true &&
  deps.env.OPENCLAW_RUNNER_PROGRESS !== "0" &&
  deps.env.CI !== "true" &&
  !deps.outputTee;

const createRunNodeProgress = (label, deps) => {
  if (!shouldUseRunNodeProgress(deps)) {
    return null;
  }
  const startedAt = Date.now();
  let frameIndex = 0;
  let active = true;
  let visible = false;

  const clearLine = () => {
    if (!visible) {
      return;
    }
    deps.stderr.write("\r\x1b[2K");
    visible = false;
  };
  const render = () => {
    if (!active) {
      return;
    }
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const frame = RUN_NODE_PROGRESS_FRAMES[frameIndex % RUN_NODE_PROGRESS_FRAMES.length];
    frameIndex += 1;
    deps.stderr.write(`\r[openclaw] ${frame} ${label} (${elapsedSeconds}s)`);
    visible = true;
  };
  const timer = setInterval(render, 120);
  timer.unref?.();
  render();

  return {
    clearLine,
    render,
    stop() {
      if (!active) {
        return;
      }
      active = false;
      clearInterval(timer);
      clearLine();
    },
  };
};

const withRunNodeProgress = async (deps, label, callback) => {
  const previousProgress = deps.runNodeProgress;
  const progress = createRunNodeProgress(label, deps);
  if (progress) {
    deps.runNodeProgress = progress;
  }
  try {
    return await callback();
  } finally {
    if (progress) {
      progress.stop();
      deps.runNodeProgress = previousProgress;
    }
  }
};

const writeRunnerStream = (deps, stream, chunk) => {
  deps.runNodeProgress?.clearLine();
  stream.write(chunk);
  deps.runNodeProgress?.render();
};

const shouldPipeSpawnedOutput = (deps) => Boolean(deps.outputTee || deps.runNodeProgress);

const sanitizeCpuProfileNamePart = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "command";
};

const resolveRunNodeCpuProfileArgs = (deps) => {
  const profileDir = deps.env[RUN_NODE_CPU_PROF_DIR_ENV]?.trim();
  if (!profileDir) {
    return [];
  }

  const absoluteProfileDir = path.resolve(deps.cwd, profileDir);
  deps.fs.mkdirSync(absoluteProfileDir, { recursive: true });
  deps.env[RUN_NODE_CPU_PROF_DIR_ENV] = absoluteProfileDir;

  const commandName = sanitizeCpuProfileNamePart(deps.args[0]);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pid = Number.isInteger(deps.process.pid) && deps.process.pid > 0 ? deps.process.pid : "pid";
  const profileName = `openclaw-${commandName}-${pid}-${timestamp}.cpuprofile`;
  const profilePath = path.join(absoluteProfileDir, profileName);
  const relativeProfilePath = path.relative(deps.cwd, profilePath) || profilePath;
  logRunner(`Writing Node CPU profile to ${relativeProfilePath}.`, deps);
  return ["--cpu-prof", `--cpu-prof-dir=${absoluteProfileDir}`, `--cpu-prof-name=${profileName}`];
};

const resolveRunNodeDiagnosticArgs = (deps) => {
  const args = [...resolveRunNodeCpuProfileArgs(deps)];
  if (deps.env.OPENCLAW_TRACE_SYNC_IO === "1") {
    logRunner("Enabling Node --trace-sync-io for startup I/O diagnostics.", deps);
    args.push("--trace-sync-io");
  }
  return args;
};

// lyc: 等待子进程退出
const waitForSpawnedProcess = async (childProcess, deps) => {
  let forwardedSignal = null;
  let onSigInt;
  let onSigTerm;

  const cleanupSignals = () => {
    if (onSigInt) {
      deps.process.off("SIGINT", onSigInt);
    }
    if (onSigTerm) {
      deps.process.off("SIGTERM", onSigTerm);
    }
  };

  const forwardSignal = (signal) => {
    if (forwardedSignal) {
      return;
    }
    forwardedSignal = signal;
    try {
      childProcess.kill?.(signal);
    } catch {
      // Best-effort only. Exit handling still happens via the child "exit" event.
    }
  };

  onSigInt = () => {
    forwardSignal("SIGINT");
  };
  onSigTerm = () => {
    forwardSignal("SIGTERM");
  };

  deps.process.on("SIGINT", onSigInt);
  deps.process.on("SIGTERM", onSigTerm);

  try {
    return await new Promise((resolve) => {
      let settled = false;
      const settle = (res) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(res);
      };
      childProcess.on("error", (error) => {
        logRunner(`Spawn failed: ${error?.message ?? String(error)}`, deps);
        settle({ exitCode: 1, exitSignal: null, forwardedSignal });
      });
      childProcess.on("exit", (exitCode, exitSignal) => {
        settle({ exitCode, exitSignal, forwardedSignal });
      });
    });
  } finally {
    cleanupSignals();
  }
};

const getInterruptedSpawnExitCode = (res) => {
  if (res.exitSignal) {
    return getSignalExitCode(res.exitSignal);
  }
  if (res.forwardedSignal) {
    return getSignalExitCode(res.forwardedSignal);
  }
  return null;
};

// lyc: 运行/openclaw.mjs, 并返回exitCode
const runOpenClaw = async (deps) => {
  /* lyc: 命令参数, 例如: node myscript.js arg1 arg2 arg3, process.argv=['node', '/path/to/myscript.js', 'arg1', 'arg2', 'arg3'].slice(2)=['arg1', 'arg2', 'arg3']
    */
  // lyc:aic v2026.5：前面多加了 diagnosticArgs（CPU profile / trace-sync-io 等诊断 flag）
  const diagnosticArgs = resolveRunNodeDiagnosticArgs(deps);
  const nodeProcess = deps.spawn(deps.execPath, [...diagnosticArgs, "openclaw.mjs", ...deps.args], {
    cwd: deps.cwd,
    env: deps.env,
    stdio: deps.outputTee ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  // lyc: 管道OpenClaw进程的输出到标准输出和tee流
  pipeSpawnedOutput(nodeProcess, deps);
  // lyc: 等待OpenClaw进程退出
  const res = await waitForSpawnedProcess(nodeProcess, deps);
  const interruptedExitCode = getInterruptedSpawnExitCode(res);
  if (interruptedExitCode !== null) {
    return interruptedExitCode;
  }
  return res.exitCode ?? 1;
};

// lyc: 管道childProcess进程的输出到标准输出和tee流
const pipeSpawnedOutput = (childProcess, deps) => {
  if (!shouldPipeSpawnedOutput(deps)) {
    return;
  }
  const stderrFilter =
    deps.env[RUN_NODE_FILTER_SYNC_IO_STDERR_ENV] === "1"
      ? createSyncIoTraceStderrFilter(deps)
      : null;
  childProcess.stdout?.on("data", (chunk) => {
    writeRunnerStream(deps, deps.stdout, chunk);
    deps.outputTee?.write(chunk);
  });
  childProcess.stderr?.on("data", (chunk) => {
    deps.runNodeProgress?.clearLine();
    if (stderrFilter) {
      stderrFilter.write(chunk);
    } else {
      deps.stderr.write(chunk);
    }
    deps.runNodeProgress?.render();
    deps.outputTee?.write(chunk);
  });
  childProcess.stderr?.on("end", () => {
    stderrFilter?.flush();
  });
};

const createSyncIoTraceStderrFilter = (deps) => {
  let buffer = "";
  let inSyncIoTrace = false;

  const shouldSuppressLine = (line) => {
    const text = line.replace(/\r?\n$/, "");
    if (/^\(node:\d+\) WARNING: Detected use of sync API/.test(text)) {
      inSyncIoTrace = true;
      return true;
    }
    if (!inSyncIoTrace) {
      return false;
    }
    if (text.trim() === "") {
      inSyncIoTrace = false;
      return true;
    }
    if (/^\s+at\b/.test(text)) {
      return true;
    }
    inSyncIoTrace = false;
    return false;
  };

  const writeLine = (line) => {
    if (!shouldSuppressLine(line)) {
      deps.stderr.write(line);
    }
  };

  return {
    write(chunk) {
      buffer += String(chunk);
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }
        const line = buffer.slice(0, newlineIndex + 1);
        buffer = buffer.slice(newlineIndex + 1);
        writeLine(line);
      }
    },
    flush() {
      if (!buffer) {
        return;
      }
      writeLine(buffer);
      buffer = "";
    },
  };
};

// lyc: 关闭 正在运行的openclaw程序 的输出tee流, 并返回1或exitCode
// lyc: RunNode = Running Node = 正在运行的 Node.js 进程/程序 = 正在运行的openclaw程序 = openclaw
const closeRunNodeOutputTee = async (deps, exitCode) => {
  if (!deps.outputTee) {
    return exitCode;
  }
  try {
    await deps.outputTee.close();
  } catch (error) {
    deps.stderr.write(
      `[openclaw] Failed to write output log: ${error?.message ?? "unknown error"}\n`,
    );
    return exitCode === 0 ? 1 : exitCode;
  }
  return exitCode;
};

// lyc: 读取构建锁的owner.json文件, 并返回其记录的进程的pid, 如果owner.json文件不存在, 则返回null
const readBuildLockOwnerPid = (deps, lockDir) => {
  try {
    const raw = deps.fs.readFileSync(path.join(lockDir, "owner.json"), "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

// lyc: 构建锁的owner进程是否已死亡, true表示已死亡, false表示未死亡
const isBuildLockOwnerDead = (deps, pid) => {
  try {
    // lyc: 查进程是否存在的标准方法, signal=0时不会向目标进程发送任何信号, 只是检查目标进程是否存在，以及当前进程是否有权限向其发送信号
    // lyc: 如果进程存在且可访问，调用成功, 如果不存在会抛异常
    deps.process.kill(pid, 0);
    // lyc: 如果进程存在且可访问 返回false
    return false;
  } catch (error) {
    // lyc: 如果异常是ESRCH(进程未找到) 则返回true, 表示进程不存在, 否则返回false
    return error?.code === "ESRCH";
  }
};

// lyc: 移除过期的构建锁, true表示移除成功, false表示未移除成功
const removeStaleBuildLock = (deps, lockDir, staleMs) => {
  try {
    // lyc: 读取构建锁的owner.json文件, 并返回其记录的进程的pid, 如果owner.json文件不存在, 则返回null
    const ownerPid = readBuildLockOwnerPid(deps, lockDir);
    // lyc: 如果构建锁的owner进程已死亡, 则移除构建锁
    if (ownerPid !== null && isBuildLockOwnerDead(deps, ownerPid)) {
      deps.fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
    // lyc: 如果构建锁的owner进程未死亡, 则检查构建锁是否过期
    const stats = deps.fs.statSync(lockDir);
    if (Date.now() - stats.mtimeMs < staleMs) {
      return false;
    }
    // lyc: 如果构建锁过期, 则移除构建锁
    deps.fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};

/* lyc: 获取 正在运行的openclaw程序 的构建锁
lyc: RunNode = Running Node = 正在运行的 Node.js 进程/程序 = 正在运行的openclaw程序 = openclaw
*/
export const acquireRunNodeBuildLock = async (deps) => {
  const lockRoot = path.join(deps.cwd, ".artifacts");
  const lockDir = path.join(lockRoot, "run-node-build.lock");
  // lyc: 构建锁定超时毫秒数(MS)
  const timeoutMs = parsePositiveIntegerEnv(
    deps.env,
    // lyc: RunNode构建锁定超时环境变量
    RUN_NODE_BUILD_LOCK_TIMEOUT_ENV,
    // lyc: 默认构建锁定超时毫秒数(MS)
    DEFAULT_BUILD_LOCK_TIMEOUT_MS,
  );
  // lyc: 构建锁定轮询毫秒数(MS)
  const pollMs = parsePositiveIntegerEnv(
    deps.env,
    // lyc: RunNode构建锁轮询环境变量
    RUN_NODE_BUILD_LOCK_POLL_ENV,
    // lyc: 默认构建锁定轮询毫秒数(MS)
    DEFAULT_BUILD_LOCK_POLL_MS,
  );
  // lyc: 构建锁定过期毫秒数(MS)
  const staleMs = parsePositiveIntegerEnv(
    deps.env,
    // lyc: RunNode构建锁过期环境变量
    RUN_NODE_BUILD_LOCK_STALE_ENV,
    // lyc: 默认构建锁定过期毫秒数(MS)
    DEFAULT_BUILD_LOCK_STALE_MS,
  );
  const startedAt = Date.now();
  let loggedWait = false;
  // lyc: 等待构建锁, 如果没有超时继续等待, 否则抛出timed out waiting错误

  while (Date.now() - startedAt < timeoutMs) {
    try {
      deps.fs.mkdirSync(lockRoot, { recursive: true });
      deps.fs.mkdirSync(lockDir);
      try {
        deps.fs.writeFileSync(
          path.join(lockDir, "owner.json"),
          `${JSON.stringify(
            {
              pid: deps.process.pid,
              startedAt: new Date().toISOString(),
              args: deps.args,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } catch {
        // lyc: 写入owner.json文件失败, 说明构建锁已被其他进程占用
        // Owner metadata is diagnostic only; the directory itself is the lock.
        // lyc: Owner元数据仅用于诊断；目录本身是锁。
      }
      let released = false;
      // lyc: 释放构建锁, 删除构建锁目录
      const removeLockDir = () => {
        if (released) {
          return;
        }
        released = true;
        try {
          deps.fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // lyc: 删除构建锁目录失败, 说明构建锁已被其他进程占用
          // Best-effort cleanup; a follow-up waiter will fall back to staleness
          // detection if the directory is still present.
          // lyc: 尽最大努力进行清理；如果目录仍然存在，后续服务员将回退到失效检测。
        }
      };
      const onSignal = () => removeLockDir();
      const onExit = () => removeLockDir();
      deps.process.on("SIGINT", onSignal);
      deps.process.on("SIGTERM", onSignal);
      deps.process.on("exit", onExit);
      return () => {
        deps.process.off("SIGINT", onSignal);
        deps.process.off("SIGTERM", onSignal);
        deps.process.off("exit", onExit);
        removeLockDir();
      };
    } catch (error) {
      // lyc: 创建构建锁目录失败, 说明构建锁已被其他进程占用
      // lyc: 如果异常类型不是文件已存在(EEXIST), 则抛出错误
      if (error?.code !== "EEXIST") {
        throw error;
      }
      // lyc: 如果构建锁已被其他进程占用, 则尝试移除过期的构建锁, 如果移除成功, 则继续等待continue
      if (removeStaleBuildLock(deps, lockDir, staleMs)) {
        continue;
      }
      // lyc: 这里代表构建锁已被其他进程占用, 且移除失败
      // lyc: 如果没有记录等待信息, 则记录等待信息
      if (!loggedWait) {
        logRunner("Waiting for TypeScript/runtime artifact lock.", deps);
        loggedWait = true;
      }
      // lyc: 等待pollMs毫秒, 再次尝试获取构建锁
      await sleep(pollMs);
    }
  }

  // lyc: 如果构建锁获取超时, 则抛出timed out waiting错误
  throw new Error(`timed out waiting for ${path.relative(deps.cwd, lockDir)}`);
};

// lyc: 获取 正在运行的openclaw程序 的构建锁, 并在回调函数执行后释放构建锁
// lyc: RunNode = Running Node = 正在运行的 Node.js 进程/程序 = 正在运行的openclaw程序 = openclaw
const withRunNodeBuildLock = async (deps, callback) => {
  const release = await acquireRunNodeBuildLock(deps);
  try {
    return await callback();
  } finally {
    release();
  }
};

// lyc: 同步 运行时构件, artifacts: 构件,制品,产物; 指编译/运行过程产生的派生文件（如jar包、dll等）
const syncRuntimeArtifacts = async (deps) => {
  try {
    // lyc: 执行运行时后构建脚本, 就是在运行时才构建的一些文件
    await deps.runRuntimePostBuild({ cwd: deps.cwd, env: deps.env });
  } catch (error) {
    logRunner(
      `Failed to write runtime build artifacts: ${error?.message ?? "unknown error"}`,
      deps,
    );
    return false;
  }
  return true;
};

// lyc: 写入 运行时后构建戳(/home/openclaw/dist/.runtime-postbuildstamp)
const writeRuntimePostBuildStamp = (deps) => {
  try {
    writeDistRuntimePostBuildStamp({
      cwd: deps.cwd,
      fs: deps.fs,
      spawnSync: deps.spawnSync,
    });
  } catch (error) {
    logRunner(
      `Failed to write runtime postbuild stamp: ${error?.message ?? "unknown error"}`,
      deps,
    );
  }
};

/* lyc: 同步 构件 和 运行时后构建戳
*/
const syncRuntimeArtifactsAndStamp = async (deps) => {
  // lyc: 同步运行时构件
  const synced = await syncRuntimeArtifacts(deps);
  if (synced) {
    // lyc: 写入运行时后构建戳, 说明运行时构件已同步完成
    writeRuntimePostBuildStamp(deps);
  }
  return synced;
};

const writeBuildStamp = (deps) => {
  try {
    // lyc: 实现文件: scripts\build-stamp.mjs
    writeDistBuildStamp({
      cwd: deps.cwd,
      fs: deps.fs,
      spawnSync: deps.spawnSync,
    });
  } catch (error) {
    // Best-effort stamp; still allow the runner to start.
    logRunner(`Failed to write build stamp: ${error?.message ?? "unknown error"}`, deps);
  }
};

const shouldSkipWatchRuntimeSync = (deps, requirement) =>
  deps.env.OPENCLAW_WATCH_MODE === "1" &&
  requirement.reason === "missing_runtime_postbuild_stamp" &&
  hasDirtyRuntimePostBuildInputs(deps) !== true &&
  !hasMissingRequiredRuntimePostBuildOutput(deps);

const isGatewayClientCommand = (args) =>
  args[0] === "gateway" && (args[1] === "call" || args[1] === "status");

const shouldUseExistingDistForGatewayClient = (deps, buildRequirement) =>
  buildRequirement.reason === "dirty_watched_tree" &&
  isGatewayClientCommand(deps.args) &&
  deps.env.OPENCLAW_FORCE_BUILD !== "1" &&
  statMtime(deps.distEntry, deps.fs) != null;

const isQaParityReportCommand = (args) => args[0] === "qa" && args[1] === "parity-report";
const isQaCoverageReportCommand = (args) => args[0] === "qa" && args[1] === "coverage";

const shouldRunQaParityReportFromSource = (deps, buildRequirement) =>
  buildRequirement.reason === "missing_private_qa_dist" &&
  isQaParityReportCommand(deps.args) &&
  deps.env.OPENCLAW_FORCE_BUILD !== "1" &&
  statMtime(path.join(deps.cwd, "extensions", "qa-lab", "src", "cli.runtime.ts"), deps.fs) != null;

const shouldRunQaCoverageReportFromSource = (deps, buildRequirement) =>
  buildRequirement.reason === "missing_private_qa_dist" &&
  isQaCoverageReportCommand(deps.args) &&
  deps.env.OPENCLAW_FORCE_BUILD !== "1" &&
  statMtime(path.join(deps.cwd, "extensions", "qa-lab", "src", "cli.runtime.ts"), deps.fs) != null;

const runQaParityReportFromSource = async (deps) => {
  const sourceEntrypoint = path.join(deps.cwd, "scripts", "qa-parity-report.ts");
  const nodeProcess = deps.spawn(
    deps.execPath,
    ["--import", "tsx", sourceEntrypoint, ...deps.args.slice(2)],
    {
      cwd: deps.cwd,
      env: deps.env,
      stdio: deps.outputTee ? ["inherit", "pipe", "pipe"] : "inherit",
    },
  );
  pipeSpawnedOutput(nodeProcess, deps);
  const res = await waitForSpawnedProcess(nodeProcess, deps);
  const interruptedExitCode = getInterruptedSpawnExitCode(res);
  if (interruptedExitCode !== null) {
    return interruptedExitCode;
  }
  return res.exitCode ?? 1;
};

const runQaCoverageReportFromSource = async (deps) => {
  const sourceEntrypoint = path.join(deps.cwd, "scripts", "qa-coverage-report.ts");
  const nodeProcess = deps.spawn(
    deps.execPath,
    ["--import", "tsx", sourceEntrypoint, ...deps.args.slice(2)],
    {
      cwd: deps.cwd,
      env: deps.env,
      stdio: deps.outputTee ? ["inherit", "pipe", "pipe"] : "inherit",
    },
  );
  pipeSpawnedOutput(nodeProcess, deps);
  const res = await waitForSpawnedProcess(nodeProcess, deps);
  const interruptedExitCode = getInterruptedSpawnExitCode(res);
  if (interruptedExitCode !== null) {
    return interruptedExitCode;
  }
  return res.exitCode ?? 1;
};

export async function runNodeMain(params = {}) {
  const deps = {
    spawn: params.spawn ?? spawn,
    spawnSync: params.spawnSync ?? spawnSync,
    fs: params.fs ?? fs,
    stderr: params.stderr ?? process.stderr,
    stdout: params.stdout ?? process.stdout,
    process: params.process ?? process,
    // lyc: 代表node.js的可执行文件路径例如"/usr/lib/x4/node"
    execPath: params.execPath ?? process.execPath,
    // lyc: node.js进程当前的工作目录, 通常是启动 Node.js 进程时所在的目录，但也可以通过 process.chdir() 方法来改变
    // lyc: 例如运行node scripts/run-node.mjs, cwd()="/home/openclaw", openclaw目录下有scripts目录, scripts目录下有run-node.mjs
    cwd: params.cwd ?? process.cwd(),
    // lyc: 命令参数, 例如: node myscript.js arg1 arg2 arg3, process.argv=['node', '/path/to/myscript.js', 'arg1', 'arg2', 'arg3'].slice(2)=['arg1', 'arg2', 'arg3']
    args: params.args ?? process.argv.slice(2),
    env: params.env ? { ...params.env } : { ...process.env },
    runRuntimePostBuild: params.runRuntimePostBuild ?? runRuntimePostBuild,
  };

  // lyc: 分发目录: /home/openclaw/dist
  deps.distRoot = path.join(deps.cwd, "dist");
  // lyc: 分发目录下的入口文件: /home/openclaw/dist/entry.js
  deps.distEntry = path.join(deps.distRoot, "/entry.js");
  // Stamp: 标记/戳记, 常指记录时间或版本信息
  // lyc: 分发目录下的 构建戳文件 (.buildstamp 是文件): /home/openclaw/dist/.buildstamp
  // lyc:aic v2026.5：文件名常量改成从 ./lib/local-build-metadata.mjs 导入的 BUILD_STAMP_FILE
  deps.buildStampPath = path.join(deps.distRoot, BUILD_STAMP_FILE);
  // PostBuild: 后构建, 前缀"Post-"（在……之后）+ 词根"Build"（构建）, 构建过程完成之后所执行的步骤或任务
  // lyc: 分发目录下的 运行时后构建戳文件 (.runtime-postbuildstamp 是文件): /home/openclaw/dist/.runtime-postbuildstamp
  // lyc:aic v2026.5：常量改成从 ./lib/local-build-metadata.mjs 导入的 RUNTIME_POSTBUILD_STAMP_FILE
  deps.runtimePostBuildStampPath = path.join(deps.distRoot, RUNTIME_POSTBUILD_STAMP_FILE);
  // lyc: 源代码根目录: [cwd()/src, cwd()/extensions]
  deps.sourceRoots = runNodeSourceRoots.map((sourceRoot) => ({
    name: sourceRoot,
    path: path.join(deps.cwd, sourceRoot),
  }));
  // lyc: 配置文件路径: [cwd()/tsconfig.json, cwd()/package.json, cwd()/tsdown.config.ts]
  deps.configFiles = runNodeConfigFiles.map((filePath) => path.join(deps.cwd, filePath));
  // lyc: 私有的 QA（Quality Assurance，质量保证）文件路径: [distRoot/plugin-sdk/qa-lab.js, distRoot/plugin-sdk/qa-runtime.js]
  deps.privateQaRequiredDistEntries = resolvePrivateQaRequiredDistEntries(deps.distRoot);
  if (deps.args[0] === "qa") {
    // lyc: 控制在构建过程中是否执行私有的QA测试, 质量检测机制, 集成QA工具或模块
    deps.env.OPENCLAW_BUILD_PRIVATE_QA = "1";
    // lyc: 控制CLI中私有的QA功能是否启用
    deps.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
    deps.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS ??= "0";
  }
  // lyc: 创建 正在运行的openclaw程序 的输出tee流
  deps.outputTee = createRunNodeOutputTee(deps);

  try {
    let exitCode = 1;
    // lyc: 解决构建需求, 检查是否需要构建
    let buildRequirement = resolveBuildRequirement(deps);
    // lyc:aic v2026.5 新增 3 个分支：
    //   1) 如果 gateway 客户端有现成 dist 就不重建（useExistingGatewayClientDist）
    //   2) 从源码跑 QA parity report（不重建 QA dist）
    //   3) 从源码跑 QA coverage report（不重建 QA dist）
    const useExistingGatewayClientDist = shouldUseExistingDistForGatewayClient(
      deps,
      buildRequirement,
    );
    const useQaParityReportSource = shouldRunQaParityReportFromSource(deps, buildRequirement);
    const useQaCoverageReportSource = shouldRunQaCoverageReportFromSource(deps, buildRequirement);
    if (useExistingGatewayClientDist) {
      buildRequirement = { shouldBuild: false, reason: "gateway_client_existing_dist" };
    }
    if (useQaParityReportSource) {
      logRunner("Running QA parity report from source without rebuilding private QA dist.", deps);
      exitCode = await runQaParityReportFromSource(deps);
      return await closeRunNodeOutputTee(deps, exitCode);
    }
    if (useQaCoverageReportSource) {
      logRunner("Running QA coverage report from source without rebuilding private QA dist.", deps);
      exitCode = await runQaCoverageReportFromSource(deps);
      return await closeRunNodeOutputTee(deps, exitCode);
    }
    // lyc: 如果不需要构建
    if (!buildRequirement.shouldBuild) {
      // lyc:aic v2026.5：原本是 if(!shouldSkipCleanWatchRuntimeSync(deps)) —— 现在还要排除 useExistingGatewayClientDist 的场景
      if (!useExistingGatewayClientDist) {
        // lyc: 解决运行时后构建需求, 检查是否需要运行时后构建
        const runtimePostBuildRequirement = resolveRuntimePostBuildRequirement(deps);
        // lyc: 如果需要运行时后构建, 则需要 同步 运行时构件 和 运行时后构建戳
        // lyc:aic v2026.5：多了一个 shouldSkipWatchRuntimeSync 守卫，避免在 watch 模式重复同步
        if (
          runtimePostBuildRequirement.shouldSync &&
          !shouldSkipWatchRuntimeSync(deps, runtimePostBuildRequirement)
        ) {
          const synced = await withRunNodeBuildLock(deps, async () => {
            const lockedRuntimePostBuildRequirement = resolveRuntimePostBuildRequirement(deps);
            // lyc: 如果不需要运行时后构建, 则直接返回true
            if (!lockedRuntimePostBuildRequirement.shouldSync) {
              return true;
            }
            // lyc: 如果需要运行时后构建, 则记录同步运行时后构建戳的原因
            logRunner(
              `Syncing runtime artifacts (${lockedRuntimePostBuildRequirement.reason} - ${formatRuntimePostBuildReason(lockedRuntimePostBuildRequirement.reason)}).`,
              deps,
            );
            // lyc: 同步 运行时构件 和 运行时后构建戳
            return await syncRuntimeArtifactsAndStamp(deps);
          });
          // lyc: 如果 同步 运行时构件 和 运行时后构建戳 失败, 则返回1 退出程序
          if (!synced) {
            return await closeRunNodeOutputTee(deps, 1);
          }
        }
      }
      // lyc: 运行OpenClaw, 没有执行构建流程, 但可能执行了 运行时后构建流程
      exitCode = await runOpenClaw(deps);
      return await closeRunNodeOutputTee(deps, exitCode);
    }

    // lyc: 这里代表需要构建

    // lyc: 根据需要执行 构建 和 运行时后构建 流程并获得构建退出码, 0表示成功, 其他表示失败
    const buildExitCode = await withRunNodeBuildLock(deps, async () => {
      const lockedBuildRequirement = resolveBuildRequirement(deps);
      if (!lockedBuildRequirement.shouldBuild) {
        const runtimePostBuildRequirement = resolveRuntimePostBuildRequirement(deps);
        if (!runtimePostBuildRequirement.shouldSync) {
          return 0;
        }
        logRunner(
          `Syncing runtime artifacts (${runtimePostBuildRequirement.reason} - ${formatRuntimePostBuildReason(runtimePostBuildRequirement.reason)}).`,
          deps,
        );
        return (await syncRuntimeArtifactsAndStamp(deps)) ? 0 : 1;
      }
      

      logRunner(
        `Building TypeScript (dist is stale: ${lockedBuildRequirement.reason} - ${formatBuildReason(lockedBuildRequirement.reason)}).`,
        deps,
      );
      logRunner("Building bundled plugin assets.", deps);
      const buildCmd = deps.execPath;
      // lyc:aic v2026.5 大改造：构建分两步——
      //   先 spawn bundledPluginAssetBuildArgs（捆绑插件资源），再 spawn compilerArgs（主 tsdown 构建）。
      //   整体用 withRunNodeProgress("Building local CLI artifacts") 包了一个进度条。
      //   stdio 也从单一 deps.outputTee 改为更通用的 shouldPipeSpawnedOutput(deps)。
      const compileExitCode = await withRunNodeProgress(
        deps,
        "Building local CLI artifacts",
        async () => {
          // lyc:aic 第 1 步：构建捆绑插件资源
          const assetBuild = deps.spawn(buildCmd, bundledPluginAssetBuildArgs, {
            cwd: deps.cwd,
            env: deps.env,
            stdio: shouldPipeSpawnedOutput(deps) ? ["inherit", "pipe", "pipe"] : "inherit",
          });
          pipeSpawnedOutput(assetBuild, deps);
          const assetBuildRes = await waitForSpawnedProcess(assetBuild, deps);
          const assetBuildInterruptedExitCode = getInterruptedSpawnExitCode(assetBuildRes);
          if (assetBuildInterruptedExitCode !== null) {
            return assetBuildInterruptedExitCode;
          }
          if (assetBuildRes.exitCode !== 0 && assetBuildRes.exitCode !== null) {
            return assetBuildRes.exitCode;
          }

          // lyc: 执行构建命令: node scripts/tsdown-build.mjs --no-clean
          const build = deps.spawn(buildCmd, compilerArgs, {
            cwd: deps.cwd,
            env: deps.env,
            stdio: shouldPipeSpawnedOutput(deps) ? ["inherit", "pipe", "pipe"] : "inherit",
          });
          // lyc: 管道构建进程的输出到标准输出和 tee 流
          pipeSpawnedOutput(build, deps);

          // lyc: 等待构建进程退出
          const buildRes = await waitForSpawnedProcess(build, deps);
          const interruptedExitCode = getInterruptedSpawnExitCode(buildRes);
          if (interruptedExitCode !== null) {
            return interruptedExitCode;
          }
          if (buildRes.exitCode !== 0 && buildRes.exitCode !== null) {
            return buildRes.exitCode;
          }
          return 0;
        },
      );
      if (compileExitCode !== 0) {
        return compileExitCode;
      }
      // lyc: 执行运行时后构建脚本, 就是在运行时才构建的一些文件
      if (!(await syncRuntimeArtifacts(deps))) {
        return 1;
      }
      // lyc: 写入 构建戳文件(.buildstamp是文件): /home/openclaw/dist/.buildstamp
      writeBuildStamp(deps);
      // lyc: 写入 运行时后构建戳文件(/home/openclaw/dist/.runtime-postbuildstamp)
      writeRuntimePostBuildStamp(deps);
      return 0;
    });
    if (buildExitCode !== 0) {
      return await closeRunNodeOutputTee(deps, buildExitCode);
    }
    // lyc: 运行OpenClaw
    exitCode = await runOpenClaw(deps);
    return await closeRunNodeOutputTee(deps, exitCode);
  } catch (error) {
    await closeRunNodeOutputTee(deps, 1);
    throw error;
  }
}

/* lyc: 主程序入口
*/
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runNodeMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
