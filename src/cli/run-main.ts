// lyc:ai OpenClaw CLI 主入口文件，负责处理命令行参数、初始化环境、注册命令并执行
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue, normalizeEnv } from "../infra/env.js";
import { isMainModule } from "../infra/is-main.js";
import type { ProxyHandle } from "../infra/net/proxy/proxy-lifecycle.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { PluginManifestCommandAliasRegistry } from "../plugins/manifest-command-aliases.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  isReservedNonPluginCommandRoot,
  shouldRegisterPrimaryCommandOnly,
  shouldSkipPluginCommandRegistration,
} from "./command-registration-policy.js";
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";
import {
  consumeGatewayFastPathRootOptionToken,
  consumeGatewayRunOptionToken,
} from "./gateway-run-argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { getCoreCliCommandNames } from "./program/core-command-descriptors.js";
import { getSubCliEntries } from "./program/subcli-descriptors.js";
import {
  resolveMissingPluginCommandMessage as resolveMissingPluginCommandMessageFromPolicy,
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldStartProxyForCli,
  shouldUseBrowserHelpFastPath,
  shouldUseRootHelpFastPath,
} from "./run-main-policy.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

export {
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldStartProxyForCli,
  shouldUseBrowserHelpFastPath,
  shouldUseRootHelpFastPath,
} from "./run-main-policy.js";

// lyc:aic v2026.5 新增：Awaitable 泛型、CLI 代理环境变量名常量、gateway 启动 trace 工具
//         你原本在 closeCliMemoryManagers 上方的 lyc:ai 注释，已迁移到本文件下方真正定义 closeCliMemoryManagers 的位置（HEAD line ~207）。
type Awaitable<T> = T | Promise<T>;

const CLI_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

function createGatewayCliMainStartupTrace(argv: string[]) {
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
    argv.slice(2).includes("gateway");
  const started = performance.now();
  let last = started;
  const emit = (name: string, durationMs: number, totalMs: number) => {
    if (!enabled) {
      return;
    }
    process.stderr.write(
      `[gateway] startup trace: cli.main.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
    );
  };
  return {
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
    },
    async measure<T>(name: string, run: () => Awaitable<T>): Promise<T> {
      const before = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        emit(name, now - before, now - started);
        last = now;
      }
    },
  };
}

// lyc:aic v2026.5 新增：gateway-run 子命令的快速路径识别（绕开完整 Commander 加载）
export function isGatewayRunFastPathArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  const args = argv.slice(2);
  let sawGateway = false;
  let sawRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return false;
    }
    if (!sawGateway) {
      const consumed = consumeGatewayFastPathRootOptionToken(args, index);
      if (consumed > 0) {
        index += consumed - 1;
        continue;
      }
      if (arg !== "gateway") {
        return false;
      }
      sawGateway = true;
      continue;
    }

    const consumed = consumeGatewayRunOptionToken(args, index);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (!sawRun && arg === "run") {
      sawRun = true;
      continue;
    }
    return false;
  }

  return sawGateway;
}

function hasJsonOutputFlag(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--json" || arg.startsWith("--json=")) {
      return true;
    }
  }
  return false;
}

async function tryRunGatewayRunFastPath(
  argv: string[],
  startupTrace: ReturnType<typeof createGatewayCliMainStartupTrace>,
): Promise<boolean> {
  if (!isGatewayRunFastPathArgv(argv)) {
    return false;
  }
  const [
    { Command },
    { addGatewayRunCommand },
    { VERSION },
    { emitCliBanner },
    { resolveCliStartupPolicy },
    { enableConsoleCapture },
  ] = await startupTrace.measure("gateway-run-imports", () =>
    Promise.all([
      import("commander"),
      import("./gateway-cli/run-command.js"),
      import("../version.js"),
      import("./banner.js"),
      import("./command-startup-policy.js"),
      import("../logging.js"),
    ]),
  );
  const invocation = resolveCliArgvInvocation(argv);
  const startupPolicy = resolveCliStartupPolicy({
    commandPath: invocation.commandPath,
    jsonOutputMode: hasJsonOutputFlag(argv),
    routeMode: true,
  });
  if (!startupPolicy.hideBanner) {
    emitCliBanner(VERSION, { argv });
  }
  const program = new Command();
  program.name("openclaw");
  program.enablePositionalOptions();
  program.option("--no-color", "Disable ANSI colors", false);
  program.exitOverride((err) => {
    process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
    throw err;
  });
  const gateway = addGatewayRunCommand(
    program.command("gateway").description("Run, inspect, and query the WebSocket Gateway"),
  );
  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
  );
  enableConsoleCapture();
  try {
    await startupTrace.measure("gateway-run-parse", () => program.parseAsync(argv));
  } catch (error) {
    if (!isCommanderParseExit(error)) {
      throw error;
    }
    process.exitCode = error.exitCode;
  }
  return true;
}

/* lyc:ai 关闭 CLI 内存管理器的异步函数
*/
// lyc:aic v2026.5：整个函数被 try/catch 包了一层（best-effort 清理；package 更新时哈希 chunk 可能已被替换）
async function closeCliMemoryManagers(): Promise<void> {
  try {
    const { hasMemoryRuntime } = await import("../plugins/memory-state.js");
    if (!hasMemoryRuntime()) {
      return;
    }
    const { closeActiveMemorySearchManagers } = await import("../plugins/memory-runtime.js");
    await closeActiveMemorySearchManagers();
  } catch {
    // Best-effort teardown for short-lived CLI processes. Package updates can
    // replace hashed chunks before this finalizer runs.
  }
}

async function disposeCliAgentHarnesses(): Promise<void> {
  try {
    const { listAgentHarnessIds, disposeRegisteredAgentHarnesses } =
      await import("../agents/harness/registry.js");
    if (listAgentHarnessIds().length === 0) {
      return;
    }
    await disposeRegisteredAgentHarnesses();
  } catch {
    // Best-effort teardown for short-lived CLI commands. Harness plugins may
    // own subprocesses, but cleanup must not hide the command's real outcome.
  }
}

function pauseNonTtyStdinForCliExit(): void {
  const stdin = process.stdin;
  if (stdin.isTTY) {
    return;
  }
  try {
    stdin.pause();
  } catch {
    // Best-effort cleanup for command paths that only inspected stdin.
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

// lyc:aic v2026.5 新增：判断是否在快速路径之前就要启动 CLI 代理
//         （如果设置了 OPENCLAW_DEBUG_PROXY_* 或有任何 *_PROXY 环境变量，则需要尽早启动）
function shouldBootstrapCliProxyBeforeFastPath(env: NodeJS.ProcessEnv = process.env): boolean {
  if (
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_ENABLED) ||
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_REQUIRE)
  ) {
    return true;
  }
  return CLI_PROXY_ENV_KEYS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function isKnownBuiltInCommandRoot(primary: string): boolean {
  return (
    getCoreCliCommandNames().includes(primary) ||
    getSubCliEntries().some((entry) => entry.name === primary)
  );
}

async function isPluginCliRoot(params: {
  primary: string;
  config: OpenClawConfig;
}): Promise<boolean | null> {
  try {
    const { resolvePluginCliRootOwnerIds } = await import("../plugins/cli-registry-loader.js");
    const ownerIds = await resolvePluginCliRootOwnerIds({
      cfg: params.config,
      env: process.env,
      primaryCommand: params.primary,
    });
    return ownerIds === null ? null : ownerIds.length > 0;
  } catch {
    return null;
  }
}

function createAllowlistAgnosticCliLookupConfig(config: OpenClawConfig): OpenClawConfig {
  if (!Array.isArray(config.plugins?.allow) || config.plugins.allow.length === 0) {
    return config;
  }
  return {
    ...config,
    plugins: {
      ...config.plugins,
      allow: [],
    },
  };
}

async function resolveCliCommandSurfaceOwner(params: {
  primary: string;
  config: OpenClawConfig;
}): Promise<string | undefined> {
  const { resolveManifestCliCommandSurfaceOwner } =
    await import("../plugins/manifest-command-aliases.runtime.js");
  const manifestOwner = resolveManifestCliCommandSurfaceOwner({
    command: params.primary,
    config: params.config,
    env: process.env,
  });
  if (manifestOwner) {
    return manifestOwner;
  }
  try {
    const { resolvePluginCliRootOwnerIds } = await import("../plugins/cli-registry-loader.js");
    return (
      await resolvePluginCliRootOwnerIds({
        cfg: createAllowlistAgnosticCliLookupConfig(params.config),
        env: process.env,
        primaryCommand: params.primary,
      })
    )?.[0];
  } catch {
    return undefined;
  }
}

async function resolveUnownedCliPrimary(params: {
  argv: string[];
  config: OpenClawConfig;
}): Promise<string | null> {
  const invocation = resolveCliArgvInvocation(rewriteUpdateFlagArgv(params.argv));
  const { primary } = invocation;
  if (
    invocation.hasHelpOrVersion ||
    !primary ||
    primary === "help" ||
    isReservedNonPluginCommandRoot(primary) ||
    isKnownBuiltInCommandRoot(primary)
  ) {
    return null;
  }
  const pluginRoot = await isPluginCliRoot({ primary, config: params.config });
  if (pluginRoot !== false) {
    return null;
  }
  return primary;
}

async function resolveUnownedCliPrimaryMessage(params: {
  primary: string;
  config: OpenClawConfig;
}): Promise<string> {
  const { resolveManifestCommandAliasOwner, resolveManifestToolOwner } =
    await import("../plugins/manifest-command-aliases.runtime.js");
  const cliCommandSurfaceOwner = await resolveCliCommandSurfaceOwner(params);
  return (
    resolveMissingPluginCommandMessageFromPolicy(params.primary, params.config, {
      resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
      resolveToolOwner: resolveManifestToolOwner,
      resolveCliCommandSurfaceOwner: () => cliCommandSurfaceOwner,
    }) ??
    `Unknown command: openclaw ${params.primary}. No built-in command or plugin CLI metadata owns "${params.primary}".`
  );
}

// lyc:aic v2026.5 新函数：把原本 runCli 内联的 4 步代理引导封装起来；
//         注释从 src/cli/run-main.ts 内联位置迁移过来。
async function bootstrapCliProxyCaptureAndDispatcher(
  startupTrace: ReturnType<typeof createGatewayCliMainStartupTrace>,
  options: { ensureDispatcher?: boolean } = {},
): Promise<void> {
  const [
    { initializeDebugProxyCapture, finalizeDebugProxyCapture },
    { maybeWarnAboutDebugProxyCoverage },
  ] = await startupTrace.measure("proxy-imports", () =>
    Promise.all([import("../proxy-capture/runtime.js"), import("../proxy-capture/coverage.js")]),
  );
  // lyc: 初始化调试代理捕获, 用于记录 http 交流信息, 记录在调试代理捕获存储 (DebugProxyCaptureStore) 中
  initializeDebugProxyCapture("cli");
  // lyc: 当进程退出时, 关闭调试代理捕获存储 (DebugProxyCaptureStore) 并清除缓存
  process.once("exit", () => {
    finalizeDebugProxyCapture();
  });
  // lyc: 确保 CLI 环境下配置了 HTTP/S 代理分发器
  // lyc:aic v2026.5：新增 ensureDispatcher 开关，默认 true。配合上面 shouldUseCliEnvProxy 控制是否真的需要分发器
  if (options.ensureDispatcher !== false) {
    await startupTrace.measure("proxy-dispatcher", () => ensureCliEnvProxyDispatcher());
  }
  // lyc: 检查调试代理覆盖情况, 并在必要时警告 (仅在新会话中输出警告)
  maybeWarnAboutDebugProxyCoverage();
}

// lyc:ai CLI 主运行函数，处理所有命令行参数并执行相应的命令
// lyc:aic v2026.5 新增上方 8 个 helper：proxy bootstrap 判断 / 内置命令识别 / 插件 CLI root 解析 /
//         无主命令消息生成 / 代理捕获引导。这些都是为了让"找不到命令"时给出更精准的错误。
export async function runCli(argv: string[] = process.argv) {
  // lyc: 规范化 Windows 参数 例如处理 Windows 上的重复 node.exe 路径
  const originalArgv = normalizeWindowsArgv(argv);
  // lyc:aic v2026.5 新增：创建 gateway 启动 trace（OPENCLAW_GATEWAY_STARTUP_TRACE=1 时输出各阶段耗时）
  const startupTrace = createGatewayCliMainStartupTrace(originalArgv);
  // lyc: 解析 CLI 容器目标参数 --container, 并返回解析结果 return.argv 不会包含 --container 参数, 如果解析失败, 则返回错误信息
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
  const normalizedInvocation = resolveCliArgvInvocation(normalizedArgv);
  const isHelpOrVersionInvocation = normalizedInvocation.hasHelpOrVersion;
  startupTrace.mark("argv");

  // lyc: 是否需要加载 .env 文件
  // lyc:aic v2026.5：加了 !isHelpOrVersionInvocation 守卫（help/version 不需要 dotenv），整段用 startupTrace.measure 包计时
  if (!isHelpOrVersionInvocation && shouldLoadCliDotEnv()) {
    await startupTrace.measure("dotenv", async () => {
      const { loadCliDotEnv } = await import("./dotenv.js");
      // lyc: 加载 CLI 的环境变量 (.env), 先加载工作目录下的 .env 文件 cwd/.env, 然后加载状态目录下的 .env 文件 ~/.openclaw/.env 和 ~/.config/openclaw/gateway.env
      // lyc: 并且状态目录下的环境变量不会覆盖工作目录下的环境变量
      loadCliDotEnv({ quiet: true });
    });
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

  // Activate operator-managed proxy routing for network-capable commands.
  // Local Gateway/control-plane commands keep direct loopback access while
  // runtime, provider, plugin, update, and manifest/metadata-owned plugin commands route egress.
  let proxyHandle: ProxyHandle | null = null;
  let bestEffortConfigPromise: Promise<OpenClawConfig> | null = null;
  const readBestEffortCliConfig = async (): Promise<OpenClawConfig> => {
    if (!bestEffortConfigPromise) {
      bestEffortConfigPromise = import("../config/io.js").then(({ readBestEffortConfig }) =>
        readBestEffortConfig(),
      );
    }
    return await bestEffortConfigPromise;
  };
  const stopStartedProxy = async () => {
    const handle = proxyHandle;
    proxyHandle = null;
    if (handle) {
      const { stopProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
      await stopProxy(handle);
    }
  };
  const killStartedProxy = () => {
    const handle = proxyHandle;
    proxyHandle = null;
    handle?.kill("SIGTERM");
  };
  if (!isHelpOrVersionInvocation && shouldStartProxyForCli(normalizedArgv)) {
    const config = await readBestEffortCliConfig();
    const unownedPrimary = await resolveUnownedCliPrimary({ argv: normalizedArgv, config });
    if (unownedPrimary) {
      throw new Error(await resolveUnownedCliPrimaryMessage({ primary: unownedPrimary, config }));
    }
    const { startProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
    proxyHandle = await startProxy(config?.proxy ?? undefined);
  }

  let onSigterm: (() => void) | null = null;
  let onSigint: (() => void) | null = null;
  let onExit: (() => void) | null = null;
  if (proxyHandle) {
    const shutdown = (exitCode: number) => {
      if (onSigterm) {
        process.off("SIGTERM", onSigterm);
      }
      if (onSigint) {
        process.off("SIGINT", onSigint);
      }
      void stopStartedProxy().finally(() => {
        process.exit(exitCode);
      });
    };
    onSigterm = () => shutdown(143);
    onSigint = () => shutdown(130);
    onExit = () => killStartedProxy();
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    process.once("exit", onExit);
  }

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
    */

    /* lyc:ai Crestodian(克雷斯托迪安)
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
      */
      const { createCliProgress } = await import("./progress.js");
      const progress = createCliProgress({
        label: "Starting Crestodian…",
        indeterminate: true,
        delayMs: 0,
        fallback: "none",
      });
      /* lyc:ai
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

    // lyc:aic v2026.5 新增 gateway-run 快速路径 + 代理启动顺序控制：
    //   shouldUseCliEnvProxy → 是否要为 CLI 配置代理（非 help/version 且 shouldStartProxyForCli）
    //   bootstrapProxyBeforeFastPath → 是否需要在 fast-path 之前就拉起代理（看 OPENCLAW_DEBUG_PROXY_* 或 *_PROXY 是否已设）
    //   据此决定 tryRunGatewayRunFastPath 是放在代理启动之前还是之后
    const shouldUseCliEnvProxy =
      !isHelpOrVersionInvocation && shouldStartProxyForCli(normalizedArgv);
    const bootstrapProxyBeforeFastPath =
      shouldUseCliEnvProxy && shouldBootstrapCliProxyBeforeFastPath();
    if (
      !bootstrapProxyBeforeFastPath &&
      (await tryRunGatewayRunFastPath(normalizedArgv, startupTrace))
    ) {
      return;
    }

    // lyc: 引导 CLI 代理捕获 + 分发器（原本是内联 4 步：initializeDebugProxyCapture/process.once exit→finalize/
    //      ensureCliEnvProxyDispatcher/maybeWarnAboutDebugProxyCoverage），v2026.5 抽成 bootstrapCliProxyCaptureAndDispatcher
    if (!isHelpOrVersionInvocation) {
      await bootstrapCliProxyCaptureAndDispatcher(startupTrace, {
        ensureDispatcher: shouldUseCliEnvProxy,
      });
    }

    if (
      bootstrapProxyBeforeFastPath &&
      (await tryRunGatewayRunFastPath(normalizedArgv, startupTrace))
    ) {
      return;
    }

    // lyc:aic L3 快速路径（3 层梯队的最后一层；L1/L2 在 src/entry.ts）
    //         L3 命中即执行并 return，未命中（return false）→ 落入下方 buildProgram 慢路径
    // lyc:aic v2026.5：import 和 tryRouteCli 调用都用 startupTrace.measure 包了计时
    /* lyc:
    */
    const { tryRouteCli } = await startupTrace.measure("route-import", () => import("./route.js"));
    if (await startupTrace.measure("route", () => tryRouteCli(normalizedArgv))) {
      return;
    }

    // lyc:aic ====== 慢路径起点 ======
    // 3 层快速路径（L1=--version, L2=根 --help, L3=tryRouteCli）全部未命中，
    // 才执行下面这段：构建完整 Commander 程序、注册命令、解析 argv。
    // 5 步骤：enableConsoleCapture → buildProgram → 错误处理器 → 命令注册(core/subcli/plugin) → program.parseAsync
    const { createCliProgress } = await import("./progress.js");
    const startupProgress = createCliProgress({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
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
        { formatCliFailureLines },
        { runFatalErrorHooks },
        {
          installUnhandledRejectionHandler,
          isBenignUncaughtExceptionError,
          isUncaughtExceptionHandled,
        },
        { restoreTerminalState },
      ] = await startupTrace.measure("core-imports", () =>
        Promise.all([
          import("./program.js"),
          import("../infra/errors.js"),
          import("./failure-output.js"),
          import("../infra/fatal-error-hooks.js"),
          import("../infra/unhandled-rejections.js"),
          import("../terminal/restore.js"),
        ]),
      );
      const program = await startupTrace.measure("build-program", () => buildProgram());

      // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
      // These log the error and exit gracefully instead of crashing without trace.
      // lyc:ai
      // 安装全局未处理拒绝处理器，防止未处理的 Promise 拒绝导致静默崩溃
      installUnhandledRejectionHandler();

      process.on("uncaughtException", (error) => {
        if (isUncaughtExceptionHandled(error)) {
          return;
        }
        if (isBenignUncaughtExceptionError(error)) {
          console.warn(
            "[openclaw] Non-fatal uncaught exception (continuing):",
            formatUncaughtError(error),
          );
          return;
        }
        for (const line of formatCliFailureLines({
          title: "OpenClaw hit an unexpected runtime error.",
          error,
          argv: normalizedArgv,
        })) {
          console.error(line);
        }
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
        await startupTrace.measure("register-primary", async () => {
          const { getProgramContext } = await import("./program/program-context.js");
          const ctx = getProgramContext(program);
          if (ctx) {
            const { registerCoreCliByName } = await import("./program/command-registry.js");
            await registerCoreCliByName(program, ctx, primary, parseArgv);
          }
          const { registerSubCliByName } = await import("./program/register.subclis.js");
          await registerSubCliByName(program, primary, parseArgv);
        });
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
        // lyc:ai 在解析之前注册插件 CLI 命令
        // lyc:aic v2026.5 增强：
        //   1. 整段用 startupTrace.measure("register-plugin-commands") 包计时
        //   2. 如果是 --json 输出模式（hasJsonOutputFlag），临时把 loggingState.forceConsoleToStderr=true，
        //      避免插件注册日志污染 stdout 的 JSON 输出，注册完后恢复
        const config = await startupTrace.measure("register-plugin-commands", async () => {
          const { registerPluginCliCommandsFromValidatedConfig } =
            await import("../plugins/cli.js");
          if (!hasJsonOutputFlag(parseArgv)) {
            return await registerPluginCliCommandsFromValidatedConfig(
              program,
              undefined,
              undefined,
              {
                mode: "lazy",
                primary,
              },
            );
          }
          const { loggingState } = await import("../logging/state.js");
          const previousForceStderr = loggingState.forceConsoleToStderr;
          loggingState.forceConsoleToStderr = true;
          try {
            return await registerPluginCliCommandsFromValidatedConfig(
              program,
              undefined,
              undefined,
              {
                mode: "lazy",
                primary,
              },
            );
          } finally {
            loggingState.forceConsoleToStderr = previousForceStderr;
          }
        });
        if (config) {
          if (
            primary &&
            !program.commands.some(
              (command) => command.name() === primary || command.aliases().includes(primary),
            )
          ) {
            const { resolveManifestCommandAliasOwner, resolveManifestToolOwner } =
              await import("../plugins/manifest-command-aliases.runtime.js");
            const cliCommandSurfaceOwner = await resolveCliCommandSurfaceOwner({
              primary,
              config,
            });
            const missingPluginCommandMessage = resolveMissingPluginCommandMessageFromPolicy(
              primary,
              config,
              {
                resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
                resolveToolOwner: resolveManifestToolOwner,
                resolveCliCommandSurfaceOwner: () => cliCommandSurfaceOwner,
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
        await startupTrace.measure("parse", () => program.parseAsync(parseArgv));
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
    if (onSigterm) {
      process.off("SIGTERM", onSigterm);
    }
    if (onSigint) {
      process.off("SIGINT", onSigint);
    }
    if (onExit) {
      process.off("exit", onExit);
    }
    await stopStartedProxy();
    await disposeCliAgentHarnesses();
    await closeCliMemoryManagers();
    pauseNonTtyStdinForCliExit();
  }
}

// lyc:ai
// 检查当前模块是否是主模块
// 用于确定是否应该直接执行 CLI 功能
export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
