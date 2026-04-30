import { isGatewayConfigBypassCommandPath } from "../gateway/explicit-connection-policy.js";
import { cliCommandCatalog, type CliCommandPathPolicy } from "./command-catalog.js";
import { matchesCommandPath } from "./command-path-matches.js";

// lyc: 默认命令路径策略
const DEFAULT_CLI_COMMAND_PATH_POLICY: CliCommandPathPolicy = {
  bypassConfigGuard: false,
  routeConfigGuard: "never",
  loadPlugins: "never",
  hideBanner: false,
  ensureCliPath: true,
};

// lyc: 在命令目录(cliCommandCatalog)中查找与commandPath完全匹配的命令, 并返回其策略(policy)属性, 如果主命令是cron, 则将 bypassConfigGuard 属性赋值为true
export function resolveCliCommandPathPolicy(commandPath: string[]): CliCommandPathPolicy {
  // lyc: 解析策略=resolvedPolicy=初始化为 DEFAULT_CLI_COMMAND_PATH_POLICY 副本
  let resolvedPolicy: CliCommandPathPolicy = { ...DEFAULT_CLI_COMMAND_PATH_POLICY };
  // lyc: 遍历所有命令目录中的命令
  for (const entry of cliCommandCatalog) {
    // lyc: 如果命令没有策略, 则跳过
    if (!entry.policy) {
      continue;
    }
    // lyc: commandPath是否与命令目录中的当前命令完全匹配, 不匹配continue
    if (!matchesCommandPath(commandPath, entry.commandPath, { exact: entry.exact })) {
      continue;
    }
    // lyc: 如果与当前命令完全匹配, 则将当前命令的策略赋值给resolvedPolicy
    Object.assign(resolvedPolicy, entry.policy);
  }
  if (isGatewayConfigBypassCommandPath(commandPath)) {
    // lyc: commandPath[0]=cron, 则将bypassConfigGuard赋值为true
    resolvedPolicy.bypassConfigGuard = true;
  }
  return resolvedPolicy;
}
