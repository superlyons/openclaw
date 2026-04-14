import type { Command } from "commander";
import { setVerbose } from "../../globals.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import type { LogLevel } from "../../logging/levels.js";
import { defaultRuntime } from "../../runtime.js";
import {
  getCommandPathWithRootOptions,
  getVerboseFlag,
  hasFlag,
  hasHelpOrVersion,
} from "../argv.js";
import { emitCliBanner } from "../banner.js";
import { resolveCliName } from "../cli-name.js";

// lyc: 设置进程标题为命令名称 openclaw-命令名称, 方便在任务管理器中识别
function setProcessTitleForCommand(actionCommand: Command) {
  let current: Command = actionCommand;
  while (current.parent && current.parent.parent) {
    current = current.parent;
  }
  const name = current.name();
  const cliName = resolveCliName();
  if (!name || name === cliName) {
    return;
  }
  process.title = `${cliName}-${name}`;
}

// Commands that need channel plugins loaded
const PLUGIN_REQUIRED_COMMANDS = new Set([
  "message",
  "channels",
  "directory",
  "agents",
  "configure",
  "onboard",
]);
const CONFIG_GUARD_BYPASS_COMMANDS = new Set(["doctor", "completion", "secrets"]);
const JSON_PARSE_ONLY_COMMANDS = new Set(["config set"]);
let configGuardModulePromise: Promise<typeof import("./config-guard.js")> | undefined;
let pluginRegistryModulePromise: Promise<typeof import("../plugin-registry.js")> | undefined;

function shouldBypassConfigGuard(commandPath: string[]): boolean {
  const [primary, secondary] = commandPath;
  if (!primary) {
    return false;
  }
  if (CONFIG_GUARD_BYPASS_COMMANDS.has(primary)) {
    return true;
  }
  // config validate is the explicit validation command; let it render
  // validation failures directly without preflight guard output duplication.
  if (primary === "config" && secondary === "validate") {
    return true;
  }
  return false;
}

function loadConfigGuardModule() {
  /* lyc:
  空值合并赋值运算符 (??=) 来实现单例模式的懒加载
  作用: 确保 configGuardModulePromise 只会被初始化一次，避免重复加载。
  configGuardModulePromise 未定义时为 undefined，会执行 import("./config-guard.js") 并赋值给它, 否则保持原值
  */
  configGuardModulePromise ??= import("./config-guard.js");
  // 返回这个Promise
  return configGuardModulePromise;
}

function loadPluginRegistryModule() {
  pluginRegistryModulePromise ??= import("../plugin-registry.js");
  return pluginRegistryModulePromise;
}

function getRootCommand(command: Command): Command {
  let current = command;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

function getCliLogLevel(actionCommand: Command): LogLevel | undefined {
  const root = getRootCommand(actionCommand);
  if (typeof root.getOptionValueSource !== "function") {
    return undefined;
  }
  if (root.getOptionValueSource("logLevel") !== "cli") {
    return undefined;
  }
  const logLevel = root.opts<Record<string, unknown>>().logLevel;
  return typeof logLevel === "string" ? (logLevel as LogLevel) : undefined;
}

// lyc: 判断是否开启了 JSON 输出模式
// lyc: 作用: 用于在命令行中指定输出格式为 JSON，而不是默认的文本格式。
// lyc: 例如: openclaw --json message
// lyc: 但不包含 config set 命令, 因为 config set 命令的输出格式是 JSON，而不是 text
function isJsonOutputMode(commandPath: string[], argv: string[]): boolean {
  if (!hasFlag(argv, "--json")) {
    return false;
  }
  const key = `${commandPath[0] ?? ""} ${commandPath[1] ?? ""}`.trim();
  if (JSON_PARSE_ONLY_COMMANDS.has(key)) {
    return false;
  }
  return true;
}
/* lyc: 全局前置守卫（Global Pre-Action Guard）函数
 * 负责处理所有命令启动前的环境初始化、权限检查和状态准备。
当你在终端输入 openclaw gateway --verbose 时，这个钩子按顺序做了以下事情：
  改名：把进程名改成 openclaw-gateway。
  拦截：检查是不是只要帮助？不是，继续。
  展示：打印 OpenClaw 的 Logo 横幅。
  环境：开启详细日志模式，屏蔽 Node 原生警告。
  体检：检查配置文件是否齐全（Config Guard）。
  备料：发现 gateway 需要插件，于是加载插件系统。
  放行：钩子执行完毕，控制权交给 gateway 命令的具体业务逻辑。
 */
export function registerPreActionHooks(program: Command, programVersion: string) {
  // lyc: .hook('preAction', ...)注册一个全局钩子, preAction允许在任何具体命令的业务逻辑执行之前，先运行一段通用代码
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    // lyc: 设置进程标题为命令名称 openclaw-命令名称, 方便在任务管理器中识别
    setProcessTitleForCommand(actionCommand);
    const argv = process.argv;
    // lyc: 如果命令行参数包含帮助标志、版本标志或根版本别名(-v), 则直接返回, 不执行后续代码
    if (hasHelpOrVersion(argv)) {
      return;
    }
    // lyc: 获取命令路径, 2代表返回的path最长为3个参数, 例如: ["gateway", "restart"], ["plugins", "update", "now"]
    const commandPath = getCommandPathWithRootOptions(argv, 2);\
    // lyc: 决定是否显示 OpenClaw 的 Logo 横幅
    const hideBanner =
      isTruthyEnvValue(process.env.OPENCLAW_HIDE_BANNER) ||
      commandPath[0] === "update" ||
      commandPath[0] === "completion" ||
      (commandPath[0] === "plugins" && commandPath[1] === "update");
    if (!hideBanner) {
      // lyc: 如果不隐藏横幅, 则显示 OpenClaw 的 Logo 横幅和版本信息
      emitCliBanner(programVersion);
    }
    // lyc: 是否开启了--verbose(详细模式)和--debug(调试模式)
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    setVerbose(verbose);
    // lyc: 获取命令的 --logLevel 配置
    const cliLogLevel = getCliLogLevel(actionCommand);
    // lyc: 将日志级别注入到环境变量中，这样后续加载的模块都能读取到这个配置。
    if (cliLogLevel) {
      process.env.OPENCLAW_LOG_LEVEL = cliLogLevel;
    }
    // lyc: 如果用户没有开启详细模式，强制设置 NODE_NO_WARNINGS=1; \
    // lyc: 作用: 屏蔽 Node.js 原生的警告（比如“这个 API 即将弃用”），保持输出界面的整洁，只显示应用层面的关键信息。
    if (!verbose) {
      process.env.NODE_NO_WARNINGS ??= "1";
    }
    // lyc: 如果命令路径是以 doctor、completion 或 secrets 开头 或是 config validate, 则直接返回, 不执行后续代码
    // lyc: 作用: 这些命令的配置文件需要在运行时加载，不能在启动时加载，否则会导致配置文件加载失败
    if (shouldBypassConfigGuard(commandPath)) {
      return;
    }
    // lyc:  如果当前命令要求输出 JSON（例如 --json 参数），那么配置检查器的输出也必须被压制，防止破坏 JSON 格式的纯净性。
    const suppressDoctorStdout = isJsonOutputMode(commandPath, argv);
    // lyc: 这是配置检查器。它会检查用户是否已经初始化？配置文件是否存在？API Key 是否配置？如果配置缺失，它会阻止命令执行，并提示用户去修复配置
    const { ensureConfigReady } = await loadConfigGuardModule();
    await ensureConfigReady({
      runtime: defaultRuntime,
      commandPath,
      ...(suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
    });
    // Load plugins for commands that need channel access
    /* lyc: 检查当前运行的命令是否需要插件支持（例如 message 或 channel 相关的命令）
     * 如果命令路径以 message、channels、directory、agents、configure 或 onboard 开头, 则加载插件注册模块
     * 作用: 这些命令需要加载插件才能正常运行
     */
    if (PLUGIN_REQUIRED_COMMANDS.has(commandPath[0])) {
      const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
      // lyc: 确保插件注册模块已加载
      ensurePluginRegistryLoaded();
    }
  });
}
