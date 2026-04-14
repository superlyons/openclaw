import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTruthyEnvValue } from "./env.js";
import { sanitizeHostExecEnv } from "./host-env-security.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_SHELL = "/bin/sh";
let lastAppliedKeys: string[] = [];
let cachedShellPath: string | null | undefined;
let cachedEtcShells: Set<string> | null | undefined;

function resolveShellExecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const execEnv = sanitizeHostExecEnv({ baseEnv: env });

  // Startup-file resolution must stay pinned to the real user home.
  // lyc: 启动文件解析必须固定在真实用户家中
  const home = os.homedir().trim();
  if (home) {
    execEnv.HOME = home;
  } else {
    delete execEnv.HOME;
  }

  // Avoid zsh startup-file redirection via env poisoning.
  // lyc: 避免通过env中毒重定向zsh启动文件
  delete execEnv.ZDOTDIR;
  return execEnv;
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(0, timeoutMs);
}

function readEtcShells(): Set<string> | null {
  if (cachedEtcShells !== undefined) {
    return cachedEtcShells;
  }
  try {
    const raw = fs.readFileSync("/etc/shells", "utf8");
    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && path.isAbsolute(line));
    cachedEtcShells = new Set(entries);
  } catch {
    cachedEtcShells = null;
  }
  return cachedEtcShells;
}

// lyc: 检查shell路径是否可信
function isTrustedShellPath(shell: string): boolean {
  // lyc: 不是绝对路径, 不可信
  if (!path.isAbsolute(shell)) {
    return false;
  }
  // lyc: 路径归一化后与原始路径不同, 不可信
  const normalized = path.normalize(shell);
  if (normalized !== shell) {
    return false;
  }

  // Primary trust anchor: shell registered in /etc/shells.
  // lyc: 检查shell路径是否在/etc/shells中注册
  // lyc: 读取/etc/shells文件内容, 该文件列出了可信的shell路径
  const registeredShells = readEtcShells();
  // lyc: 检查shell路径是否在/etc/shells中注册
  return registeredShells?.has(shell) === true;
}

function resolveShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL?.trim();
  if (shell && isTrustedShellPath(shell)) {
    return shell;
  }
  return DEFAULT_SHELL;
}

// lyc: 在一个登录 Shell（Login Shell）环境中获取所有环境变量，并以一种方便程序解析的格式（Null 分隔）返回
function execLoginShellEnvZero(params: {
  // lyc: 要执行的 Shell 路径（例如 /bin/sh 或 /bin/bash）
  shell: string;
  env: NodeJS.ProcessEnv;
  exec: typeof execFileSync;
  timeoutMs: number;
}): Buffer {
  /* lyc:
  执行的命令类似于: /bin/sh -l -c "env -0"
  -l (Login Shell): 这告诉 Shell 以“登录模式”启动。
    作用：这会强制 Shell 加载标准的登录配置文件（如 /etc/profile, ~/.bash_profile, ~/.zprofile 等）。
    目的：很多环境变量（特别是 PATH）是在这些文件中配置的。如果不加 -l，可能无法获取到用户完整的环境配置。
  -c "env -0": 
    -c 告诉 Shell 执行完后面的字符串命令后就退出，而不是进入交互模式。
    env: 这是一个标准的 Linux 命令，用于打印当前的环境变量
    -0 (Null Separator): 
      默认情况下，env 输出的每一行用换行符分隔。但是，环境变量的值里可能包含换行符，这会导致解析错误。
      使用 -0 后，env 输出的变量之间使用 Null 字符 (\0) 分隔。这保证了无论变量内容是什么，程序都能安全、准确地把它们切分开。
  */
  return params.exec(params.shell, ["-l", "-c", "env -0"], {
    // lyc: 返回原始 Buffer 而不是字符串，因为数据中包含 \0 字符，处理 Buffer 更准确
    encoding: "buffer",
    // lyc: 超时时间（毫秒），防止命令卡死
    timeout: params.timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
    // lyc: 传递给 Shell 的初始环境变量
    env: params.env,
    // lyc: 忽略标准输入（ignore），因为不需要用户交互, 捕获标准输出（pipe）和标准错误（pipe），以便 Node.js 能读取到结果。
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// lyc: 解析shell环境变量, 并将其转换为 Map<string, string>
function parseShellEnv(stdout: Buffer): Map<string, string> {
  const shellEnv = new Map<string, string>();
  const parts = stdout.toString("utf8").split("\0");
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (!key) {
      continue;
    }
    shellEnv.set(key, value);
  }
  return shellEnv;
}

type LoginShellEnvProbeResult =
  | { ok: true; shellEnv: Map<string, string> }
  | { ok: false; error: string };

  // lyc: 探测登录Shell环境变量
function probeLoginShellEnv(params: {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  exec?: typeof execFileSync;
}): LoginShellEnvProbeResult {
  // lyc: execFileSync 是 Node.js 中 child_process 模块提供的一个‌同步执行子进程‌的方法，它会阻塞当前事件循环，直到子进程执行完毕并返回结果
  const exec = params.exec ?? execFileSync;
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  // lyc: 解析shell路径 默认为/bin/sh
  const shell = resolveShell(params.env);
  // lyc: 解析shell环境变量
  const execEnv = resolveShellExecEnv(params.env);

  try {
    // lyc: 获取shell环境变量
    const stdout = execLoginShellEnvZero({ shell, env: execEnv, exec, timeoutMs });
    return { ok: true, shellEnv: parseShellEnv(stdout) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type ShellEnvFallbackResult =
  | { ok: true; applied: string[]; skippedReason?: never }
  | { ok: true; applied: []; skippedReason: "already-has-keys" | "disabled" }
  | { ok: false; error: string; applied: [] };

export type ShellEnvFallbackOptions = {
  enabled: boolean;
  env: NodeJS.ProcessEnv;
  expectedKeys: string[];
  logger?: Pick<typeof console, "warn">;
  timeoutMs?: number;
  exec?: typeof execFileSync;
};

// lyc: 加载shell环境变量, 之后只将opts.expectedKeys指定的环境变量键追加到opts.env中, 只有env中不存在期望的环境变量键时, 才追加
export function loadShellEnvFallback(opts: ShellEnvFallbackOptions): ShellEnvFallbackResult {
  const logger = opts.logger ?? console;

  // lyc: 如果shell环境未启用，则直接返回, 跳过原因(skippedReason)是禁止
  if (!opts.enabled) {
    lastAppliedKeys = [];
    return { ok: true, applied: [], skippedReason: "disabled" };
  }

  // lyc: env中存在expectedKeys中任何一个键时,直接返回, 跳过原因(skippedReason)是已经存在期望的环境变量键
  const hasAnyKey = opts.expectedKeys.some((key) => Boolean(opts.env[key]?.trim()));
  if (hasAnyKey) {
    lastAppliedKeys = [];
    return { ok: true, applied: [], skippedReason: "already-has-keys" };
  }

  // lyc: 获取shell环境变量
  const probe = probeLoginShellEnv({
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    exec: opts.exec,
  });
  if (!probe.ok) {
    logger.warn(`[openclaw] shell env fallback failed: ${probe.error}`);
    lastAppliedKeys = [];
    return { ok: false, error: probe.error, applied: [] };
  }

  const applied: string[] = [];
  for (const key of opts.expectedKeys) {
    // lyc: 如果env中存在期望的环境变量键, 则跳过
    if (opts.env[key]?.trim()) {
      continue;
    }
    const value = probe.shellEnv.get(key);
    if (!value?.trim()) {
      continue;
    }
    opts.env[key] = value;
    // lyc: 记录已应用的期望变量键
    applied.push(key);
  }

  lastAppliedKeys = applied;
  return { ok: true, applied };
}

export function shouldEnableShellEnvFallback(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env.OPENCLAW_LOAD_SHELL_ENV);
}

export function shouldDeferShellEnvFallback(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env.OPENCLAW_DEFER_SHELL_ENV_FALLBACK);
}

// lyc: 解析shell环境回退超时时间, Ms代表毫秒级
export function resolveShellEnvFallbackTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_SHELL_ENV_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(0, parsed);
}

export function getShellPathFromLoginShell(opts: {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  exec?: typeof execFileSync;
  platform?: NodeJS.Platform;
}): string | null {
  if (cachedShellPath !== undefined) {
    return cachedShellPath;
  }
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    cachedShellPath = null;
    return cachedShellPath;
  }

  const probe = probeLoginShellEnv({
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    exec: opts.exec,
  });
  if (!probe.ok) {
    cachedShellPath = null;
    return cachedShellPath;
  }

  const shellPath = probe.shellEnv.get("PATH")?.trim();
  cachedShellPath = shellPath && shellPath.length > 0 ? shellPath : null;
  return cachedShellPath;
}

export function resetShellPathCacheForTests(): void {
  cachedShellPath = undefined;
  cachedEtcShells = undefined;
}

export function getShellEnvAppliedKeys(): string[] {
  return [...lastAppliedKeys];
}
