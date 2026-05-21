import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { CliPluginRegistryPolicy } from "./command-catalog.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";
import { ensureCliPluginRegistryLoaded } from "./plugin-registry-loader.js";

/* lyc:ai
*/
// lyc:aic v2026.5：从手写的 Promise 缓存改为通用 createLazyImportLoader helper
const configGuardModuleLoader = createLazyImportLoader(() => import("./program/config-guard.js"));

/* lyc:ai 
*/
function loadConfigGuardModule() {
  return configGuardModuleLoader.load();
}

/* lyc:ai 



*/
export async function ensureCliCommandBootstrap(params: {
  /* lyc:ai 运行时环境对象，提供日志记录、错误处理、退出等功能 */
  runtime: RuntimeEnv;
  /* lyc:ai 命令路径数组，例如 ["health"]、["status"]、["gateway", "status"] */
  commandPath: string[];
  /* lyc:ai 是否抑制 doctor 相关输出到 stdout（通常用于 JSON 输出模式） */
  suppressDoctorStdout?: boolean;
  /* lyc:ai 是否跳过配置守卫阶段（某些特殊场景可能需要） */
  skipConfigGuard?: boolean;
  /* lyc:ai 是否允许在无效配置下继续执行（health/status 等诊断命令需要） */
  allowInvalid?: boolean;
  /* lyc:ai 是否加载插件系统（某些简单命令可能不需要插件） */
  loadPlugins?: boolean;
  pluginRegistry?: CliPluginRegistryPolicy;
}) {
  /* lyc:ai 
  
  
  */
  // lyc: 是否跳过配置守卫阶段（某些特殊场景可能需要）, false为不跳过
  if (!params.skipConfigGuard) {
    /* lyc:ai 动态导入配置守卫模块，获取 ensureConfigReady 函数 */
    const { ensureConfigReady } = await loadConfigGuardModule();
    /* lyc:ai 执行配置验证，传递运行时环境和命令路径等参数 */
    await ensureConfigReady({
      runtime: params.runtime,
      commandPath: params.commandPath,
      /* lyc:ai 如果允许无效配置，则传递 allowInvalid:true */
      ...(params.allowInvalid ? { allowInvalid: true } : {}),
      /* lyc:ai 如果需要抑制doctor命令的输出，则传递 suppressDoctorStdout:true */
      ...(params.suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
    });
  }
  
  /* lyc:ai 
  
  
  
  */
  if (!params.loadPlugins) {
    /* lyc:ai 如果不需要加载插件，直接返回，跳过插件初始化阶段 */
    return;
  }
  /* lyc:ai
    * status/health 命令 -> "channels"（只加载通道插件，提高启动速度）
    * 其他命令 -> "all"（加载所有插件，确保完整功能）
  */
  // lyc:aic v2026.5：scope 现在统一从 resolveCliCommandPathPolicy() 取，调用方可用 params.pluginRegistry 覆盖
  const pluginRegistryLoadPolicy =
    params.pluginRegistry ?? resolveCliCommandPathPolicy(params.commandPath).pluginRegistry;
  await ensureCliPluginRegistryLoaded({
    scope: pluginRegistryLoadPolicy.scope,
    routeLogsToStderr: params.suppressDoctorStdout,
  });
}
