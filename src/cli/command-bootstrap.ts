import type { RuntimeEnv } from "../runtime.js";
import {
  ensureCliPluginRegistryLoaded,
  resolvePluginRegistryScopeForCommandPath,
} from "./plugin-registry-loader.js";

/* lyc:ai 
延迟加载配置守卫模块的缓存变量。
使用动态导入（dynamic import）来避免不必要的模块加载，
只有在真正需要配置验证时才加载 config-guard 模块。
*/
let configGuardModulePromise: Promise<typeof import("./program/config-guard.js")> | undefined;

/* lyc:ai 
loadConfigGuardModule 函数负责延迟加载配置守卫模块。
它使用 Promise 缓存模式，确保模块只被加载一次，
避免重复的动态导入开销。
*/
function loadConfigGuardModule() {
  configGuardModulePromise ??= import("./program/config-guard.js");
  return configGuardModulePromise;
}

/* lyc:ai 
CLI 命令执行引导的核心函数。
它负责在 CLI 命令执行前完成必要的准备工作，确保环境处于正确状态。
执行流程分为两个关键阶段：

阶段一：配置验证（Config Guard）
- 验证 OpenClaw 配置文件的有效性
- 处理无效配置的情况（某些命令如 health/status 可以容忍无效配置）
- 在配置无效且不允许继续时显示友好的错误信息并退出

阶段二：插件系统初始化（Plugin Registry Loading）
- 根据命令类型决定插件加载范围
- 加载并激活必要的插件
- 设置插件运行时环境

这个函数被快速路径命令（tryRouteCli）和完整 CLI 程序共享，
确保两种执行模式下的一致性。
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
}) {
  /* lyc:ai 
  ========== 阶段一：配置验证（Config Guard） ==========
  此阶段确保 CLI 在有效的配置环境下运行。
  
  调用链：ensureCliCommandBootstrap -> loadConfigGuardModule -> ensureConfigReady
  
  ensureConfigReady 函数的详细行为：
  1. 读取配置文件快照（包含存在性、有效性、问题列表等信息）
  2. 确定是否允许无效配置继续执行：
     - 显式 allowInvalid=true 参数
     - 命令在 ALLOWED_INVALID_COMMANDS 列表中（health, status, doctor, help, logs）
     - gateway 子命令在 ALLOWED_INVALID_GATEWAY_SUBCOMMANDS 列表中
  3. 如果配置无效且不允许继续：
     - 格式化并显示配置错误信息
     - 提供修复建议（openclaw doctor --fix）
     - 退出程序（exit code 1）
  4. 如果配置有效或允许无效配置继续，则正常返回
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
  ========== 阶段二：插件系统初始化（Plugin Registry Loading） ==========
  此阶段根据命令需求加载适当的插件集合。
  
  调用链：ensureCliCommandBootstrap -> resolvePluginRegistryScopeForCommandPath -> ensureCliPluginRegistryLoaded
  
  执行逻辑：
  1. 首先检查是否需要加载插件（loadPlugins 参数）
  2. 如果不需要，直接返回（节省启动时间和内存）
  3. 如果需要，确定插件加载范围：
     - status/health 命令：只加载 "channels" 范围（通道插件）
     - 其他命令：加载 "all" 范围（所有插件）
  4. 调用 ensureCliPluginRegistryLoaded 加载指定范围的插件
  
  ensureCliPluginRegistryLoaded 的详细行为：
  - 处理日志输出重定向（确保 stderr 输出不干扰 stdout）
  - 调用底层插件注册表加载函数
  - 实际加载并激活插件模块
  - 设置插件运行时上下文
  */
  if (!params.loadPlugins) {
    /* lyc:ai 如果不需要加载插件，直接返回，跳过插件初始化阶段 */
    return;
  }
  /* lyc:ai 
  加载插件注册表：
  - scope: 根据命令路径确定插件加载范围
    * status/health 命令 -> "channels"（只加载通道插件，提高启动速度）
    * 其他命令 -> "all"（加载所有插件，确保完整功能）
  - routeLogsToStderr: 控制日志输出目标，保持 stdout 干净（重要！）
  */
  await ensureCliPluginRegistryLoaded({
    scope: resolvePluginRegistryScopeForCommandPath(params.commandPath),
    routeLogsToStderr: params.suppressDoctorStdout,
  });
}
