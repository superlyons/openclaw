import { isTruthyEnvValue } from "../infra/env.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";

export function shouldBypassConfigGuardForCommandPath(commandPath: string[]): boolean {
  return resolveCliCommandPathPolicy(commandPath).bypassConfigGuard;
}

// lyc: 从命令路径(CommandPath)中解析是否跳过 路由配置守卫|保护, 如果命令策略中routeConfigGuard值为always 或 routeConfigGuard值为when-suppressed且suppressDoctorStdout为true, 则返回true
export function shouldSkipRouteConfigGuardForCommandPath(params: {
  commandPath: string[];
  suppressDoctorStdout: boolean;
}): boolean {
  const routeConfigGuard = resolveCliCommandPathPolicy(params.commandPath).routeConfigGuard;
  return (
    routeConfigGuard === "always" ||
    (routeConfigGuard === "when-suppressed" && params.suppressDoctorStdout)
  );
}

// lyc: 从命令路径(CommandPath)中解析是否加载插件, 如果命令策略中loadPlugins值为always 或 loadPlugins值为text-only且jsonOutputMode为false, 则返回true
export function shouldLoadPluginsForCommandPath(params: {
  commandPath: string[];
  jsonOutputMode: boolean;
}): boolean {
  const loadPlugins = resolveCliCommandPathPolicy(params.commandPath).loadPlugins;
  return loadPlugins === "always" || (loadPlugins === "text-only" && !params.jsonOutputMode);
}

// lyc: 从命令路径(CommandPath)中解析是否隐藏CLI banner, 如果环境变量OPENCLAW_HIDE_BANNER为true 或 命令策略中hideBanner为true, 则返回true
export function shouldHideCliBannerForCommandPath(
  commandPath: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isTruthyEnvValue(env.OPENCLAW_HIDE_BANNER) ||
    resolveCliCommandPathPolicy(commandPath).hideBanner
  );
}

// lyc: 从命令路径(CommandPath)中解析是否确保CLI路径, 
export function shouldEnsureCliPathForCommandPath(commandPath: string[]): boolean {
  // lyc: 如果commandPath为空返回true 或 返回commandPath匹配的命令策略中ensureCliPath(是否确保CLI路径)的值
  return commandPath.length === 0 || resolveCliCommandPathPolicy(commandPath).ensureCliPath;
}

// lyc: 解析CLI启动策略(根据命令目录(cliCommandCatalog)中的命令策略(policy)生成), 根据命令路径和参数, 返回启动策略对象
export function resolveCliStartupPolicy(params: {
  commandPath: string[];
  jsonOutputMode: boolean;
  env?: NodeJS.ProcessEnv;
  routeMode?: boolean;
}) {
  const suppressDoctorStdout = params.jsonOutputMode;
  return {
    // lyc: 是否 抑制doctor命令输出到标准输出 例如: 命令中有--json选项(通过params.jsonOutputMode)则需要禁止doctor命令输出到标准输出
    suppressDoctorStdout,
    // lyc: 是否 隐藏CLI banner, env.OPENCLAW_HIDE_BANNER=true 或 命令策略中hideBanner=true 则隐藏
    hideBanner: shouldHideCliBannerForCommandPath(params.commandPath, params.env),
    // lyc: 是否 跳过配置守卫|验证 例如: 命令策略中routeConfigGuard值为always 或 routeConfigGuard值为when-suppressed且suppressDoctorStdout为true
    skipConfigGuard: params.routeMode
      ? shouldSkipRouteConfigGuardForCommandPath({
          commandPath: params.commandPath,
          suppressDoctorStdout,
        })
      : false,
    // lyc: 是否 加载插件 例如: 命令策略中loadPlugins值为always 或 loadPlugins值为text-only且jsonOutputMode为false
    loadPlugins: shouldLoadPluginsForCommandPath({
      commandPath: params.commandPath,
      jsonOutputMode: params.jsonOutputMode,
    }),
  };
}
