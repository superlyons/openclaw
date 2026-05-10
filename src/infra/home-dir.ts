import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "../shared/string-coerce.js";

function normalize(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}
// lyc: 解析有效的rawHome目录绝对路径, 如果rawHome路径不存在则返回undefined, 注意不会验证rawHome路径是否存在, 只会返回rawHome路径的绝对路径
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
/* lyc: 解析原始Home目录路径, 从环境变量OPENCLAW_HOME, HOME, USERPROFILE, homedir中解析
获取明确的Home地址(explicitHome)
如果设置了env.OPENCLAW_HOME
    如果env.OPENCLAW_HOME以~或~/或~\开头则必须将~替换为env.HOME或env.USERPROFILE或homedir()的路径, 并返回, 否则返回undefined
    不以~或~/或~\开头返回env.OPENCLAW_HOME
如果设置了env.HOME则返回它
如果设置了env.USERPROFILE则返回它
返回os.homedir()

可能返回的路径: 按先后顺序
env.OPENCLAW_HOME如果以~或~/或~\开头, 则~被替换为env.HOME或env.USERPROFILE或homedir()的路径, 并返回, homedir()默认为os.homedir()
env.OPENCLAW_HOME如果以~或~/或~\开头但无法替换~则返回undefined
env.OPENCLAW_HOME
env.HOME
env.USERPROFILE
homedir()默认为os.homedir
*/ 
function resolveRawHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  const explicitHome = normalize(env.OPENCLAW_HOME);
  if (explicitHome) {
    if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
      const fallbackHome = resolveRawOsHomeDir(env, homedir);
      if (fallbackHome) {
        return explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome);
      }
      return undefined;
    }
    return explicitHome;
  }

  return resolveRawOsHomeDir(env, homedir);
}

function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  const envHome = normalize(env.HOME);
  if (envHome) {
    return envHome;
  }
  const userProfile = normalize(env.USERPROFILE);
  if (userProfile) {
    return userProfile;
  }
  return normalizeSafe(homedir);
}

function normalizeSafe(homedir: () => string): string | undefined {
  try {
    return normalize(homedir());
  } catch {
    return undefined;
  }
}
// lyc: 必须确保能解析出Home目录路径, 如果有效的Home目录(resolveEffectiveHomeDir)返回失败, 则返回当前工作目录(process.cwd())
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
