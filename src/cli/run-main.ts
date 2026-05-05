// lyc:ai OpenClaw CLI 主入口文件，负责处理命令行参数、初始化环境、注册命令并执行
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeEnv } from "../infra/env.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { PluginManifestCommandAliasRegistry } from "../plugins/manifest-command-aliases.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  shouldRegisterPrimaryCommandOnly,
  shouldSkipPluginCommandRegistration,
} from "./command-registration-policy.js";
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import {
  resolveMissingPluginCommandMessage as resolveMissingPluginCommandMessageFromPolicy,
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldUseBrowserHelpFastPath,
  shouldUseRootHelpFastPath,
} from "./run-main-policy.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

export {
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldUseBrowserHelpFastPath,
  shouldUseRootHelpFastPath,
} from "./run-main-policy.js";

/* lyc:ai 关闭 CLI 内存管理器的异步函数
  在 CLI 进程结束前清理内存资源，特别是内存搜索管理器
*/
async function closeCliMemoryManagers(): Promise<void> {
  const { hasMemoryRuntime } = await import("../plugins/memory-state.js");
  if (!hasMemoryRuntime()) {
    return;
  }
  try {
    const { closeActiveMemorySearchManagers } = await import("../plugins/memory-runtime.js");
    await closeActiveMemorySearchManagers();
  } catch {
    // Best-effort teardown for short-lived CLI processes.
  }
}

// lyc:ai 解析缺失插件命令的错误消息. 当用户尝试执行一个不存在或被禁用的插件命令时，提供详细的错误信息
export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
  options?: { registry?: PluginManifestCommandAliasRegistry },
): string | null {
  return resolveMissingPluginCommandMessageFromPolicy(
    pluginId,
    config,
    options?.registry ? { registry: options.registry } : undefined,
  );
}

// lyc:ai 检查是否需要加载 CLI 的 .env 文件, 先检查当前工作目录cwd()/.env，然后检查状态目录~/.openclaw/.env
function shouldLoadCliDotEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (existsSync(path.join(process.cwd(), ".env"))) {
    return true;
  }
  // lyc: 检查状态目录是否有.env文件, ~/.openclaw/.env
  return existsSync(path.join(resolveStateDir(env), ".env"));
}

function isCommanderParseExit(error: unknown): error is { exitCode: number } {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; exitCode?: unknown };
  return (
    typeof candidate.exitCode === "number" &&
    Number.isInteger(candidate.exitCode) &&
    typeof candidate.code === "string" &&
    candidate.code.startsWith("commander.")
  );
}

// lyc: 确保CLI环境下配置了HTTP/S代理分发器
async function ensureCliEnvProxyDispatcher(): Promise<void> {
  try {
    const { hasEnvHttpProxyAgentConfigured } = await import("../infra/net/proxy-env.js");
    // lyc: 环境变量中是否配置了HTTP/S代理, 如果没有配置, 则直接返回
    if (!hasEnvHttpProxyAgentConfigured()) {
      return;
    }
    const { ensureGlobalUndiciEnvProxyDispatcher } =
      await import("../infra/net/undici-global-dispatcher.js");
    // lyc: 确保全局undici dispatcher 分发器是基于环境变量配置的代理
    ensureGlobalUndiciEnvProxyDispatcher();
  } catch {
    // Best-effort proxy bootstrap; CLI startup should continue without it.
  }
}

// lyc:ai CLI 主运行函数，处理所有命令行参数并执行相应的命令
export async function runCli(argv: string[] = process.argv) {
  // lyc: 规范化 Windows 参数 例如处理 Windows 上的重复 node.exe 路径
  const originalArgv = normalizeWindowsArgv(argv);
  // lyc: 解析CLI容器目标参数--container, 并返回解析结果 return.argv不会包含--container参数, 如果解析失败, 则返回错误信息
  const parsedContainer = parseCliContainerArgs(originalArgv);
  if (!parsedContainer.ok) {
    throw new Error(parsedContainer.error);
  }
  // lyc: 解析profile或dev根选项参数
  const parsedProfile = parseCliProfileArgs(parsedContainer.argv);
  if (!parsedProfile.ok) {
    throw new Error(parsedProfile.error);
  }
  // lyc: 如果有profile或dev根选项参数, 则应用profile环境变量, 并根据profile值设置其他环境变量
  if (parsedProfile.profile) {
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }
  // lyc: 从argv中解析容器目标参数或者从环境变量OPENCLAW_CONTAINER中获取容器名称
  const containerTargetName =
    parsedContainer.container ?? normalizeOptionalString(process.env.OPENCLAW_CONTAINER) ?? null;
  // lyc: --container 与 --profile/--dev 互斥
  if (containerTargetName && parsedProfile.profile) {
    throw new Error("--container cannot be combined with --profile/--dev");
  }

  // lyc: 尝试在容器中运行CLI
  const containerTarget = maybeRunCliInContainer(originalArgv);
  // lyc: 如果容器中运行CLI成功, 则返回
  if (containerTarget.handled) {
    if (containerTarget.exitCode !== 0) {
      // lyc: 如果容器中运行CLI失败, 则设置退出状态码为容器中退出状态码
      process.exitCode = containerTarget.exitCode;
    }
    // lyc: 退出主程序, 并返回容器状态码(process.exitCode)
    return;
  }

  // lyc: 以下代表不在容器中运行CLI

  // lyc: 规范化argv参数, process.argv去掉了--container, --profile/--dev参数 (qa matrix, gateway例外)
  let normalizedArgv = parsedProfile.argv;

  // lyc: 是否需要加载.env文件
  if (shouldLoadCliDotEnv()) {
    const { loadCliDotEnv } = await import("./dotenv.js");
    // lyc: 加载CLI的环境变量(.env), 先加载工作目录下的.env文件cwd/.env, 然后加载状态目录下的.env文件~/.openclaw/.env和~/.config/openclaw/gateway.env
    // lyc: 并且状态目录下的环境变量不会覆盖工作目录下的环境变量
    loadCliDotEnv({ quiet: true });
  }
  // lyc: 规范化环境变量（ ZAI_API_KEY = Z_AI_API_KEY ）
  normalizeEnv();
  // lyc: 确保CLI路径在env.PATH中  
  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }

  // Enforce the minimum supported runtime before doing any work.
  // lyc:ai
  // 强制执行最低支持的运行时版本，确保兼容性
  assertSupportedRuntime();

  try {
    // lyc: 如果是根帮助调用, 则输出预计算的根帮助文本, return
    if (shouldUseRootHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedRootHelpText } = await import("./root-help-metadata.js");
      // lyc: 如果不存在预计算的根帮助文本, 则从程序中获取根帮助文本
      if (!outputPrecomputedRootHelpText()) {
        const { outputRootHelp } = await import("./program/root-help.js");
        await outputRootHelp();
      }
      return;
    }

    // lyc: 如果是浏览器帮助调用, 则输出预计算的浏览器帮助文本并return, 否则什么也不做, 继续执行后续命令
    if (shouldUseBrowserHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedBrowserHelpText } = await import("./root-help-metadata.js");
      if (outputPrecomputedBrowserHelpText()) {
        return;
      }
    }

    /* lyc: Crestodian(克雷斯托迪安)
    一个特殊的运行模式或后端服务,作为本地设置和修复聊天后端,帮助用户“守护”本地配置的助手角色
    */

    /* lyc:ai Crestodian(克雷斯托迪安)
    Crestodian是OpenClaw的本地守护/引导后端服务.
    它有两种互斥的激活路径:
    1. 裸根模式: 用户在终端执行裸命令 `openclaw`（无子命令），Crestodian作为默认入口
    2. 现代引导模式: 用户执行 `openclaw onboard --modern`，Crestodian替代传统向导流程
    核心职责: 提供系统概览 / 诊断修复 / 配置管理 / 网关控制 / Agent和模型管理
    */

    // lyc: 裸根Crestodian" 模式
    const shouldRunBareRootCrestodian = shouldStartCrestodianForBareRoot(normalizedArgv);

    // lyc: 现代Crestodian" 模式
    const shouldRunModernOnboardCrestodian = shouldStartCrestodianForModernOnboard(normalizedArgv);

    // lyc: 如果应该启动Crestodian(克雷斯托迪安), 则确保环境代理分发器已激活
    if (shouldRunBareRootCrestodian || shouldRunModernOnboardCrestodian) {
      await ensureCliEnvProxyDispatcher();
    }

    if (shouldRunBareRootCrestodian) {
      /* lyc:ai
      Crestodian裸根模式需要一个交互式终端(TTY)来与用户对话.
      如果stdin或stdout不是TTY（如管道输入、重定向场景），无法进行交互，直接拒绝.
      替代方案: 使用 `openclaw crestodian --message "status"` 执行单次命令
      */
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        // lyc: Crestodian需要一个交互式TTY（文本终端）。使用`openclaw crestodian --message "status"`执行单次命令
        console.error(
          'Crestodian needs an interactive TTY. Use `openclaw crestodian --message "status"` for one command.',
        );
        process.exitCode = 1;
        return;
      }
      const { runCrestodian } = await import("../crestodian/crestodian.js");
      /* lyc:ai
      创建CLI进度指示器，显示 "Starting Crestodian…" 旋转动画.
      支持多种后端：OSC进度协议 / @clack/prompts spinner / 纯文本行 / 日志行
      delayMs=0 表示立即显示，fallback="none" 表示非TTY时静默
      */
      const { createCliProgress } = await import("./progress.js");
      const progress = createCliProgress({
        label: "Starting Crestodian…",
        indeterminate: true,
        delayMs: 0,
        fallback: "none",
      });
      /* lyc:ai
      progress状态管理：用progressStopped标志位防止重复调用stopProgress.
      stopProgress作为onReady回调传给runCrestodian，在Crestodian完成初始化（加载完概览数据、启动TUI前）时被调用，消除加载动画.
      try/finally确保无论成功或失败都清理进度指示器
      */
      let progressStopped = false;
      const stopProgress = () => {
        if (progressStopped) {
          return;
        }
        progressStopped = true;
        progress.done();
      };
      try {
        await runCrestodian({ onReady: stopProgress });
      } finally {
        stopProgress();
      }
      return;
    }

    // lyc: 重点看上面 shouldRunBareRootCrestodian 中启动裸根Crestodian模式的内容即可, 现代引导模式的实现与裸根模式基本相同
    if (shouldRunModernOnboardCrestodian) {
      /* lyc:ai
      现代引导模式: `openclaw onboard --modern` 的Crestodian入口.
      与裸根模式不同，现代引导模式通过opts.message传参给runCrestodian:
        --non-interactive存在时: message="overview"，只加载并输出系统概览后退出
        交互模式(默认): message=undefined，启动完整的交互式TUI
        --json存在时: 以JSON格式输出系统概览后退出
      yes固定为false（不自动批准永久性操作，需用户确认）
      */
      const { runCrestodian } = await import("../crestodian/crestodian.js");
      const nonInteractive = normalizedArgv.includes("--non-interactive");
      await runCrestodian({
        message: nonInteractive ? "overview" : undefined,
        yes: false,
        json: normalizedArgv.includes("--json"),
        interactive: !nonInteractive,
      });
      return;
    }

    const [
      { initializeDebugProxyCapture, finalizeDebugProxyCapture },
      { maybeWarnAboutDebugProxyCoverage },
    ] = await Promise.all([
      import("../proxy-capture/runtime.js"),
      import("../proxy-capture/coverage.js"),
    ]);
    // lyc: 初始化调试代理捕获, 用于记录http交流信息, 记录在调试代理捕获存储(DebugProxyCaptureStore)中
    initializeDebugProxyCapture("cli");
    // lyc: 当进程退出时, 关闭调试代理捕获存储(DebugProxyCaptureStore) 并清除缓存
    process.once("exit", () => {
      finalizeDebugProxyCapture();
    });
    // lyc: 确保CLI环境下配置了HTTP/S代理分发器
    await ensureCliEnvProxyDispatcher();
    // lyc: 检查调试代理覆盖情况, 并在必要时警告(仅在新会话中输出警告)
    maybeWarnAboutDebugProxyCoverage();

    const { tryRouteCli } = await import("./route.js");
    /* lyc: 
      检查是否可以使用快速路径执行命令, 可以则执行并返回, 否则继续执行主流程
      快速路径命令 ：
      - health ：健康检查
      - status ：状态检查
      - gateway-status ：网关状态
      - sessions ：会话列表
      - agents-list ：代理列表
      - config-get ：配置获取
      - config-unset ：配置取消
      - models-list ：模型列表
      - models-status ：模型状态
      - tasks-list ：任务列表 
      - tasks-audit ：任务审核
      - channels-list ：通道列表
      - channels-status ：通道状态
      快速路径优势 ：
      - 不加载完整 Commander 程序
      - 直接执行命令逻辑
      - 启动速度快
    */
    if (await tryRouteCli(normalizedArgv)) {
      return;
    }

    const { createCliProgress } = await import("./progress.js");
    const startupProgress = createCliProgress({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
      fallback: "none",
    });
    let startupProgressStopped = false;
    const stopStartupProgress = () => {
      if (startupProgressStopped) {
        return;
      }
      startupProgressStopped = true;
      startupProgress.done();
    };

    try {
      // Capture all console output into structured logs while keeping stdout/stderr behavior.
      const { enableConsoleCapture } = await import("../logging.js");
      // lyc:ai
      // 捕获所有控制台输出到结构化日志中，同时保持 stdout/stderr 的行为
      enableConsoleCapture();

      const [
        { buildProgram },
        { formatUncaughtError },
        { runFatalErrorHooks },
        { installUnhandledRejectionHandler, isUncaughtExceptionHandled },
        { restoreTerminalState },
      ] = await Promise.all([
        import("./program.js"),
        import("../infra/errors.js"),
        import("../infra/fatal-error-hooks.js"),
        import("../infra/unhandled-rejections.js"),
        import("../terminal/restore.js"),
      ]);
      const program = buildProgram();

      // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
      // These log the error and exit gracefully instead of crashing without trace.
      // lyc:ai
      // 安装全局未处理拒绝处理器，防止未处理的 Promise 拒绝导致静默崩溃
      installUnhandledRejectionHandler();

      process.on("uncaughtException", (error) => {
        if (isUncaughtExceptionHandled(error)) {
          return;
        }
        console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
        for (const message of runFatalErrorHooks({ reason: "uncaught_exception", error })) {
          console.error("[openclaw]", message);
        }
        restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
        process.exit(1);
      });

      const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
      const invocation = resolveCliArgvInvocation(parseArgv);
      // Register the primary command (builtin or subcli) so help and command parsing
      // are correct even with lazy command registration.
      // lyc:ai
      // 注册主命令（内置命令或子 CLI），确保即使使用延迟命令注册，帮助和命令解析也能正确工作
      const { primary } = invocation;
      if (primary && shouldRegisterPrimaryCommandOnly(parseArgv)) {
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
        primary !== null &&
        program.commands.some(
          (command) => command.name() === primary || command.aliases().includes(primary),
        );
      const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
        argv: parseArgv,
        primary,
        hasBuiltinPrimary,
      });
      if (!shouldSkipPluginRegistration) {
        // Register plugin CLI commands before parsing
        // lyc:ai
        // 在解析之前注册插件 CLI 命令
        const { registerPluginCliCommandsFromValidatedConfig } = await import("../plugins/cli.js");
        const config = await registerPluginCliCommandsFromValidatedConfig(
          program,
          undefined,
          undefined,
          {
            mode: "lazy",
            primary,
          },
        );
        if (config) {
          if (
            primary &&
            !program.commands.some(
              (command) => command.name() === primary || command.aliases().includes(primary),
            )
          ) {
            const { resolveManifestCommandAliasOwner } =
              await import("../plugins/manifest-command-aliases.runtime.js");
            const missingPluginCommandMessage = resolveMissingPluginCommandMessageFromPolicy(
              primary,
              config,
              {
                resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
              },
            );
            if (missingPluginCommandMessage) {
              throw new Error(missingPluginCommandMessage);
            }
          }
        }
      }

      stopStartupProgress();

      try {
        await program.parseAsync(parseArgv);
      } catch (error) {
        if (!isCommanderParseExit(error)) {
          throw error;
        }
        process.exitCode = error.exitCode;
      }
    } finally {
      stopStartupProgress();
    }
  } finally {
    await closeCliMemoryManagers();
  }
}

// lyc:ai
// 检查当前模块是否是主模块
// 用于确定是否应该直接执行 CLI 功能
export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
