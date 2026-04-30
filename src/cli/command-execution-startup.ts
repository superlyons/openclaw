import { routeLogsToStderr } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { ensureCliCommandBootstrap } from "./command-bootstrap.js";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";

type CliStartupPolicy = ReturnType<typeof resolveCliStartupPolicy>;

// lyc: 解析CLI执行启动上下文, 包含命令调用信息(invocation), 命令路径(commandPath), 启动策略(startupPolicy)
export function resolveCliExecutionStartupContext(params: {
  argv: string[];
  jsonOutputMode: boolean;
  env?: NodeJS.ProcessEnv;
  routeMode?: boolean;
}) {
  const invocation = resolveCliArgvInvocation(params.argv);
  const { commandPath } = invocation;
  return {
    invocation,
    commandPath,
    startupPolicy: resolveCliStartupPolicy({
      commandPath,
      jsonOutputMode: params.jsonOutputMode,
      env: params.env,
      routeMode: params.routeMode,
    }),
  };
}

// lyc: 应用CLI执行启动展示, 设置全局变量loggingState.forceConsoleToStderr=true强制输出到stderr(保证stdout干净) 和 打印路由banner
export async function applyCliExecutionStartupPresentation(params: {
  argv?: string[];
  routeLogsToStderrOnSuppress?: boolean;
  startupPolicy: CliStartupPolicy;
  showBanner?: boolean;
  version?: string;
}) {
  if (params.startupPolicy.suppressDoctorStdout && params.routeLogsToStderrOnSuppress !== false) {
    routeLogsToStderr();
  }
  if (params.startupPolicy.hideBanner || params.showBanner === false || !params.version) {
    return;
  }
  const { emitCliBanner } = await import("./banner.js");
  if (params.argv) {
    emitCliBanner(params.version, { argv: params.argv });
    return;
  }
  emitCliBanner(params.version);
}

/* lyc:ai 
CLI 执行引导的核心函数。
它负责确保 CLI 命令执行前的必要准备工作完成，包括：
1. 配置文件验证（确保配置有效）
2. 插件注册表加载（按需加载插件）
这个函数是快速路径命令和普通命令共享的引导逻辑。
*/
export async function ensureCliExecutionBootstrap(params: {
  runtime: RuntimeEnv;
  commandPath: string[];
  startupPolicy: CliStartupPolicy;
  allowInvalid?: boolean;
  loadPlugins?: boolean;
  skipConfigGuard?: boolean;
}) {
  /* lyc:ai 
  调用底层的 CLI 命令引导函数，传递所有必要的参数：
  - runtime: 运行时环境对象
  - commandPath: 命令路径（如 ["health"]、["status"] 等）
  - suppressDoctorStdout: 是否抑制 doctor 输出到 stdout
  - allowInvalid: 是否允许无效配置（某些命令如 health/status 可以在无效配置下运行）
  - loadPlugins: 是否加载插件（根据命令策略和参数决定）
  - skipConfigGuard: 是否跳过配置守卫（配置验证）
  */
  await ensureCliCommandBootstrap({
    runtime: params.runtime,
    commandPath: params.commandPath,
    suppressDoctorStdout: params.startupPolicy.suppressDoctorStdout,
    allowInvalid: params.allowInvalid,
    loadPlugins: params.loadPlugins ?? params.startupPolicy.loadPlugins,
    skipConfigGuard: params.skipConfigGuard ?? params.startupPolicy.skipConfigGuard,
  });
}
