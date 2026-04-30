import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loggingState } from "../logging/state.js";
import type { PluginRegistryScope } from "./plugin-registry.js";

/* lyc:ai 
延迟加载插件注册表模块的缓存变量。
使用动态导入来避免不必要的模块加载开销，
只有在真正需要加载插件时才导入 plugin-registry 模块。
*/
let pluginRegistryModulePromise: Promise<typeof import("./plugin-registry.js")> | undefined;

/* lyc:ai 
loadPluginRegistryModule 函数实现插件注册表模块的延迟加载。
使用 Promise 缓存模式确保模块只被加载一次，
提高多次调用时的性能。
*/
function loadPluginRegistryModule() {
  pluginRegistryModulePromise ??= import("./plugin-registry.js");
  return pluginRegistryModulePromise;
}

/* lyc:ai 
resolvePluginRegistryScopeForCommandPath 函数根据命令路径智能确定插件加载范围。
这是 CLI 性能优化的关键：只为命令实际需要的功能加载插件。

详细逻辑：
- status/health 命令：只加载 "channels" 范围
  * 原因：这些诊断命令只需要与已配置的通道（channels）交互
  * 优势：避免加载所有插件，显著提高启动速度
  * 示例：openclaw status 只需要知道有哪些通道可用，不需要加载 agents、memory 等插件

- 所有其他命令：加载 "all" 范围
  * 原因：完整功能命令可能需要访问任何类型的插件
  * 保证：确保命令能够访问所需的全部功能

返回类型排除 "configured-channels" 是因为 CLI 快速路径不使用这个范围，
该范围主要用于特定的程序化场景。
*/
export function resolvePluginRegistryScopeForCommandPath(
  commandPath: string[],
): Exclude<PluginRegistryScope, "configured-channels"> {
  return commandPath[0] === "status" || commandPath[0] === "health" ? "channels" : "all";
}

/* lyc:ai 
ensureCliPluginRegistryLoaded 是 CLI 插件加载的入口函数。
它负责协调插件加载过程，特别关注日志输出的正确性。

执行流程：
1. 动态加载插件注册表模块（延迟加载优化）
2. 处理日志输出重定向（关键！保持 stdout 干净）
3. 调用底层插件加载函数
4. 恢复日志设置（确保不影响后续操作）

关键设计点：
- 日志重定向：当 routeLogsToStderr=true 时，强制所有日志输出到 stderr
  * 这确保了 JSON 输出模式下 stdout 只包含纯 JSON 数据
  * 避免日志信息污染命令的标准输出
- 错误安全：使用 try-finally 确保日志设置总是被正确恢复
- 配置传递：支持传递自定义配置，但 CLI 场景通常使用默认配置
*/
export async function ensureCliPluginRegistryLoaded(params: {
  /* lyc:ai 插件加载范围：'channels' | 'all' */
  scope: PluginRegistryScope;
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
  ========== 日志输出重定向处理 ==========
  保存当前的日志输出设置，并在需要时临时将日志强制输出到 stderr。
  这是 CLI 设计的关键：确保 stdout 在需要时保持干净（如 JSON 输出模式）。
  
  工作原理：
  - loggingState.forceConsoleToStderr 控制日志输出目标
  - 当为 true 时，所有日志（包括 console.log/error/warn）都输出到 stderr
  - 当为 false 时，日志按正常规则输出（console.log 到 stdout，其他到 stderr）
  
  应用场景：
  - JSON 输出模式 (--json 标志)：必须保持 stdout 只包含 JSON
  - 快速路径命令：避免日志干扰命令输出
  */
  const previousForceStderr = loggingState.forceConsoleToStderr;
  if (params.routeLogsToStderr) {
    loggingState.forceConsoleToStderr = true;
  }
  try {
    /* lyc:ai 
    ========== 实际插件加载 ==========
    调用底层插件注册表加载函数，传递作用域和可选配置参数。
    
    底层函数 ensurePluginRegistryLoaded 的行为：
    - 根据 scope 参数确定要加载的插件集合
    - 验证插件配置的有效性
    - 加载插件模块并执行注册逻辑
    - 设置插件运行时环境
    - 处理插件间的依赖关系
    
    注意：此函数是同步的，因为它需要立即设置全局插件状态，
    供后续的 CLI 命令使用。
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
    ========== 日志设置恢复 ==========
    无论插件加载成功与否，都要恢复之前的日志输出设置。
    这确保了错误处理和后续操作的日志行为一致性。
    使用 finally 块保证即使发生异常也能正确恢复。
    */
    loggingState.forceConsoleToStderr = previousForceStderr;
  }
}
