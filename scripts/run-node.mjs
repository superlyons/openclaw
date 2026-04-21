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
const ignoredRunNodeRepoPaths = new Set([
  "src/canvas-host/a2ui/.bundle.hash",
  "src/canvas-host/a2ui/a2ui.bundle.js",
]);
const extensionSourceFilePattern = /\.(?:[cm]?[jt]sx?)$/;
const extensionRestartMetadataFiles = new Set(["openclaw.plugin.json", "package.json"]);

const normalizePath = (filePath) => String(filePath ?? "").replaceAll("\\", "/");

const isIgnoredSourcePath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  return (
    normalizedPath.endsWith(".test.ts") ||
    normalizedPath.endsWith(".test.tsx") ||
    normalizedPath.endsWith("test-helpers.ts")
  );
};

const isBuildRelevantSourcePath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  return extensionSourceFilePattern.test(normalizedPath) && !isIgnoredSourcePath(normalizedPath);
};

export const isBuildRelevantRunNodePath = (repoPath) => {
  const normalizedPath = normalizePath(repoPath).replace(/^\.\/+/, "");
  if (ignoredRunNodeRepoPaths.has(normalizedPath)) {
    return false;
  }
  if (runNodeConfigFiles.includes(normalizedPath)) {
    return true;
  }
  if (normalizedPath.startsWith("src/")) {
    return !isIgnoredSourcePath(normalizedPath.slice("src/".length));
  }
  if (normalizedPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return isBuildRelevantSourcePath(normalizedPath.slice(BUNDLED_PLUGIN_PATH_PREFIX.length));
  }
  return false;
};

const isRestartRelevantExtensionPath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  if (extensionRestartMetadataFiles.has(path.posix.basename(normalizedPath))) {
    return true;
  }
  return isBuildRelevantSourcePath(normalizedPath);
};

export const isRestartRelevantRunNodePath = (repoPath) => {
  const normalizedPath = normalizePath(repoPath).replace(/^\.\/+/, "");
  if (ignoredRunNodeRepoPaths.has(normalizedPath)) {
    return false;
  }
  if (runNodeConfigFiles.includes(normalizedPath)) {
    return true;
  }
  if (normalizedPath.startsWith("src/")) {
    return !isIgnoredSourcePath(normalizedPath.slice("src/".length));
  }
  if (normalizedPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return isRestartRelevantExtensionPath(normalizedPath.slice(BUNDLED_PLUGIN_PATH_PREFIX.length));
  }
  return false;
};

const statMtime = (filePath, fsImpl = fs) => {
  try {
    return fsImpl.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const isExcludedSource = (filePath, sourceRoot, sourceRootName) => {
  const relativePath = normalizePath(path.relative(sourceRoot, filePath));
  if (relativePath.startsWith("..")) {
    return false;
  }
  return !isBuildRelevantRunNodePath(path.posix.join(sourceRootName, relativePath));
};

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
git status --porcelain --untracked-files=normal -- src package.json
--porcelain: 使 git status 的输出格式更加机器可读
--untracked-files=normal: 包含未跟踪的文件,那些新添加到仓库中但尚未被 git add 添加到暂存区的文件
-- src package.json: 告诉 Git 只关注 src 目录和 package.json 文件的状态
*/
const readGitStatus = (deps) => {
  try {
    const result = deps.spawnSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal", "--", ...runNodeWatchedPaths],
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

const parseGitStatusPaths = (output) =>
  output
    .split("\n")
    .flatMap((line) => line.slice(3).split(" -> "))
    .map((entry) => normalizePath(entry.trim()))
    .filter(Boolean);

const hasDirtySourceTree = (deps) => {
  const output = readGitStatus(deps);
  if (output === null) {
    return null;
  }
  return parseGitStatusPaths(output).some((repoPath) => isBuildRelevantRunNodePath(repoPath));
};

// lyc: 读取构建戳文件(/home/openclaw/dist/.openclaw/.buildstamp文件), 
// lyc: 返回{mtime: 文件修改时间|null, head: 文件.head内容|null}
const readBuildStamp = (deps) => {
  const mtime = statMtime(deps.buildStampPath, deps.fs);
  if (mtime == null) {
    return { mtime: null, head: null };
  }
  try {
    const raw = deps.fs.readFileSync(deps.buildStampPath, "utf8").trim();
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

// lyc: 解决构建需求, 检查是否需要构建
export const resolveBuildRequirement = (deps) => {
  // lyc: 强制构建, 无论是否需要构建
  if (deps.env.OPENCLAW_FORCE_BUILD === "1") {
    return { shouldBuild: true, reason: "force_build" };
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
  // lyc: 如果当前Git分支的HEAD与构建戳文件中的HEAD相同, 则需要检查是否有脏的源树修改, 即是否有未提交的更改或新添加的文件需要被处理
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

const BUILD_REASON_LABELS = {
  force_build: "forced by OPENCLAW_FORCE_BUILD",
  missing_build_stamp: "build stamp missing",
  missing_dist_entry: "dist entry missing",
  config_newer: "config newer than build stamp",
  build_stamp_missing_head: "build stamp missing git head",
  git_head_changed: "git head changed",
  dirty_watched_tree: "dirty watched source tree",
  source_mtime_newer: "source mtime newer than build stamp",
  clean: "clean",
};

const formatBuildReason = (reason) => BUILD_REASON_LABELS[reason] ?? reason;

const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
};

const isSignalKey = (signal) => Object.hasOwn(SIGNAL_EXIT_CODES, signal);

const getSignalExitCode = (signal) => (isSignalKey(signal) ? SIGNAL_EXIT_CODES[signal] : 1);

const logRunner = (message, deps) => {
  if (deps.env.OPENCLAW_RUNNER_LOG === "0") {
    return;
  }
  deps.stderr.write(`[openclaw] ${message}\n`);
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
      childProcess.on("exit", (exitCode, exitSignal) => {
        resolve({ exitCode, exitSignal, forwardedSignal });
      });
    });
  } finally {
    cleanupSignals();
  }
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
    stdio: "inherit",
  });
  // lyc: 等待OpenClaw进程退出
  const res = await waitForSpawnedProcess(nodeProcess, deps);
  if (res.exitSignal) {
    return getSignalExitCode(res.exitSignal);
  }
  if (res.forwardedSignal) {
    return getSignalExitCode(res.forwardedSignal);
  }
  return res.exitCode ?? 1;
};

// lyc: 运行时后构建(post-build)流程 如果发生错误输出日志, 并返回false,否则返回true
const syncRuntimeArtifacts = (deps) => {
  try {
    deps.runRuntimePostBuild({ cwd: deps.cwd });
  } catch (error) {
    logRunner(
      `Failed to write runtime build artifacts: ${error?.message ?? "unknown error"}`,
      deps,
    );
    return false;
  }
  return true;
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
  // lyc: 分发目录下的构建戳文件(.buildstamp是文件): /home/openclaw/dist/.buildstamp
  deps.buildStampPath = path.join(deps.distRoot, ".buildstamp");
  // lyc: 源代码根目录: [/home/openclaw/src, /home/openclaw/extensions]
  deps.sourceRoots = runNodeSourceRoots.map((sourceRoot) => ({
    name: sourceRoot,
    path: path.join(deps.cwd, sourceRoot),
  }));
  // lyc: 配置文件路径: [/home/openclaw/tsconfig.json, /home/openclaw/package.json, /home/openclaw/tsdown.config.ts]
  deps.configFiles = runNodeConfigFiles.map((filePath) => path.join(deps.cwd, filePath));

  // lyc: 解决构建需求, 检查是否需要构建
  const buildRequirement = resolveBuildRequirement(deps);
  // lyc: 如果不需要构建, 则直接运行OpenClaw
  if (!buildRequirement.shouldBuild) {
    // lyc: env.OPENCLAW_WATCH_MODE !== "1" && 执行 运行时后构建(post-build)流程(runRuntimePostBuild) 发生错误(返回false)
    if (!shouldSkipCleanWatchRuntimeSync(deps) && !syncRuntimeArtifacts(deps)) {
      return 1;
    }
    // lyc: 执行到此代表不需要构建, 则直接运行OpenClaw
    return await runOpenClaw(deps);
  }

  // lyc: 这里代表需要构建

  logRunner(
    `Building TypeScript (dist is stale: ${buildRequirement.reason} - ${formatBuildReason(buildRequirement.reason)}).`,
    deps,
  );
  const buildCmd = deps.execPath;
  const buildArgs = compilerArgs;
  // lyc: 执行构建命令: node scripts/tsdown-build.mjs --no-clean
  const build = deps.spawn(buildCmd, buildArgs, {
    cwd: deps.cwd,
    env: deps.env,
    stdio: "inherit",
  });

  const buildRes = await waitForSpawnedProcess(build, deps);
  if (buildRes.exitSignal) {
    return getSignalExitCode(buildRes.exitSignal);
  }
  if (buildRes.forwardedSignal) {
    return getSignalExitCode(buildRes.forwardedSignal);
  }
  if (buildRes.exitCode !== 0 && buildRes.exitCode !== null) {
    return buildRes.exitCode;
  }
  // lyc: 执行 运行时后构建(post-build)流程(runRuntimePostBuild) 发生错误(返回false)
  if (!syncRuntimeArtifacts(deps)) {
    return 1;
  }
  // lyc: 写入构建戳文件(.buildstamp是文件): /home/openclaw/dist/.buildstamp
  writeBuildStamp(deps);
  // lyc: 运行OpenClaw
  return await runOpenClaw(deps);
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
