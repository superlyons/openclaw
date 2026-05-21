import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { resolveNodeStartupTlsEnvironment } from "./bootstrap/node-startup-env.js";
import {
  shouldSkipRespawnForArgv,
  shouldSkipStartupEnvironmentRespawnForArgv,
} from "./cli/respawn-policy.js";
import { isTruthyEnvValue } from "./infra/env.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

export const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";
export const OPENCLAW_NODE_OPTIONS_READY = "OPENCLAW_NODE_OPTIONS_READY";
export const OPENCLAW_NODE_EXTRA_CA_CERTS_READY = "OPENCLAW_NODE_EXTRA_CA_CERTS_READY";
const CLI_RESPAWN_SIGNAL_EXIT_GRACE_MS = 1_000;
const CLI_RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS = 1_000;

type CliRespawnPlan = {
  command: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
};

type CliRespawnRuntime = {
  spawn: typeof spawn;
  attachChildProcessBridge: typeof attachChildProcessBridge;
  exit: (code?: number) => never;
  writeError: (message: string, error?: unknown) => void;
};

function pathModuleForPlatform(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function resolveCliRespawnCommand(params: {
  execPath: string;
  platform?: NodeJS.Platform;
}): string {
  const platform = params.platform ?? process.platform;
  const basename = pathModuleForPlatform(platform).basename(params.execPath).toLowerCase();
  if (basename === "volta-shim" || basename === "volta-shim.exe") {
    return "node";
  }
  return params.execPath;
}

/* lyc:ai
*/
// lyc:aic v2026.5：upstream 把 export 去掉了（变成模块私有），但注释依然有效。
function hasExperimentalWarningSuppressed(
  params: {
    env?: NodeJS.ProcessEnv;
    execArgv?: string[];
  } = {},
): boolean {
  // lyc:ai 获取当前环境变量和Node.js执行参数
  const env = params.env ?? process.env;
  const execArgv = params.execArgv ?? process.execArgv;
  // lyc:ai 检查NODE_OPTIONS环境变量中是否包含抑制警告的标志
  const nodeOptions = env.NODE_OPTIONS ?? "";
  if (nodeOptions.includes(EXPERIMENTAL_WARNING_FLAG) || nodeOptions.includes("--no-warnings")) {
    return true;
  }
  // lyc:ai 检查Node.js执行参数中是否包含抑制警告的标志
  return execArgv.some((arg) => arg === EXPERIMENTAL_WARNING_FLAG || arg === "--no-warnings");
}

/* lyc:ai

*/
export function buildCliRespawnPlan(
  params: {
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    execArgv?: string[];
    execPath?: string;
    autoNodeExtraCaCerts?: string | undefined;
    platform?: NodeJS.Platform;
  } = {},
): CliRespawnPlan | null {
  /* lyc 获取当前的命令行参数、环境变量、Node.js执行参数和可执行路径
  */
  const argv = params.argv ?? process.argv;
  const env = params.env ?? process.env;
  const execArgv = params.execArgv ?? process.execArgv;
  const execPath = params.execPath ?? process.execPath;
  const platform = params.platform ?? process.platform;

  // lyc:ai 检查是否应该跳过重启动：特定命令行参数（--help 等）或 设置了 OPENCLAW_NO_RESPAWN 环境变量
  // lyc:aic v2026.5：shouldSkipRespawnForArgv 改名为 shouldSkipStartupEnvironmentRespawnForArgv（语义更精确，只针对启动环境）
  if (
    shouldSkipStartupEnvironmentRespawnForArgv(argv) ||
    isTruthyEnvValue(env.OPENCLAW_NO_RESPAWN)
  ) {
    return null;
  }

  if (platform === "win32") {
    return null;
  }

  // lyc:ai 初始化子进程的环境变量和执行参数
  const childEnv: NodeJS.ProcessEnv = { ...env };
  const childExecArgv = [...execArgv];
  let needsRespawn = false;

  // lyc:ai 处理自定义CA证书配置, 获得有效CA证书路径
  const autoNodeExtraCaCerts =
    params.autoNodeExtraCaCerts ??
    resolveNodeStartupTlsEnvironment({
      env,
      execPath,
      includeDarwinDefaults: false,
    }).NODE_EXTRA_CA_CERTS;
  /* lyc: 
  */
  if (
    autoNodeExtraCaCerts &&
    !isTruthyEnvValue(env[OPENCLAW_NODE_EXTRA_CA_CERTS_READY]) &&
    !env.NODE_EXTRA_CA_CERTS
  ) {
    // lyc:ai 设置自定义CA证书路径并标记已处理
    childEnv.NODE_EXTRA_CA_CERTS = autoNodeExtraCaCerts;
    // lyc: 标记已处理自定义CA证书路径
    childEnv[OPENCLAW_NODE_EXTRA_CA_CERTS_READY] = "1";
    needsRespawn = true;
  }

  // lyc: 处理实验性警告抑制：如果尚未处理(OPENCLAW_NODE_OPTIONS_READY=false或未设置)且未被抑制实验性警告
  // lyc: OPENCLAW_NODE_OPTIONS_READY是一个标记, 用于记录是否已处理实验性警告抑制参数
  if (
    !shouldSkipRespawnForArgv(argv) &&
    !isTruthyEnvValue(env[OPENCLAW_NODE_OPTIONS_READY]) &&
    !hasExperimentalWarningSuppressed({ env, execArgv })
  ) {
    // lyc:ai 添加抑制实验性警告的参数并标记已处理
    childEnv[OPENCLAW_NODE_OPTIONS_READY] = "1";
    // lyc: 在childExecArgv的开头添加EXPERIMENTAL_WARNING_FLAG, 抑制实验性警告
    childExecArgv.unshift(EXPERIMENTAL_WARNING_FLAG);
    needsRespawn = true;
  }

  // lyc:ai 如果不需要重启动，返回null
  if (!needsRespawn) {
    return null;
  }

  // lyc:ai 返回重启动计划：包含新的执行参数（Node.js参数 + 原始命令行参数）和环境变量
  return {
    command: resolveCliRespawnCommand({ execPath, platform }),
    argv: [...childExecArgv, ...argv.slice(1)],
    env: childEnv,
  };
}

/* lyc:aic
*/
export function runCliRespawnPlan(
  plan: CliRespawnPlan,
  runtime: CliRespawnRuntime = {
    spawn,
    attachChildProcessBridge,
    exit: process.exit.bind(process) as (code?: number) => never,
    writeError: (message, error) => console.error(message, error),
  },
): ChildProcess {
  // lyc:ai 使用 spawn 创建子进程，使用当前 Node.js 可执行路径和构建好的参数及环境变量
  // lyc: 例：node --no-warnings --max-old-space-size=4096 openclaw.mjs arg1 arg2 arg3
  const child = runtime.spawn(plan.command, plan.argv, {
    stdio: "inherit",
    env: plan.env,
  });
  let signalExitTimer: NodeJS.Timeout | undefined;
  let signalForceKillTimer: NodeJS.Timeout | undefined;
  const clearSignalTimers = (): void => {
    if (signalExitTimer) {
      clearTimeout(signalExitTimer);
      signalExitTimer = undefined;
    }
    if (signalForceKillTimer) {
      clearTimeout(signalForceKillTimer);
      signalForceKillTimer = undefined;
    }
  };
  const forceKillChild = (): void => {
    try {
      child.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    } catch {
      // Best-effort shutdown fallback.
    }
  };
  const requestChildTermination = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort shutdown fallback.
    }
    signalForceKillTimer = setTimeout(() => {
      forceKillChild();
      runtime.exit(1);
    }, CLI_RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS);
    signalForceKillTimer.unref?.();
  };
  const scheduleParentExit = (): void => {
    if (signalExitTimer) {
      return;
    }
    signalExitTimer = setTimeout(() => {
      requestChildTermination();
    }, CLI_RESPAWN_SIGNAL_EXIT_GRACE_MS);
    signalExitTimer.unref?.();
  };

  // lyc:ai 调用 attachChildProcessBridge() 建立父子进程信号桥接，确保父进程收到的信号能传递给子进程
  // lyc:aic v2026.5：新增 onSignal 回调，把信号转成"先延迟 grace 期、再请求 SIGTERM、再强制 SIGKILL"的优雅退出流程
  runtime.attachChildProcessBridge(child, {
    onSignal: scheduleParentExit,
  });

  // lyc:ai 监听子进程退出事件，根据退出码或信号设置父进程的退出状态
  // lyc:aic v2026.5：退出前会先清理两个超时定时器（信号 grace 期 + 强制 kill grace 期），避免父进程被悬挂
  child.once("exit", (code, signal) => {
    clearSignalTimers();
    if (signal) {
      runtime.exit(1);
      return;
    }
    runtime.exit(code ?? 1);
  });

  // lyc:ai 监听子进程错误事件，记录错误并退出父进程
  // lyc:aic v2026.5：错误处理也清理定时器；通过 runtime.writeError 抽象出来便于测试注入
  child.once("error", (error) => {
    clearSignalTimers();
    runtime.writeError(
      "[openclaw] Failed to respawn CLI:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    runtime.exit(1);
  });

  return child;
}
