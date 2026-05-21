import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loggingState } from "../logging/state.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { CliPluginRegistryScope } from "./command-catalog.js";

/* lyc:ai
*/
// lyc:aic v2026.5：从手写 Promise 缓存改用 createLazyImportLoader helper
const pluginRegistryModuleLoader = createLazyImportLoader(() => import("./plugin-registry.js"));

/* lyc:ai 
*/
function loadPluginRegistryModule() {
  return pluginRegistryModuleLoader.load();
}

// lyc:aic v2026.5：原本暴露的 resolvePluginRegistryScopeForCommandPath 函数（status/health 走 channels，其他走 all）
//         整合进了 command-catalog 的策略系统（resolveCliCommandPathPolicy().pluginRegistry）。
//         本文件只保留一个轻量 type 用于上游传 scope。原函数实现的中文 lyc 注释已搬到
//         src/cli/command-path-policy.ts / command-catalog.ts 的相应策略定义旁。
export type CliPluginRegistryLoadPolicy = {
  scope: CliPluginRegistryScope;
};

/* lyc:ai 


  * 这确保了 JSON 输出模式下 stdout 只包含纯 JSON 数据
  * 避免日志信息污染命令的标准输出
*/
export async function ensureCliPluginRegistryLoaded(params: {
  /* lyc:ai 插件加载范围：'channels' | 'all' */
  // lyc:aic v2026.5：类型从 PluginRegistryScope 改为 CliPluginRegistryScope（更严格的窄类型）
  scope: CliPluginRegistryScope;
  /* lyc:ai 是否将日志强制路由到 stderr（保持 stdout 干净） */
  routeLogsToStderr?: boolean;
  /* lyc:ai 自定义 OpenClaw 配置（CLI 场景通常为 undefined） */
  config?: OpenClawConfig;
  /* lyc:ai 激活源配置（CLI 场景通常为 undefined） */
  activationSourceConfig?: OpenClawConfig;
}) {
  /* lyc:ai 动态导入插件注册表模块，获取底层加载函数 */
  const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
  
  /* lyc:ai 
  
  
  */
  const previousForceStderr = loggingState.forceConsoleToStderr;
  if (params.routeLogsToStderr) {
    loggingState.forceConsoleToStderr = true;
  }
  try {
    /* lyc:ai 
    
    
    */
    ensurePluginRegistryLoaded({
      scope: params.scope,
      ...(params.config ? { config: params.config } : {}),
      ...(params.activationSourceConfig
        ? { activationSourceConfig: params.activationSourceConfig }
        : {}),
    });
  } finally {
    /* lyc:ai 
    */
    loggingState.forceConsoleToStderr = previousForceStderr;
  }
}
