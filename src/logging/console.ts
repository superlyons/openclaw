import util from "node:util";
import type { OpenClawConfig } from "../config/types.js";
import { isVerbose } from "../global-state.js";
import { stripAnsi } from "../terminal/ansi.js";
import { readLoggingConfig, shouldSkipMutatingLoggingConfigRead } from "./config.js";
import { resolveEnvLogLevelOverride } from "./env-log-level.js";
import { type LogLevel, normalizeLogLevel } from "./levels.js";
import { getLogger } from "./logger.js";
import { redactSensitiveText } from "./redact.js";
import { loggingState } from "./state.js";
import { formatLocalIsoWithOffset, formatTimestamp } from "./timestamps.js";
import type { ConsoleStyle, LoggerSettings } from "./types.js";

export type { ConsoleStyle } from "./types.js";
type ConsoleSettings = {
  level: LogLevel;
  style: ConsoleStyle;
};
export type ConsoleLoggerSettings = ConsoleSettings;

type ConsoleConfigLoader = () => OpenClawConfig["logging"] | undefined;
const loadConfigFallbackDefault: ConsoleConfigLoader = () => undefined;
let loadConfigFallback: ConsoleConfigLoader = loadConfigFallbackDefault;

export function setConsoleConfigLoaderForTests(loader?: ConsoleConfigLoader): void {
  loadConfigFallback = loader ?? loadConfigFallbackDefault;
}

function normalizeConsoleLevel(level?: string): LogLevel {
  if (isVerbose()) {
    return "debug";
  }
  if (!level && process.env.VITEST === "true" && process.env.OPENCLAW_TEST_CONSOLE !== "1") {
    return "silent";
  }
  return normalizeLogLevel(level, "info");
}

function normalizeConsoleStyle(style?: string): ConsoleStyle {
  if (style === "compact" || style === "json" || style === "pretty") {
    return style;
  }
  if (!process.stdout.isTTY) {
    return "compact";
  }
  return "pretty";
}

function resolveConsoleSettings(): ConsoleSettings {
  const envLevel = resolveEnvLogLevelOverride();
  // Test runs default to silent console logging unless explicitly overridden.
  // Skip config-file and full config fallback reads in this fast path.
  if (
    process.env.VITEST === "true" &&
    process.env.OPENCLAW_TEST_CONSOLE !== "1" &&
    !isVerbose() &&
    !envLevel &&
    !loggingState.overrideSettings
  ) {
    return { level: "silent", style: normalizeConsoleStyle(undefined) };
  }

  let cfg: OpenClawConfig["logging"] | undefined =
    (loggingState.overrideSettings as LoggerSettings | null) ?? readLoggingConfig();
  if (!cfg && !shouldSkipMutatingLoggingConfigRead()) {
    if (loggingState.resolvingConsoleSettings) {
      cfg = undefined;
    } else {
      loggingState.resolvingConsoleSettings = true;
      try {
        cfg = loadConfigFallback();
      } finally {
        loggingState.resolvingConsoleSettings = false;
      }
    }
  }
  const level = envLevel ?? normalizeConsoleLevel(cfg?.consoleLevel);
  const style = normalizeConsoleStyle(cfg?.consoleStyle);
  return { level, style };
}

function consoleSettingsChanged(a: ConsoleSettings | null, b: ConsoleSettings) {
  if (!a) {
    return true;
  }
  return a.level !== b.level || a.style !== b.style;
}

export function getConsoleSettings(): ConsoleLoggerSettings {
  const settings = resolveConsoleSettings();
  const cached = loggingState.cachedConsoleSettings as ConsoleSettings | null;
  if (!cached || consoleSettingsChanged(cached, settings)) {
    loggingState.cachedConsoleSettings = settings;
  }
  return loggingState.cachedConsoleSettings as ConsoleSettings;
}

export function getResolvedConsoleSettings(): ConsoleLoggerSettings {
  return getConsoleSettings();
}

// Route all console output (including tslog console writes) to stderr.
// This keeps stdout clean for RPC/JSON modes.
// lyc: 将所有控制台输出（包括tslog控制台写入）重定向到标准错误输出（stderr）。
// lyc: 这使得在RPC/JSON模式下，stdout（标准输出）保持干净。
export function routeLogsToStderr(): void {
  loggingState.forceConsoleToStderr = true;
}

export function setConsoleSubsystemFilter(filters?: string[] | null): void {
  if (!filters || filters.length === 0) {
    loggingState.consoleSubsystemFilter = null;
    return;
  }
  const normalized = filters.map((value) => value.trim()).filter((value) => value.length > 0);
  loggingState.consoleSubsystemFilter = normalized.length > 0 ? normalized : null;
}

export function setConsoleTimestampPrefix(enabled: boolean): void {
  loggingState.consoleTimestampPrefix = enabled;
}

function normalizeConsoleSubsystem(subsystem?: string | null): string | null {
  if (typeof subsystem !== "string") {
    return null;
  }
  const normalized = subsystem.trim();
  return normalized.length > 0 ? normalized : null;
}

export function shouldLogSubsystemToConsole(subsystem?: string | null): boolean {
  const filter = loggingState.consoleSubsystemFilter;
  if (!filter || filter.length === 0) {
    return true;
  }
  const normalizedSubsystem = normalizeConsoleSubsystem(subsystem);
  if (!normalizedSubsystem) {
    return false;
  }
  return filter.some(
    (prefix) => normalizedSubsystem === prefix || normalizedSubsystem.startsWith(`${prefix}/`),
  );
}

const SUPPRESSED_CONSOLE_PREFIXES = [
  "Closing session:",
  "Opening session:",
  "Removing old closed session:",
  "Session already closed",
  "Session already open",
] as const;

// lyc: 判断是否应该抑制控制台消息; 用于过滤掉一些常见的控制台消息，如会话关闭、打开、移除旧会话等
function shouldSuppressConsoleMessage(message: string): boolean {
  if (SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return true;
  }
  if (isVerbose()) {
    return false;
  }
  return false;
}

function isEpipeError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPIPE" || code === "EIO";
}

export function formatConsoleTimestamp(style: ConsoleStyle): string {
  const now = new Date();
  if (style === "pretty") {
    return formatTimestamp(now, { style: "short" }).replace(/[+-]\d{2}:\d{2}$/, "");
  }
  return formatLocalIsoWithOffset(now);
}

function hasTimestampPrefix(value: string): boolean {
  return /^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.test(
    value,
  );
}

/**
 * Route console.* calls through file logging while still emitting to stdout/stderr.
 * This keeps user-facing output unchanged but guarantees every console call is captured in log files.
 */
/* lyc:
*/
/* lyc:
    // 流可以触发事件
    // 保存原始函数
    // 重写为增强版本
      // 添加自定义逻辑
      // 调用原始函数
      // 这里返回的函数会替换 console 方法
*/
export function enableConsoleCapture(): void {
  // lyc: console是否已被补丁|修补, 如果已被修补则直接返回
  if (loggingState.consolePatched) {
    return;
  }
  // lyc: 防止enableConsoleCapture重复执行
  loggingState.consolePatched = true;

  // Handle async EPIPE errors on stdout/stderr. The synchronous try/catch in
  // the forward() wrapper below only covers errors thrown during write dispatch.
  // When the receiving pipe closes (e.g. during shutdown), Node emits the error
  // asynchronously on the stream. Without a listener this becomes an uncaught
  // exception that crashes the gateway.
  // Guard separately from consolePatched so test resets don't stack listeners.
  /* lyc:
  */
  /* lyc: 处理 EPIPE 错误
  */
  if (!loggingState.streamErrorHandlersInstalled) {
    // lyc: 防止重复执行
    loggingState.streamErrorHandlersInstalled = true;
    /* lyc:
    */
    for (const stream of [process.stdout, process.stderr]) {
      stream.on("error", (err) => {
        if (isEpipeError(err)) {
          // lyc: EPIPE 错误静默忽略
          return;
        }
        // lyc: 其他错误抛出
        throw err;
      });
    }
  }

  /* lyc: 懒加载 Logger
  */
  let logger: ReturnType<typeof getLogger> | null = null;
  const getLoggerLazy = () => {
    if (!logger) {
      logger = getLogger();
    }
    return logger;
  };
  
  // lyc: 保存原始方法; 保存原始的控制台方法(original)，供后续调用

  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
  };
  // lyc: 同时保存到全局状态(loggingState.rawConsole)，供其他模块使用（如需要绕过拦截时）
  loggingState.rawConsole = {
    log: original.log,
    info: original.info,
    warn: original.warn,
    error: original.error,
  };

  /* lyc: 核心转发函数, 是一个高阶函数-闭包
  */  
  const forward =
    (level: LogLevel, orig: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      /* lyc: 格式化参数
      */
      const formatted = util.format(...args);
      // lyc: 检查格式化后的消息是否需要静默忽略
      if (shouldSuppressConsoleMessage(formatted)) {
        return;
      }
      /* lyc: 移除 ANSI 转义序列
      */
      const trimmed = stripAnsi(formatted).trimStart();
      /* lyc: 检查是否需要添加时间戳
      */
      const shouldPrefixTimestamp =
        loggingState.consoleTimestampPrefix && trimmed.length > 0 && !hasTimestampPrefix(trimmed);
      const timestamp = shouldPrefixTimestamp
        ? formatConsoleTimestamp(getConsoleSettings().style)
        : "";
      // lyc: 调用 Logger 方法写入日志文件
      try {
        const resolvedLogger = getLoggerLazy();
        // Map console levels to file logger
        if (level === "trace") {
          resolvedLogger.trace(formatted);
        } else if (level === "debug") {
          resolvedLogger.debug(formatted);
        } else if (level === "info") {
          resolvedLogger.info(formatted);
        } else if (level === "warn") {
          resolvedLogger.warn(formatted);
        } else if (level === "error" || level === "fatal") {
          resolvedLogger.error(formatted);
        } else {
          resolvedLogger.info(formatted);
        }
      } catch {
        // never block console output on logging failures
        // lyc: 日志失败时静默，不阻塞控制台输出
      }
      /* lyc: 强制将日志写入 stderr
      */
      if (loggingState.forceConsoleToStderr) {
        // In --json mode, all console.* writes are diagnostics and should stay off stdout.
        try {
          const redacted = redactSensitiveText(formatted);
          const line = timestamp ? `${timestamp} ${redacted}` : redacted;
          process.stderr.write(`${line}\n`);
        } catch (err) {
          if (isEpipeError(err)) {
            return;
          }
          throw err;
        }
      } else {
        /* lyc: 正常模式：输出到原始控制台
        */
        try {
          const redacted = redactSensitiveText(formatted);
          if (!timestamp) {
            if (args.length === 0) {
              orig.apply(console, args as []);
              return;
            }
            orig.call(console, redacted);
            return;
          }
          orig.call(console, redacted ? `${timestamp} ${redacted}` : timestamp);
        } catch (err) {
          if (isEpipeError(err)) {
            return;
          }
          throw err;
        }
      }
    };
  // lyc: 替换 console 方法

  console.log = forward("info", original.log);
  console.info = forward("info", original.info);
  console.warn = forward("warn", original.warn);
  console.error = forward("error", original.error);
  console.debug = forward("debug", original.debug);
  console.trace = forward("trace", original.trace);
}
