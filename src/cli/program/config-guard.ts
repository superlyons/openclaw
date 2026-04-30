/* lyc:ai 
config-guard.ts - OpenClaw CLI 配置守卫模块

此模块负责在 CLI 命令执行前验证配置文件的有效性。
它是确保 CLI 稳定运行的关键组件，防止因无效配置导致的意外行为。

核心功能：
1. 读取并验证配置文件
2. 识别允许在无效配置下运行的特殊命令
3. 提供友好的错误信息和修复建议
4. 支持 doctor 预检流程（用于状态迁移）

设计原则：
- 安全优先：默认情况下，无效配置会阻止 CLI 执行
- 用户友好：提供清晰的错误信息和修复指导
- 灵活性：允许特定诊断命令在无效配置下运行
- 性能优化：使用缓存避免重复读取配置文件
*/

import { readConfigFileSnapshot } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { shouldMigrateStateFromPath } from "../argv.js";

/* lyc:ai 
ALLOWED_INVALID_COMMANDS 定义了可以在无效配置下继续执行的命令列表。
这些通常是诊断或修复命令，用户需要在配置损坏时仍能使用它们。

详细说明：
- doctor: 配置诊断和修复工具（核心修复命令）
- logs: 查看日志（不依赖有效配置）
- health: 健康检查（基础系统状态）
- help: 帮助信息（静态内容）
- status: 状态检查（基础系统状态）

这些命令的设计目标是在配置完全损坏的情况下仍能提供基本功能。
*/
const ALLOWED_INVALID_COMMANDS = new Set(["doctor", "logs", "health", "help", "status"]);

/* lyc:ai 
ALLOWED_INVALID_GATEWAY_SUBCOMMANDS 定义了 gateway 命令中可以在无效配置下执行的子命令。
gateway 命令通常用于管理网关服务，某些子命令不需要完整的配置验证。

详细说明：
- status/probe/health: 网关健康检查相关
- discover: 发现可用网关
- call: 直接调用网关方法
- install/uninstall/start/stop/restart: 网关生命周期管理

这些子命令通常只依赖网关本身的配置，而不是完整的 OpenClaw 配置。
*/
const ALLOWED_INVALID_GATEWAY_SUBCOMMANDS = new Set([
  "run",
  "status",
  "probe",
  "health",
  "discover",
  "call",
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
]);

/* lyc:ai 
全局状态变量，跟踪是否已经执行过 doctor 配置预检流程。
这确保预检流程只执行一次，避免重复的状态迁移操作。
*/
let didRunDoctorConfigFlow = false;

/* lyc:ai 
配置快照缓存，使用 Promise 缓存模式避免重复读取配置文件。
在测试环境中禁用缓存以避免测试间的状态污染。
*/
let configSnapshotPromise: Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> | null =
  null;

/* lyc:ai 
重置配置守卫状态的测试辅助函数。
用于单元测试中清理全局状态，确保测试隔离性。
*/
function resetConfigGuardStateForTests() {
  didRunDoctorConfigFlow = false;
  configSnapshotPromise = null;
}

/* lyc:ai 
提供配置文件快照的缓存读取。
- 在测试环境（VITEST）中禁用缓存以避免测试间干扰
- 在生产环境中使用 Promise 缓存提高性能
- 返回包含配置存在性、有效性、问题列表等信息的快照对象
*/
async function getConfigSnapshot() {
  // Tests often mutate config fixtures; caching can make those flaky.
  if (process.env.VITEST === "true") {
    return readConfigFileSnapshot();
  }
  configSnapshotPromise ??= readConfigFileSnapshot();
  return configSnapshotPromise;
}

/* lyc:ai 
配置守卫(config guard)的核心入口函数。
它执行完整的配置验证流程，并根据结果决定是否允许 CLI 继续执行。

执行流程详解：

阶段一：Doctor 预检处理（状态迁移）
- 检查是否需要执行 doctor 预检（基于命令路径）
- 如果需要，执行预检并获取配置快照
- 处理输出抑制（保持 stdout 干净）

阶段二：配置有效性判断
- 获取最终的配置快照
- 确定是否允许无效配置继续执行
- 基于命令类型和参数做出决策

阶段三：错误处理和用户反馈
- 如果配置无效且不允许继续，显示详细错误信息
- 提供修复建议（openclaw doctor --fix）
- 优雅退出（exit code 1）

关键设计点：
- 参数化控制：通过 allowInvalid 和 suppressDoctorStdout 提供灵活性
- 错误信息格式化：使用终端主题提供彩色、结构化的错误输出
- 用户引导：不仅报告错误，还提供明确的修复路径
*/
export async function ensureConfigReady(params: {
  /* lyc:ai 运行时环境对象，提供 error() 和 exit() 方法 */
  runtime: RuntimeEnv;
  /* lyc:ai 命令路径，用于确定是否允许无效配置和是否需要预检 */
  commandPath?: string[];
  /* lyc:ai 是否 抑制 doctor 相关输出到 stdout（JSON 模式需要） */
  suppressDoctorStdout?: boolean;
  /* lyc:ai 是否显式允许无效配置继续执行 */
  allowInvalid?: boolean;
}): Promise<void> {
  /* lyc:ai 
  ========== 阶段一：Doctor 预检处理（状态迁移） ==========
  某些命令路径可能触发状态迁移需求（如从旧版本升级）。
  在这种情况下，需要先执行 doctor 预检(doctor-config-preflight.js)来处理潜在的状态迁移。
  
  执行逻辑：
  1. 检查是否已经执行过预检（避免重复执行）
  2. 检查命令路径是否需要状态迁移（shouldMigrateStateFromPath）
  3. 如果需要，动态导入并执行 doctor-config-preflight.js
  4. 处理输出抑制：确保 JSON 模式下 stdout 保持干净
  
  关键细节：
  - doctor-config-preflight.js 运行时禁用实际的状态迁移（migrateState: false）
  - 只进行轻量级的配置验证和预检
  - 输出抑制通过重写 process.stdout.write 实现
  */
  const commandPath = params.commandPath ?? [];
  /* lyc: preflightSnapshot预检配置快照(ConfigFileSnapshot类型 动态的)
  typeof readConfigFileSnapshot: 获取readConfigFileSnapshot函数类型: () => Promise<ConfigFileSnapshot>
  ReturnType<~>: TS内置ReturnType工具类型提取函数的返回值类型:  Promise<ConfigFileSnapshot>
  Awaited<~>: TS内置工具类型，用于解包Promise，提取内部实际类型: ConfigFileSnapshot
  因此 preflightSnapshot实际类型是: ConfigFileSnapshot
  不直接定义为 ConfigFileSnapshot 类型，是因为 Awaited 类型需要在运行时确定实际类型, 可以做到类型同步, 即当readConfigFileSnapshot函数返回类型发生变化时(例如: Promise<NewConfigFileSnapshot>), preflightSnapshot的类型也会同步更新
  */
  let preflightSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>> | null = null;
  // lyc: 没有 执行了预检流程(执行了运行Doctor配置流程即doctor-config-preflight.js) 
  // lyc: 并且 命令路径需要状态迁移（如从旧版本升级）, 才需要执行预检流程(doctor-config-preflight.js)
  if (!didRunDoctorConfigFlow && shouldMigrateStateFromPath(commandPath)) {
    // lyc: 标记为已执行预检流程, 避免二次执行
    didRunDoctorConfigFlow = true;
    /* lyc: 动态导入 doctor 配置预检模块，避免不必要的依赖加载 */
    const runDoctorConfigPreflight = async () =>
      (await import("../../commands/doctor-config-preflight.js")).runDoctorConfigPreflight({
        // Keep ordinary CLI startup on the lightweight validation path.
        // lyc: 保持普通命令行界面（CLI）启动在轻量级验证路径上。
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });
    // lyc: 没有 抑制 doctor 相关输出到 stdout
    if (!params.suppressDoctorStdout) {
      /* lyc:ai 正常模式：直接获取预检结果 */
      preflightSnapshot = (await runDoctorConfigPreflight()).snapshot;
    } else {
      /* lyc: 这里是 抑制 doctor 相关输出到 stdout 的处理逻辑
      例如: 在JSON输出模式下，必须确保 stdout 只包含纯 JSON 数据。通过临时重写 process.stdout.write 来抑制所有 stdout 输出。
      实现细节：
      - 保存原始的 stdout.write 函数
      - 临时替换为无操作函数 (() => true)
      - 设置环境变量抑制额外的通知
      - 使用 try-finally 确保设置总是被正确恢复
      */
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      const originalSuppressNotes = process.env.OPENCLAW_SUPPRESS_NOTES;
      process.stdout.write = (() => true) as unknown as typeof process.stdout.write;
      process.env.OPENCLAW_SUPPRESS_NOTES = "1";
      try {
        preflightSnapshot = (await runDoctorConfigPreflight()).snapshot;
      } finally {
        /* lyc:ai 恢复原始的 stdout.write 和环境变量 */
        process.stdout.write = originalStdoutWrite;
        if (originalSuppressNotes === undefined) {
          delete process.env.OPENCLAW_SUPPRESS_NOTES;
        } else {
          process.env.OPENCLAW_SUPPRESS_NOTES = originalSuppressNotes;
        }
      }
    }
  }

  /* lyc:ai 
  ========== 阶段二：配置有效性判断 ==========
  获取最终的配置快照，并确定是否允许在无效配置下继续执行。
  
  快照来源优先级：
  1. Doctor 预检结果（如果执行了预检）
  2. 当前配置文件快照（通过缓存读取）
  
  快照包含的关键信息：
  - exists: 配置文件是否存在
  - valid: 配置是否有效
  - issues: 配置问题列表
  - legacyIssues: 旧版配置键问题
  - path: 配置文件路径
  */
  const snapshot = preflightSnapshot ?? (await getConfigSnapshot());
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  const isBareGatewayForegroundRun =
    commandName === "gateway" && (subcommandName === undefined || subcommandName.trim() === "");
  /* lyc: 允许无效配置的决策逻辑: 决定allowInvalid的结果
  这是配置守卫的核心智能：决定何时可以容忍无效配置。
  决策优先级（从高到低）：
  1. 显式参数：params.allowInvalid === true（最高优先级）
  2. 命令白名单：commandName 在 ALLOWED_INVALID_COMMANDS 中
  3. Gateway 子命令白名单：gateway + subcommand 在 ALLOWED_INVALID_GATEWAY_SUBCOMMANDS 中
  设计考虑：
  - 诊断命令（health/status）需要在配置损坏时仍能工作
  - 修复命令（doctor）必须能在任何状态下运行
  - Gateway 管理命令通常不依赖完整的 OpenClaw 配置
  */
  const allowInvalid = commandName
    ? params.allowInvalid === true ||
      ALLOWED_INVALID_COMMANDS.has(commandName) ||
      isBareGatewayForegroundRun ||
      (commandName === "gateway" &&
        subcommandName &&
        ALLOWED_INVALID_GATEWAY_SUBCOMMANDS.has(subcommandName))
    : false;
  const { formatConfigIssueLines } = await import("../../config/issue-format.js");
  const issues =
    snapshot.exists && !snapshot.valid
      ? formatConfigIssueLines(snapshot.issues, "-", { normalizeRoot: true })
      : [];
  const legacyIssues =
    snapshot.legacyIssues.length > 0 ? formatConfigIssueLines(snapshot.legacyIssues, "-") : [];

  const invalid = snapshot.exists && !snapshot.valid;
  /* lyc:ai 如果配置有效或不存在，则直接返回，无需进一步处理 */
  if (!invalid) {
    return;
  }

  /* lyc:ai 
  ========== 阶段三：错误处理和用户反馈 ==========
  配置无效且需要向用户报告错误的情况。
  
  执行步骤：
  1. 动态加载终端主题和格式化工具
  2. 创建颜色格式化函数（支持彩色/单色终端）
  3. 构建结构化的错误信息
  4. 输出详细的错误报告
  5. 提供明确的修复指导
  
  设计目标：
  - 用户友好：清晰指出问题所在
  - 可操作：提供具体的修复命令
  - 专业：使用适当的终端颜色和格式
  */
  /* lyc:ai 加载终端主题和工具函数，用于格式化错误输出 */
  const [{ colorize, isRich, theme }, { shortenHomePath }, { formatCliCommand }] =
    await Promise.all([
      import("../../terminal/theme.js"),
      import("../../utils.js"),
      import("../command-format.js"),
    ]);
  /* lyc:ai 检测终端是否支持富文本（彩色输出） */
  const rich = isRich();
  /* lyc:ai 创建各种颜色格式化函数，用于不同类型的文本 */
  const muted = (value: string) => colorize(rich, theme.muted, value);
  const error = (value: string) => colorize(rich, theme.error, value);
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const commandText = (value: string) => colorize(rich, theme.command, value);

  /* lyc:ai 输出结构化的错误报告 */
  params.runtime.error(heading("Config invalid"));
  params.runtime.error(`${muted("File:")} ${muted(shortenHomePath(snapshot.path))}`);
  if (issues.length > 0) {
    params.runtime.error(muted("Problem:"));
    params.runtime.error(issues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  if (legacyIssues.length > 0) {
    params.runtime.error(muted("Legacy config keys detected:"));
    params.runtime.error(legacyIssues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  params.runtime.error("");
  /* lyc:ai 提供明确的修复指导，这是用户体验的关键 */
  params.runtime.error(
    `${muted("Run:")} ${commandText(formatCliCommand("openclaw doctor --fix"))}`,
  );
  /* lyc:ai 
  ========== 最终决策：是否允许继续执行 ==========
  这是配置守卫的最后一道关卡：
  
  如果不允许无效配置继续执行（!allowInvalid）：
  - 调用 runtime.exit(1) 优雅退出
  - 返回非零退出码表示错误状态
  
  如果允许无效配置继续执行（allowInvalid === true）：
  - 函数正常返回
  - CLI 命令继续执行（通常是诊断或修复命令）
  
  这个设计确保了系统的安全性和可用性之间的平衡。
  */
  if (!allowInvalid) {
    params.runtime.exit(1);
  }
}

export const __test__ = {
  resetConfigGuardStateForTests,
};
