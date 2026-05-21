import os from "node:os";
import path from "node:path";

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}
// lyc:aic v2026.5：helper 函数（normalizeSafe / resolveRawOsHomeDir / resolveRawHomeDir）从文件末尾搬到了 resolveEffectiveHomeDir 上方。
//         函数内部还简化了：resolveRawOsHomeDir 直接 normalize(env.HOME) ?? normalize(env.USERPROFILE) ?? normalizeSafe(homedir)；
//         resolveRawHomeDir 用 explicitHome 早退分支。

function normalizeSafe(homedir: () => string): string | undefined {
  try {
    return normalize(homedir());
  } catch {
    return undefined;
  }
}

function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  return normalize(env.HOME) ?? normalize(env.USERPROFILE) ?? normalizeSafe(homedir);
}

/* lyc: 解析原始 Home 目录路径, 从环境变量 OPENCLAW_HOME, HOME, USERPROFILE, homedir 中解析

*/
function resolveRawHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  const explicitHome = normalize(env.OPENCLAW_HOME);
  if (!explicitHome) {
    return resolveRawOsHomeDir(env, homedir);
  }
  if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
    const fallbackHome = resolveRawOsHomeDir(env, homedir);
    return fallbackHome ? explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome) : undefined;
  }
  return explicitHome;
}

// lyc: 解析有效的 rawHome 目录绝对路径, 如果 rawHome 路径不存在则返回 undefined, 注意不会验证 rawHome 路径是否存在, 只会返回 rawHome 路径的绝对路径
export function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawHomeDir(env, homedir);
  // lyc: path.resolve()不实际操作文件系统只是在路径字符上进行解析，不会验证路径是否存在, 不会解析符号链接, 返回解析后的绝对路径
  return raw ? path.resolve(raw) : undefined;
}

export function resolveOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawOsHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}
// lyc:aic v2026.5：上面这块旧的 resolveRawHomeDir/resolveRawOsHomeDir/normalizeSafe 实现搬到文件顶部并简化了，
//                  你原本的中文注释已迁移到顶部对应函数上方。

// lyc: 必须确保能解析出 Home 目录路径, 如果有效的 Home 目录 (resolveEffectiveHomeDir) 返回失败, 则返回当前工作目录 (process.cwd())
export function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  // lyc: path.resolve()不实际操作文件系统只是在路径字符上进行解析，不会验证路径是否存在, 不会解析符号链接, 返回解析后的绝对路径
  return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
}

export function resolveRequiredOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveOsHomeDir(env, homedir) ?? path.resolve(process.cwd());
}
// lyc: 替换Home目录前缀, 即如果input字符串以~或~/或~\开头, 则将其替换为Home目录路径, 如果Home目录路径不存在则 则返回原始字符串(input)

export function expandHomePrefix(
  input: string,
  opts?: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  if (!input.startsWith("~")) {
    return input;
  }
  const home =
    normalize(opts?.home) ??
    resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
  if (!home) {
    return input;
  }
  return input.replace(/^~(?=$|[\\/])/, home);
}

// lyc: 为input路径解析~目录并返回绝对路径, 
// lyc: path.resolve()不实际操作文件系统只是在路径字符上进行解析，不会验证路径是否存在, 不会解析符号链接, 返回解析后的绝对路径
export function resolveHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    // lyc: 替换~为Home目录路径
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
      env: opts?.env,
      homedir: opts?.homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

export function resolveUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveHomeRelativePath(input, { env, homedir });
}

export function resolveOsHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredOsHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
      env: opts?.env,
      homedir: opts?.homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}
