/* lyc:ai



*/

// lyc:aic v2026.5：除了 readConfigFileSnapshot 还引入了 setRuntimeConfigSnapshot
import { readConfigFileSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { shouldMigrateStateFromPath } from "../argv.js";

/* lyc:ai 


*/
const ALLOWED_INVALID_COMMANDS = new Set(["doctor", "logs", "health", "help", "status"]);

/* lyc:ai 


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
*/
let didRunDoctorConfigFlow = false;

/* lyc:ai 
*/
let configSnapshotPromise: Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> | null =
  null;

/* lyc:ai 
*/
function resetConfigGuardStateForTests() {
  didRunDoctorConfigFlow = false;
  configSnapshotPromise = null;
}

/* lyc:ai 
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
  
  
  */
  const commandPath = params.commandPath ?? [];
  /* lyc: preflightSnapshot预检配置快照(ConfigFileSnapshot类型 动态的)
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
  
  
  */
  const snapshot = preflightSnapshot ?? (await getConfigSnapshot());
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  const isBareGatewayForegroundRun =
    commandName === "gateway" && (subcommandName === undefined || subcommandName.trim() === "");
  /* lyc: 允许无效配置的决策逻辑: 决定allowInvalid的结果
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
    setRuntimeConfigSnapshot(snapshot.runtimeConfig ?? snapshot.config, snapshot.sourceConfig);
  }
  if (!invalid) {
    return;
  }

  /* lyc:ai 
  
  
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
  // lyc:aic v2026.5：错误标题从 "Config invalid" 改为 "OpenClaw config is invalid"
  params.runtime.error(heading("OpenClaw config is invalid"));
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
    `${muted("Fix:")} ${commandText(formatCliCommand("openclaw doctor --fix"))}`,
  );
  params.runtime.error(
    `${muted("Inspect:")} ${commandText(formatCliCommand("openclaw config validate"))}`,
  );
  params.runtime.error(
    muted("Status, health, logs, and doctor commands still run with invalid config."),
  );
  /* lyc:ai 
  
  
  
  */
  if (!allowInvalid) {
    params.runtime.exit(1);
  }
}

export const __test__ = {
  resetConfigGuardStateForTests,
};
