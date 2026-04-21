// lyc:ai OpenClaw CLI 主入口文件，负责处理命令行参数、初始化环境、注册命令并执行
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeEnv } from "../infra/env.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { enableConsoleCapture } from "../logging.js";
import type { PluginManifestCommandAliasRegistry } from "../plugins/manifest-command-aliases.js";
import { resolveManifestCommandAliasOwner } from "../plugins/manifest-command-aliases.runtime.js";
import { hasMemoryRuntime } from "../plugins/memory-state.js";
import { maybeWarnAboutDebugProxyCoverage } from "../proxy-capture/coverage.js";
import {
  finalizeDebugProxyCapture,
  initializeDebugProxyCapture,
} from "../proxy-capture/runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  shouldRegisterPrimaryCommandOnly,
  shouldSkipPluginCommandRegistration,
} from "./command-registration-policy.js";
import { shouldEnsureCliPathForCommandPath } from "./command-startup-policy.js";
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { tryRouteCli } from "./route.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

/* lyc:ai 关闭 CLI 内存管理器的异步函数
  在 CLI 进程结束前清理内存资源，特别是内存搜索管理器
*/
async function closeCliMemoryManagers(): Promise<void> {
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

// lyc: 将 --update 标志转换为 update 命令 例如: openclaw agent --message "hello" --update -> openclaw agent --message "hello" update
export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

// lyc: 检查当前命令(commandPath)是否需要确保CLI路径
export function shouldEnsureCliPath(argv: string[]): boolean {
  // lyc: 解析调用信息, 获得命令路径, 主命令, 是否有帮助或版本选项, 是否为根帮助调用
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  // lyc: 检查是否确保CLI路径, 
  return shouldEnsureCliPathForCommandPath(invocation.commandPath);
}

// lyc:ai 检查是否应该使用根帮助快速路径. 当用户请求根级别的帮助信息时返回true，可以跳过完整的命令注册流程
export function shouldUseRootHelpFastPath(argv: string[]): boolean {
  return resolveCliArgvInvocation(argv).isRootHelpInvocation;
}

// lyc:ai 解析缺失插件命令的错误消息. 当用户尝试执行一个不存在或被禁用的插件命令时，提供详细的错误信息
export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
  options?: { registry?: PluginManifestCommandAliasRegistry },
): string | null {
  const normalizedPluginId = normalizeLowercaseStringOrEmpty(pluginId);
  if (!normalizedPluginId) {
    return null;
  }
  const allow =
    Array.isArray(config?.plugins?.allow) && config.plugins.allow.length > 0
      ? config.plugins.allow
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => normalizeOptionalLowercaseString(entry))
          .filter(Boolean)
      : [];
  const commandAlias = resolveManifestCommandAliasOwner({
    command: normalizedPluginId,
    config,
    registry: options?.registry,
  });
  const parentPluginId = commandAlias?.pluginId;
  if (parentPluginId) {
    if (allow.length > 0 && !allow.includes(parentPluginId)) {
      return (
        `"${normalizedPluginId}" is not a plugin; it is a command provided by the ` +
        `"${parentPluginId}" plugin. Add "${parentPluginId}" to \`plugins.allow\` ` +
        `instead of "${normalizedPluginId}".`
      );
    }
    if (config?.plugins?.entries?.[parentPluginId]?.enabled === false) {
      return (
        `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
        `\`plugins.entries.${parentPluginId}.enabled=false\`. Re-enable that entry if you want ` +
        "the bundled plugin command surface."
      );
    }
    if (commandAlias.kind === "runtime-slash") {
      const cliHint = commandAlias.cliCommand
        ? `Use \`openclaw ${commandAlias.cliCommand}\` for related CLI operations, or `
        : "Use ";
      return (
        `"${normalizedPluginId}" is a runtime slash command (/${normalizedPluginId}), not a CLI command. ` +
        `It is provided by the "${parentPluginId}" plugin. ` +
        `${cliHint}\`/${normalizedPluginId}\` in a chat session.`
      );
    }
  }

  if (allow.length > 0 && !allow.includes(normalizedPluginId)) {
    if (parentPluginId && allow.includes(parentPluginId)) {
      return null;
    }
    return (
      `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
      `\`plugins.allow\` excludes "${normalizedPluginId}". Add "${normalizedPluginId}" to ` +
      `\`plugins.allow\` if you want that bundled plugin CLI surface.`
    );
  }
  if (config?.plugins?.entries?.[normalizedPluginId]?.enabled === false) {
    return (
      `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
      `\`plugins.entries.${normalizedPluginId}.enabled=false\`. Re-enable that entry if you want ` +
      "the bundled plugin CLI surface."
    );
  }
  return null;
}

// lyc:ai 检查是否需要加载 CLI 的 .env 文件, 先检查当前工作目录cwd()/.env，然后检查状态目录~/.openclaw/.env
function shouldLoadCliDotEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (existsSync(path.join(process.cwd(), ".env"))) {
    return true;
  }
  // lyc: 检查状态目录是否有.env文件, ~/.openclaw/.env
  return existsSync(path.join(resolveStateDir(env), ".env"));
}

// lyc:ai CLI 主运行函数，处理所有命令行参数并执行相应的命令
export async function runCli(argv: string[] = process.argv) {
  // lyc: 规范化 Windows 参数 例如处理 Windows 上的重复 node.exe 路径
  const originalArgv = normalizeWindowsArgv(argv);
  // lyc: 解析CLI容器目标参数, 并返回解析结果
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
  // lyc: 初始化调试代理捕获, 用于记录http交流信息, 记录在调试代理捕获存储(DebugProxyCaptureStore)中
  initializeDebugProxyCapture("cli");
  // lyc: 当进程退出时, 关闭调试代理捕获存储(DebugProxyCaptureStore) 并清除缓存
  process.once("exit", () => {
    finalizeDebugProxyCapture();
  });
  // lyc: 确保 undici 全局 dispatcher 分发器是基于环境变量配置的代理
  ensureGlobalUndiciEnvProxyDispatcher();
  // lyc: 检查调试代理覆盖情况, 并在必要时警告(仅在新会话中输出警告)
  maybeWarnAboutDebugProxyCoverage();

  // lyc: 确保CLI路径在env.PATH中
  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }

  // lyc:ai
  // 强制执行最低支持的运行时版本，确保兼容性
  assertSupportedRuntime();

  try {
    // lyc: 如果是根帮助调用, 则输出预计算的根帮助文本
    if (shouldUseRootHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedRootHelpText } = await import("./root-help-metadata.js");
      // lyc: 如果不存在预计算的根帮助文本, 则从程序中获取根帮助文本
      if (!outputPrecomputedRootHelpText()) {
        const { outputRootHelp } = await import("./program/root-help.js");
        await outputRootHelp();
      }
      return;
    }

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
    快速路径优势 ：
    - 不加载完整 Commander 程序
    - 直接执行命令逻辑
    - 启动速度快
  */
    if (await tryRouteCli(normalizedArgv)) {
      return;
    }

    // lyc:ai
    // 捕获所有控制台输出到结构化日志中，同时保持 stdout/stderr 的行为
    enableConsoleCapture();

    const [{ buildProgram }, { installUnhandledRejectionHandler }, { restoreTerminalState }] =
      await Promise.all([
        import("./program.js"),
        import("../infra/unhandled-rejections.js"),
        import("../terminal/restore.js"),
      ]);
    const program = buildProgram();

    // lyc:ai
    // 安装全局未处理拒绝处理器，防止未处理的 Promise 拒绝导致静默崩溃
    installUnhandledRejectionHandler();

    process.on("uncaughtException", (error) => {
      console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
      restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
      process.exit(1);
    });

    const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
    const invocation = resolveCliArgvInvocation(parseArgv);
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
      primary !== null && program.commands.some((command) => command.name() === primary);
    const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
      argv: parseArgv,
      primary,
      hasBuiltinPrimary,
    });
    if (!shouldSkipPluginRegistration) {
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
        if (primary && !program.commands.some((command) => command.name() === primary)) {
          const missingPluginCommandMessage = resolveMissingPluginCommandMessage(primary, config);
          if (missingPluginCommandMessage) {
            throw new Error(missingPluginCommandMessage);
          }
        }
      }
    }

    try {
      await program.parseAsync(parseArgv);
    } catch (error) {
      if (!(error instanceof CommanderError)) {
        throw error;
      }
      process.exitCode = error.exitCode;
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
