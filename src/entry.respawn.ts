import path from "node:path";
import { resolveNodeStartupTlsEnvironment } from "./bootstrap/node-startup-env.js";
import { shouldSkipRespawnForArgv } from "./cli/respawn-policy.js";
import { isTruthyEnvValue } from "./infra/env.js";

export const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";
export const OPENCLAW_NODE_OPTIONS_READY = "OPENCLAW_NODE_OPTIONS_READY";
export const OPENCLAW_NODE_EXTRA_CA_CERTS_READY = "OPENCLAW_NODE_EXTRA_CA_CERTS_READY";

export type CliRespawnPlan = {
  command: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
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
检查是否已抑制实验性警告函数
此函数检查当前环境是否已经通过NODE_OPTIONS环境变量或Node.js执行参数
抑制了实验性警告（ExperimentalWarning）。
如果检测到--disable-warning=ExperimentalWarning或--no-warnings参数，
则返回true表示警告已被抑制，不需要再次添加这些参数。
*/
export function hasExperimentalWarningSuppressed(
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
构建CLI重启动计划函数
此函数决定是否需要重启动CLI进程，以及如何重启动。
重启动的主要原因包括：
1. 需要设置NODE_EXTRA_CA_CERTS环境变量（用于自定义CA证书）
2. 需要添加--disable-warning=ExperimentalWarning参数来抑制实验性警告

如果不需要重启动，返回null；否则返回包含新参数和环境变量的对象。
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
    命令：node --no-warnings --max-old-space-size=4096 openclaw.mjs arg1 arg2
    argv = ['/usr/bin/node', '/path/openclaw.mjs', 'arg1', 'arg2']
    execArgv = ['--no-warnings', '--max-old-space-size=4096']
    execPath = '/usr/bin/node'
  */
  const argv = params.argv ?? process.argv;
  const env = params.env ?? process.env;
  const execArgv = params.execArgv ?? process.execArgv;
  const execPath = params.execPath ?? process.execPath;
  const platform = params.platform ?? process.platform;

  // lyc:ai 检查是否应该跳过重启动：特定命令行参数--help 或 设置了OPENCLAW_NO_RESPAWN环境变量
  if (shouldSkipRespawnForArgv(argv) || isTruthyEnvValue(env.OPENCLAW_NO_RESPAWN)) {
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
    获得了有效CA证书路径(autoNodeExtraCaCerts) && 
      OPENCLAW_NODE_EXTRA_CA_CERTS_READY=false或未设置 && 
      NODE_EXTRA_CA_CERTS未设置
    OPENCLAW_NODE_EXTRA_CA_CERTS_READY是一个标记, 用于记录是否已处理自定义CA证书路径
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
