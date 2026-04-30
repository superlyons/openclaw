#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolveGitHead, writeBuildStamp as writeDistBuildStamp } from "./build-stamp.mjs";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";
import { runRuntimePostBuild } from "./runtime-postbuild.mjs";

const buildScript = "scripts/tsdown-build.mjs";
const compilerArgs = [buildScript, "--no-clean"];

const runNodeSourceRoots = ["src", BUNDLED_PLUGIN_ROOT_DIR];
const runNodeConfigFiles = ["tsconfig.json", "package.json", "tsdown.config.ts"];
export const runNodeWatchedPaths = [...runNodeSourceRoots, ...runNodeConfigFiles];
const runtimePostBuildStampFile = ".runtime-postbuildstamp";
const runtimePostBuildWatchedPaths = [
  "scripts/copy-bundled-plugin-metadata.mjs",
  "scripts/copy-plugin-sdk-root-alias.mjs",
  "scripts/lib",
  "scripts/npm-runner.mjs",
  "scripts/runtime-postbuild-shared.mjs",
  "scripts/runtime-postbuild.mjs",
  "scripts/stage-bundled-plugin-runtime-deps.mjs",
  "scripts/stage-bundled-plugin-runtime.mjs",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/write-official-channel-catalog.mjs",
  "src/plugin-sdk/root-alias.cjs",
  BUNDLED_PLUGIN_ROOT_DIR,
];
const ignoredRunNodeRepoPaths = new Set([
  "src/canvas-host/a2ui/.bundle.hash",
  "src/canvas-host/a2ui/a2ui.bundle.js",
]);
const runtimePostBuildScriptPaths = new Set(
  runtimePostBuildWatchedPaths.filter((entry) => entry.startsWith("scripts/")),
);
const runtimePostBuildStaticAssetPaths = new Set([
  "extensions/acpx/src/runtime-internals/mcp-proxy.mjs",
  "extensions/diffs/assets/viewer-runtime.js",
]);
/* lyc: 匹配一下扩展名: js, jsx, ts, tsx, cjs, cjsx, cts, csx, mjs, mjsx, mts, mtx
.js - JavaScript 文件
.jsx - JSX (React) 文件
.ts - TypeScript 文件
.tsx - TSX (TypeScript + React) 文件
.cjs - CommonJS 文件
.cjsx - CommonJS + JSX 文件 (较少见)
.cts - CommonJS + TypeScript 文件
.ctsx - CommonJS + TSX 文件 (较少见)
.mjs - ES Module 文件
.mjsx - ES Module + JSX 文件 (较少见)
.mts - ES Module + TypeScript 文件
.mtsx - ES Module + TSX 文件 (较少见)
*/
const extensionSourceFilePattern = /\.(?:[cm]?[jt]sx?)$/;
const extensionRestartMetadataFiles = new Set(["openclaw.plugin.json", "package.json"]);

const normalizePath = (filePath) => String(filePath ?? "").replaceAll("\\", "/");

// lyc: 忽略以下结尾的文件: .test.ts, .test.tsx, test-helpers.ts
const isIgnoredSourcePath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  return (
    normalizedPath.endsWith(".test.ts") ||
    normalizedPath.endsWith(".test.tsx") ||
    normalizedPath.endsWith("test-helpers.ts")
  );
};

// lyc: Build阶段relativePath是否是可构建|编译的源文件
const isBuildRelevantSourcePath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  // lyc: 以源文件扩展名结尾的文件, 且不是忽略的文件 则认为relativePath是可以被构造的
  return extensionSourceFilePattern.test(normalizedPath) && !isIgnoredSourcePath(normalizedPath);
};
// lyc: Restart阶段relativePath是否是可构建|编译的源文件
const isRestartRelevantExtensionPath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  // lyc: 是openclaw.plugin.json, package.json 
  if (extensionRestartMetadataFiles.has(path.posix.basename(normalizedPath))) {
    return true;
  }
  return isBuildRelevantSourcePath(normalizedPath);
};

/* lyc: 是否和openclaw相关的路径, 即repoPath是否是可构建|编译的源文件
RunNode: Running Node 的缩写，即“正在运行的 Node.js 进程/程序”。
正在运行的 Node.js 进程/程序 = 正在运行的openclaw程序 = openclaw
是否和正在运行的Node程序相关的路径 = 是否和正在运行的openclaw程序相关的路径 = 是否和openclaw相关的路径
*/
const isRelevantRunNodePath = (repoPath, isRelevantBundledPluginPath) => {
  const normalizedPath = normalizePath(repoPath).replace(/^\.\/+/, "");
  // lyc: 忽略以下文件: src/canvas-host/a2ui/.bundle.hash , src/canvas-host/a2ui/a2ui.bundle.js
  if (ignoredRunNodeRepoPaths.has(normalizedPath)) {
    return false;
  }
  // lyc: 是相关的配置文件: tsconfig.json, package.json, tsdown.config.ts
  if (runNodeConfigFiles.includes(normalizedPath)) {
    return true;
  }
  // lyc: 如果以"src/"目录开头, 且不是忽略的文件,则需要构造
  if (normalizedPath.startsWith("src/")) {
    return !isIgnoredSourcePath(normalizedPath.slice("src/".length));
  }
  // lyc: 如果以"extensions/"目录开头, 且是可构建|编译的源文件, 则需要构造
  if (normalizedPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return isRelevantBundledPluginPath(normalizedPath.slice(BUNDLED_PLUGIN_PATH_PREFIX.length));
  }
  return false;
};

// lyc: 是否是构建相关的当前运行的openclaw程序所关注路径
export const isBuildRelevantRunNodePath = (repoPath) =>
  isRelevantRunNodePath(repoPath, isBuildRelevantSourcePath);

// lyc: 是否是重启相关的当前运行的openclaw程序所关注路径
export const isRestartRelevantRunNodePath = (repoPath) =>
  isRelevantRunNodePath(repoPath, isRestartRelevantExtensionPath);

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
检查是否有未提交的更改或新添加的文件需要被处理
git status --porcelain --untracked-files=normal -- src extensions tsconfig.json package.json tsdown.config.ts
--porcelain: 使 git status 的输出格式更加机器可读
--untracked-files=normal: 包含未跟踪的文件,那些新添加到仓库中但尚未被 git add 添加到暂存区的文件
-- src extensions tsconfig.json package.json tsdown.config.ts: 告诉 Git 只关注 src, extensions 目录和tsconfig.json package.json tsdown.config.ts 文件的状态
命令输出示例如下:
M  src/index.ts
 D extensions/old-file.ts
?? new-file.ts
R  old-name.ts -> new-name.ts
 A package.json
第1个字符：工作区状态 (M=修改, A=新增, D=删除, R=重命名, ?=未跟踪)
第2个字符：暂存区状态 (M=修改, D=删除等)
第3个字符：空格
第4个字符开始：文件路径名
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
M  src/index.ts
 D extensions/old-file.ts
?? new-file.ts
R  old-name.ts -> new-name.ts
 A package.json
*/
const parseGitStatusPaths = (output) =>
  output
    .split("\n")
    /* lyc: 切掉前3个字符(状态码)，然后按" -> "分割(处理重命名情况), 之后再扁平化, 即先map在flat(1) 即先映射再扁平化一层。
      例如: 
      先映射(执行line.slice(3).split(" -> ")): [["src/index.ts"], ["extensions/old-file.ts"], ["new-file.ts"], ["old-name.ts", "new-name.ts"], ["package.json"]]
      扁平化一层: ["src/index.ts", "extensions/old-file.ts", "new-file.ts", "old-name.ts", "new-name.ts", "package.json"]
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
  // 获得git status命令输出中所有的文件路径名, 并检查是否有是构建相关路径
  return parseGitStatusPaths(output).some((repoPath) => isBuildRelevantRunNodePath(repoPath));
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
  if (pluginRelativePath.startsWith("skills/")) {
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
  
// lyc: 解决构建需求, 检查是否需要构建
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
    配置文件路径[/home/openclaw/tsconfig.json, /home/openclaw/package.json, /home/openclaw/tsdown.config.ts]
    如果配置文件修改时间大于构建戳文件修改时间, 则需要构建
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
      return { shouldBuild: false, reason: "clean" };
    }
  }

  // lyc: 执行到此代表没有git环境, 则需要通过检查源文件修改时间来判断是否需要构建
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
      return { shouldSync: false, reason: "clean" };
    }
  }

   // lyc: 执行到此代表没有git环境, 则需要通过检查 运行时后构建输入 修改时间来判断是否需要运行时后构建  
  if (hasRuntimePostBuildInputMtimeChanged(stamp.mtime, deps)) {
    return { shouldSync: true, reason: "runtime_postbuild_input_mtime_newer" };
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
  source_mtime_newer: "source mtime newer than build stamp",
  missing_private_qa_dist: "private QA dist entry missing",
  clean: "clean",
};

const RUNTIME_POSTBUILD_REASON_LABELS = {
  force_runtime_postbuild: "forced by OPENCLAW_FORCE_RUNTIME_POSTBUILD",
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
  deps.stderr.write(line);
  deps.outputTee?.write(line);
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

/** lyc:ai
 * 运行OpenClaw
 * 
 * 此函数启动 OpenClaw 应用程序，将命令行参数传递给它。
 * 应用程序的退出码将被返回，用于判断是否成功运行。
 */
const runOpenClaw = async (deps) => {
  /* lyc: 命令参数, 例如: node myscript.js arg1 arg2 arg3, process.argv=['node', '/path/to/myscript.js', 'arg1', 'arg2', 'arg3'].slice(2)=['arg1', 'arg2', 'arg3']
    deps.args 为命令行参数, 例如: ['arg1', 'arg2', 'arg3']
    执行OpenClaw进程, 并将命令行参数传递给它
    例如: node openclaw.mjs arg1 arg2 arg3
    */
  const nodeProcess = deps.spawn(deps.execPath, ["openclaw.mjs", ...deps.args], {
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
  if (!deps.outputTee) {
    return;
  }
  childProcess.stdout?.on("data", (chunk) => {
    deps.stdout.write(chunk);
    deps.outputTee.write(chunk);
  });
  childProcess.stderr?.on("data", (chunk) => {
    deps.stderr.write(chunk);
    deps.outputTee.write(chunk);
  });
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
artifacts: 构件,制品,产物; 指编译/运行过程产生的派生文件（如jar包、dll等）
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
    deps.fs.mkdirSync(path.dirname(deps.runtimePostBuildStampPath), { recursive: true });
    const head = resolveGitHead(deps);
    deps.fs.writeFileSync(
      deps.runtimePostBuildStampPath,
      `${JSON.stringify(
        {
          syncedAt: Date.now(),
          ...(head ? { head } : {}),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch (error) {
    logRunner(
      `Failed to write runtime postbuild stamp: ${error?.message ?? "unknown error"}`,
      deps,
    );
  }
};

/* lyc: 同步 构件 和 运行时后构建戳
artifacts: 构件,制品,产物; 指编译/运行过程产生的派生文件（如jar包、dll等）
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

const shouldSkipCleanWatchRuntimeSync = (deps) => deps.env.OPENCLAW_WATCH_MODE === "1";

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
  // lyc: 分发目录下的 构建戳文件(.buildstamp是文件): /home/openclaw/dist/.buildstamp
  deps.buildStampPath = path.join(deps.distRoot, ".buildstamp");
  // PostBuild: 后构建, 前缀“Post-”（在……之后）+ 词根“Build”（构建）, 构建过程完成之后所执行的步骤或任务
  // lyc: 分发目录下的 运行时后构建戳文件(.runtime-postbuildstamp是文件): /home/openclaw/dist/.runtime-postbuildstamp
  deps.runtimePostBuildStampPath = path.join(deps.distRoot, runtimePostBuildStampFile);
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
  }
  // lyc: 创建 正在运行的openclaw程序 的输出tee流
  deps.outputTee = createRunNodeOutputTee(deps);

  try {
    let exitCode = 1;
    // lyc: 解决构建需求, 检查是否需要构建
    const buildRequirement = resolveBuildRequirement(deps);
    // lyc: 如果不需要构建
    if (!buildRequirement.shouldBuild) {
      // lyc: env.OPENCLAW_WATCH_MODE !== "1" 即不是watch模式, 则需要检查是否需要 运行时后构建
      if (!shouldSkipCleanWatchRuntimeSync(deps)) {
        // lyc: 解决运行时后构建需求, 检查是否需要运行时后构建
        const runtimePostBuildRequirement = resolveRuntimePostBuildRequirement(deps);
        // lyc: 如果需要运行时后构建, 则需要 同步 运行时构件 和 运行时后构建戳
        if (runtimePostBuildRequirement.shouldSync) {
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
      const buildCmd = deps.execPath;
      const buildArgs = compilerArgs;

      // lyc: 执行构建命令: node scripts/tsdown-build.mjs --no-clean
      const build = deps.spawn(buildCmd, buildArgs, {
        cwd: deps.cwd,
        env: deps.env,
        stdio: deps.outputTee ? ["inherit", "pipe", "pipe"] : "inherit",
      });
      // lyc: 管道构建进程的输出到标准输出和tee流
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
package.json.scripts["dev"] = node scripts/run-node.mjs
npm run dev 会执行node scripts/run-node.mjs, 因此process.argv[1]="scripts/run-node.mjs"
即如果是在命令行中运行了node scripts/run-node.mjs则条件为true
*/
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runNodeMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
