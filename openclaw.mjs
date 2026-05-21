#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 16;
const MIN_NODE_VERSION = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;

const parseNodeVersion = (rawVersion) => {
  const [majorRaw = "0", minorRaw = "0"] = rawVersion.split(".");
  return {
    major: Number(majorRaw),
    minor: Number(minorRaw),
  };
};

const isSupportedNodeVersion = (version) =>
  version.major > MIN_NODE_MAJOR ||
  (version.major === MIN_NODE_MAJOR && version.minor >= MIN_NODE_MINOR);

// lyc: 确保Node.js版本符合要求 >= 22.12
// lyc: 如果当前Node.js版本低于要求, 则提示用户并退出程序
const ensureSupportedNodeVersion = () => {
  if (isSupportedNodeVersion(parseNodeVersion(process.versions.node))) {
    return;
  }

  process.stderr.write(
    `openclaw: Node.js v${MIN_NODE_VERSION}+ is required (current: v${process.versions.node}).\n` +
      "If you use nvm, run:\n" +
      `  nvm install ${MIN_NODE_MAJOR}\n` +
      `  nvm use ${MIN_NODE_MAJOR}\n` +
      `  nvm alias default ${MIN_NODE_MAJOR}\n`,
  );
  process.exit(1);
};

// lyc: 确保Node.js版本符合要求 >= 22.12
ensureSupportedNodeVersion();

// lyc:aic v2026.5 大改造：原本一个 `if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE)`
//         的简单块被抽成 5 个 helper（isSourceCheckoutLauncher/isNodeCompileCacheDisabled/
//         isNodeCompileCacheRequested/sanitizeCompileCachePathSegment/readPackageVersion）+
//         一套 respawn 流程（runRespawnedChild / respawnWithoutCompileCacheIfNeeded /
//         respawnWithPackagedCompileCacheIfNeeded）。原始 lyc 注释搬到下方真正 enableCompileCache 调用处。

// lyc:aic 判断当前是不是"源码 checkout 启动"（看是否有 .git 或 src/entry.ts）——这种情况要关掉 compile cache
const isSourceCheckoutLauncher = () =>
  existsSync(new URL("./.git", import.meta.url)) ||
  existsSync(new URL("./src/entry.ts", import.meta.url));

const isNodeCompileCacheDisabled = () => process.env.NODE_DISABLE_COMPILE_CACHE !== undefined;
const isNodeCompileCacheRequested = () =>
  Boolean(process.env.NODE_COMPILE_CACHE) && !isNodeCompileCacheDisabled();
const sanitizeCompileCachePathSegment = (value) => {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
};
const readPackageVersion = () => {
  try {
    const parsed = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    if (typeof parsed?.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to an install-metadata-only cache key.
  }
  return "unknown";
};
const resolvePackagedCompileCacheDirectory = () => {
  const packageJsonUrl = new URL("./package.json", import.meta.url);
  const version = sanitizeCompileCachePathSegment(readPackageVersion());
  let installMarker = "no-package-json";
  try {
    const stat = statSync(packageJsonUrl);
    installMarker = `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
  } catch {
    // Package archives should always have package.json, but keep startup best-effort.
  }
  const baseDirectory = isNodeCompileCacheRequested()
    ? process.env.NODE_COMPILE_CACHE
    : path.join(os.tmpdir(), "node-compile-cache");
  return path.join(
    baseDirectory,
    "openclaw",
    version,
    sanitizeCompileCachePathSegment(installMarker),
  );
};

const respawnSignals =
  process.platform === "win32"
    ? ["SIGTERM", "SIGINT", "SIGBREAK"]
    : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
const respawnSignalExitGraceMs = 1_000;
const respawnSignalForceKillGraceMs = 1_000;

const runRespawnedChild = (command, args, env) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
  });
  const listeners = new Map();
  // This intentionally overlaps with src/entry.compile-cache.ts; keep the
  // respawn supervision behavior in sync until the launcher can share TS code.
  // Give the child a moment to honor forwarded signals, then exit the wrapper so
  // a child that ignores SIGTERM cannot keep the launcher alive indefinitely.
  let signalExitTimer = null;
  let signalForceKillTimer = null;
  const detach = () => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
    if (signalExitTimer) {
      clearTimeout(signalExitTimer);
      signalExitTimer = null;
    }
    if (signalForceKillTimer) {
      clearTimeout(signalForceKillTimer);
      signalForceKillTimer = null;
    }
  };
  const forceKillChild = () => {
    try {
      child.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    } catch {
      // Best-effort shutdown fallback.
    }
  };
  const requestChildTermination = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort shutdown fallback.
    }
    signalForceKillTimer = setTimeout(() => {
      forceKillChild();
      process.exit(1);
    }, respawnSignalForceKillGraceMs);
    signalForceKillTimer.unref?.();
  };
  const scheduleParentExit = () => {
    if (signalExitTimer) {
      return;
    }
    signalExitTimer = setTimeout(() => {
      requestChildTermination();
    }, respawnSignalExitGraceMs);
    signalExitTimer.unref?.();
  };
  for (const signal of respawnSignals) {
    const listener = () => {
      try {
        child.kill(signal);
      } catch {
        // Best-effort signal forwarding.
      }
      scheduleParentExit();
    };
    try {
      process.on(signal, listener);
      listeners.set(signal, listener);
    } catch {
      // Unsupported signal on this platform.
    }
  }
  child.once("exit", (code, signal) => {
    detach();
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
  child.once("error", (error) => {
    detach();
    process.stderr.write(
      `[openclaw] Failed to respawn launcher: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exit(1);
  });
  return true;
};

const respawnWithoutCompileCacheIfNeeded = () => {
  if (!isSourceCheckoutLauncher()) {
    return false;
  }
  if (process.env.OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED === "1") {
    return false;
  }
  if (!module.getCompileCacheDir?.() && !isNodeCompileCacheRequested()) {
    return false;
  }
  const env = {
    ...process.env,
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED: "1",
  };
  delete env.NODE_COMPILE_CACHE;
  return runRespawnedChild(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    env,
  );
};

const respawnWithPackagedCompileCacheIfNeeded = () => {
  if (isSourceCheckoutLauncher() || isNodeCompileCacheDisabled()) {
    return false;
  }
  if (process.env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED === "1") {
    return false;
  }
  const currentDirectory = module.getCompileCacheDir?.();
  if (!currentDirectory) {
    return false;
  }
  const desiredDirectory = resolvePackagedCompileCacheDirectory();
  if (path.resolve(currentDirectory) === path.resolve(desiredDirectory)) {
    return false;
  }
  const env = {
    ...process.env,
    NODE_COMPILE_CACHE: desiredDirectory,
    OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "1",
  };
  return runRespawnedChild(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    env,
  );
};

const waitingForCompileCacheRespawn =
  respawnWithoutCompileCacheIfNeeded() || respawnWithPackagedCompileCacheIfNeeded();

// lyc: 启用模块编译缓存; 如果环境变量 NODE_DISABLE_COMPILE_CACHE 为 true, 则不启用缓存
// lyc:aic v2026.5：除了原条件外还增加了"未在等待 respawn"和"非源码 checkout"两个守卫
// https://nodejs.org/api/module.html#module-compile-cache
if (
  !waitingForCompileCacheRespawn &&
  module.enableCompileCache &&
  !isNodeCompileCacheDisabled() &&
  !isSourceCheckoutLauncher()
) {
  try {
    module.enableCompileCache(resolvePackagedCompileCacheDirectory());
  } catch {
    // Ignore errors
  }
}

const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

const isDirectModuleNotFoundError = (err, specifier) => {
  if (!isModuleNotFoundError(err)) {
    return false;
  }

  const expectedUrl = new URL(specifier, import.meta.url);
  if ("url" in err && err.url === expectedUrl.href) {
    return true;
  }

  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  const expectedPath = fileURLToPath(expectedUrl);
  return (
    message.includes(`Cannot find module '${expectedPath}'`) ||
    message.includes(`Cannot find module "${expectedPath}"`)
  );
};

// lyc: 安装进程警告过滤器
const installProcessWarningFilter = async () => {
  // Keep bootstrap warnings consistent with the TypeScript runtime.
  // lyc: 保持bootstrap警告与TypeScript运行时的风格一致。
  // lyc: 注意: src\infra\warning-filter.ts有installProcessWarningFilter的实现, 但不确定/dist/warning-filter.js是否来自于此
  for (const specifier of ["./dist/warning-filter.js", "./dist/warning-filter.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        return;
      }
    } catch (err) {
      if (isDirectModuleNotFoundError(err, specifier)) {
        continue;
      }
      throw err;
    }
  }
};

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    // Only swallow direct entry misses; rethrow transitive resolution failures.
    if (isDirectModuleNotFoundError(err, specifier)) {
      return false;
    }
    throw err;
  }
};

const exists = async (specifier) => {
  try {
    await access(new URL(specifier, import.meta.url));
    return true;
  } catch {
    return false;
  }
};

const buildMissingEntryErrorMessage = async () => {
  const lines = ["openclaw: missing dist/entry.(m)js (build output)."];
  if (!(await exists("./src/entry.ts"))) {
    return lines.join("\n");
  }

  lines.push("This install looks like an unbuilt source tree or GitHub source archive.");
  lines.push(
    "Build locally with `pnpm install && pnpm build`, or install a built package instead.",
  );
  lines.push(
    "For pinned GitHub installs, use `npm install -g github:openclaw/openclaw#<ref>` instead of a raw `/archive/<ref>.tar.gz` URL.",
  );
  lines.push("For releases, use `npm install -g openclaw@latest`.");
  return lines.join("\n");
};

const isBareRootHelpInvocation = (argv) =>
  argv.length === 3 && (argv[2] === "--help" || argv[2] === "-h");

const isBrowserHelpInvocation = (argv) =>
  argv.length === 4 && argv[2] === "browser" && (argv[3] === "--help" || argv[3] === "-h");

const isHelpFastPathDisabled = () =>
  process.env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1";

const loadPrecomputedHelpText = (key) => {
  try {
    const raw = readFileSync(new URL("./dist/cli-startup-metadata.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw);
    const value = parsed?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

// lyc: 尝试输出根帮助文本
// lyc: 如果成功输出, 则返回true; 否则返回false
const tryOutputBareRootHelp = async () => {
  if (!isBareRootHelpInvocation(process.argv)) {
    return false;
  }
  const precomputed = loadPrecomputedHelpText("rootHelpText");
  if (precomputed) {
    process.stdout.write(precomputed);
    return true;
  }
  for (const specifier of ["./dist/cli/program/root-help.js", "./dist/cli/program/root-help.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.outputRootHelp === "function") {
        mod.outputRootHelp();
        return true;
      }
    } catch (err) {
      if (isDirectModuleNotFoundError(err, specifier)) {
        continue;
      }
      throw err;
    }
  }
  return false;
};

const tryOutputBrowserHelp = () => {
  if (!isBrowserHelpInvocation(process.argv)) {
    return false;
  }
  const precomputed = loadPrecomputedHelpText("browserHelpText");
  if (!precomputed) {
    return false;
  }
  process.stdout.write(precomputed);
  return true;
};
// lyc:aic v2026.5：用 `if (!waitingForCompileCacheRespawn)` 把 help 快速路径整段包起来——
//         如果当前正在等 compile-cache respawn，就不要走 help 或加载 entry.js

if (!waitingForCompileCacheRespawn) {
  // lyc: 尝试输出根帮助文本
  if (!isHelpFastPathDisabled() && (await tryOutputBareRootHelp())) {
    // OK
  } else if (!isHelpFastPathDisabled() && tryOutputBrowserHelp()) {
    // OK
  } else {
    await installProcessWarningFilter();
    if (await tryImport("./dist/entry.js")) {
      // OK
    } else if (await tryImport("./dist/entry.mjs")) {
      // OK
    } else {
      throw new Error(await buildMissingEntryErrorMessage());
    }
  }
}
