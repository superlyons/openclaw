import { isTruthyEnvValue } from "../infra/env.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { hasFlag } from "./argv.js";
import {
  applyCliExecutionStartupPresentation,
  ensureCliExecutionBootstrap,
  resolveCliExecutionStartupContext,
} from "./command-execution-startup.js";
import { findRoutedCommand } from "./program/routes.js";

/* lyc:ai 
负责为快速路径命令准备执行环境。
它设置启动策略、显示 CLI banner（如果需要），并确保 CLI 执行引导完成，
包括配置验证和插件加载。
*/
async function prepareRoutedCommand(params: {
  argv: string[];
  commandPath: string[];
  loadPlugins?: boolean | ((argv: string[]) => boolean);
}) {
  // lyc: 解析启动策略(startupPolicy)
  const { startupPolicy } = resolveCliExecutionStartupContext({
    argv: params.argv,
    jsonOutputMode: hasFlag(params.argv, "--json"),
    env: process.env,
    routeMode: true,
  });
  // lyc: openclaw版本
  const { VERSION } = await import("../version.js");
  // lyc: 应用CLI执行启动展示
  await applyCliExecutionStartupPresentation({
    argv: params.argv,
    routeLogsToStderrOnSuppress: false,
    startupPolicy,
    showBanner: process.stdout.isTTY && !startupPolicy.suppressDoctorStdout,
    version: VERSION,
  });
  const shouldLoadPlugins =
    typeof params.loadPlugins === "function" ? params.loadPlugins(params.argv) : params.loadPlugins;
  /* lyc:ai 
  确保 CLI 执行引导完成，这是快速路径命令执行的关键步骤。
  它会验证配置文件、加载必要的插件，并设置运行时环境。
  */
  await ensureCliExecutionBootstrap({
    runtime: defaultRuntime,
    commandPath: params.commandPath,
    startupPolicy,
    loadPlugins: shouldLoadPlugins ?? startupPolicy.loadPlugins,
  });
}

/* lyc:ai 
tryRouteCli 函数是 CLI 快速路径路由的核心入口点。
它尝试将命令行参数路由到预定义的快速路径命令，避免加载完整的 Commander 程序，
从而提高启动速度和减少资源消耗。
*/
export async function tryRouteCli(argv: string[]): Promise<boolean> {
  if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_ROUTE_FIRST)) {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  if (!invocation.commandPath[0]) {
    return false;
  }
  // lyc: 查找快速路径命令, 如果存在, 则返回路由执行类, 否则返回 null
  const route = findRoutedCommand(invocation.commandPath, argv);
  if (!route) {
    return false;
  }
  if (route.canRun && !route.canRun(argv)) {
    return false;
  }
  // lyc: 准备路由执行类, 加载插件, 执行命令
  await prepareRoutedCommand({
    argv,
    commandPath: invocation.commandPath,
    loadPlugins: route.loadPlugins,
  });
  // lyc: 通过找到的路由执行类执行命令
  return route.run(argv);
}
