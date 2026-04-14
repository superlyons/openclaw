import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../infra/dotenv.js";
import { normalizeEnv } from "../infra/env.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { installUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { enableConsoleCapture } from "../logging.js";
import { getCommandPathWithRootOptions, getPrimaryCommand, hasHelpOrVersion } from "./argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { tryRouteCli } from "./route.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

// lyc: 将 --update 标志转换为 update 命令; openclaw agent --message "hello" --update -> openclaw agent --message "hello" update
export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

// lyc: 判断是否需要注册主子命令; 如果参数中包含帮助、版本标志或根版本别名(-v) 则返回false, 代表不需要注册主子命令
export function shouldRegisterPrimarySubcommand(argv: string[]): boolean {
  return !hasHelpOrVersion(argv);
}

/* lyc: 
  判断是否需要跳过插件命令注册; 
  params.hasBuiltinPrimary=true: 如果有内置主命令 → 跳过插件注册
  如果没有主命令且有 help/version → 跳过插件注册
  否则 → 不跳过插件注册
  原因:
  - 内置命令已经足够，不需要插件命令
  - help/version 命令不需要插件支持
*/
export function shouldSkipPluginCommandRegistration(params: {
  argv: string[];
  primary: string | null;
  hasBuiltinPrimary: boolean;
}): boolean {
  if (params.hasBuiltinPrimary) {
    return true;
  }
  if (!params.primary) {
    return hasHelpOrVersion(params.argv);
  }
  return false;
}

/* lyc: 
  判断是否需要确保 OpenClawCli 路径在process.env.PATH环境变量中
  - status 、 health 、 sessions 不需要（这些命令可能在没有完整 CLI 环境时运行）
  - config get 、 config unset 不需要
  - models list 、 models status 不需要
  - 其他命令都需要
*/
export function shouldEnsureCliPath(argv: string[]): boolean {
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  if (!primary) {
    return true;
  }
  if (primary === "status" || primary === "health" || primary === "sessions") {
    return false;
  }
  if (primary === "config" && (secondary === "get" || secondary === "unset")) {
    return false;
  }
  if (primary === "models" && (secondary === "list" || secondary === "status")) {
    return false;
  }
  return true;
}

export async function runCli(argv: string[] = process.argv) {
  // lyc: 规范化 Windows 参数 ：处理 Windows 上的重复 node.exe 路径
  let normalizedArgv = normalizeWindowsArgv(argv);
  // lyc: 解析 CLI 配置参数
  const parsedProfile = parseCliProfileArgs(normalizedArgv);
  if (!parsedProfile.ok) {
    throw new Error(parsedProfile.error);
  }
  if (parsedProfile.profile) {
    // lyc: 应用 Profile 环境：设置 OPENCLAW_PROFILE、OPENCLAW_STATE_DIR 等环境变量
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }
  // lyc: 更新参数 ：清理 profile 参数后的参数数组
  normalizedArgv = parsedProfile.argv;

  /* lyc: 运行到此举例:
    # 运行: openclaw --profile dev agent --message "hello"
    # parsedProfile = { ok: true, profile: "dev", argv: [...] }
    # applyCliProfileEnv({ profile: "dev" })
    #   → OPENCLAW_PROFILE = "dev"
    #   → OPENCLAW_STATE_DIR = "~/.openclaw-dev"
    #   → OPENCLAW_GATEWAY_PORT = "19001"
    # normalizedArgv = ["node", "openclaw.mjs", "agent", "--message", "hello"]
  */

  /* lyc: 加载环境变量
    - 加载当前工作目录的 .env 文件
  - 加载全局 .env 文件 ( ~/.openclaw/.env )
  - 全局文件不会覆盖已存在的环境变量
  */
  loadDotEnv({ quiet: true });
  // lyc: 规范化 Zai 环境变量（ Z_AI_API_KEY → ZAI_API_KEY ）
  normalizeEnv();
  if (shouldEnsureCliPath(normalizedArgv)) {
    // lyc: 确保 OpenClawCli 路径在process.env.PATH环境变量中
    ensureOpenClawCliOnPath();
  }

  // Enforce the minimum supported runtime before doing any work.
  // lyc: 确保当前 Node.js 版本支持 OpenClawCli 运行
  assertSupportedRuntime();

  /* lyc: 
    检查是否可以使用快速路径执行命令, 可以则执行并返回, 否则继续执行主流程
    快速路径命令 ：
    - health ：健康检查
    - status ：状态检查
    - sessions ：会话列表
    - agents list ：代理列表
    - memory status ：内存状态
    - config get ：配置获取
    - config unset ：配置取消
    - models list ：模型列表
    - models status ：模型状态
    快速路径优势 ：
    - 不加载完整 Commander 程序
    - 直接执行命令逻辑
    - 启动速度快
    tryRouterCli没有没进一步分析, 后续需要补上
  */
  if (await tryRouteCli(normalizedArgv)) {
    return;
  }

  // Capture all console output into structured logs while keeping stdout/stderr behavior.
  // lyc: 捕获所有 console 输出到结构化日志中
  enableConsoleCapture();

  const { buildProgram } = await import("./program.js");
  const program = buildProgram();

  // Global error handlers to prevent silent 1111crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  installUnhandledRejectionHandler();

  process.on("uncaughtException", (error) => {
    console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
    process.exit(1);
  });

  const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
  // Register the primary command (builtin or subcli) so help and command parsing
  // are correct even with lazy command registration.
  const primary = getPrimaryCommand(parseArgv);
  if (primary) {
    const { getProgramContext } = await import("./program/program-context.js");
    const ctx = getProgramContext(program);
    if (ctx) {
      const { registerCoreCliByName } = await import("./program/command-registry.js");
      await registerCoreCliByName(program, ctx, primary, parseArgv);
    }
    const { registerSubCliByName } = await import("./program/register.subclis.js");
    await registerSubCliByName(program, primary);
  }

  const hasBuiltinPrimary =
    primary !== null && program.commands.some((command) => command.name() === primary);
  const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
    argv: parseArgv,
    primary,
    hasBuiltinPrimary,
  });
  if (!shouldSkipPluginRegistration) {
    // Register plugin CLI commands before parsing
    const { registerPluginCliCommands } = await import("../plugins/cli.js");
    const { loadConfig } = await import("../config/config.js");
    registerPluginCliCommands(program, loadConfig());
  }

  await program.parseAsync(parseArgv);
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
