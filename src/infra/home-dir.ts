import os from "node:os";
import path from "node:path";

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// lyc: 解析有效的rawHome目录绝对路径, 如果rawHome路径不存在则返回undefined, 注意不会验证rawHome路径是否存在, 只会返回rawHome路径的绝对路径
export function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawHomeDir(env, homedir);
  // lyc: 注意path.resolve不会检查raw代表的路径是否存在
  return raw ? path.resolve(raw) : undefined;
}

/* lyc: 解析原始Home目录路径, 从环境变量OPENCLAW_HOME, HOME, USERPROFILE, homedir中解析
获取明确的explicitHome地址
从explicitHome=env.OPENCLAW_HOME获取
    如果env.OPENCLAW_HOME以~或~/或~\开头
         获得备用的fallbackHome地址: env.HOME 或 env.USERPROFILE 或 os.homedir()
         fallbackHome成功获得返回explicitHome并且explicitHome以~或~/或~\开头, 则~被替换为fallbackHome并返回
         fallbackHome不成功返回undefined
    不以~或~/或~\开头返回explicitHome
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
      const fallbackHome =
        normalize(env.HOME) ?? normalize(env.USERPROFILE) ?? normalizeSafe(homedir);
      if (fallbackHome) {
        // lyc: explicitHome以~或~/或~\开头, 则~被替换为fallbackHome
        return explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome);
      }
      return undefined;
    }
    return explicitHome;
  }

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

// lyc: 必须确保能解析出Home目录路径, 如果有效的Home目录(resolveEffectiveHomeDir)返回失败, 则返回当前目录(process.cwd())
export function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
}

// lyc: 替换Home目录前缀, 即如果input字符串以~或~/或~\开头, 则将其替换为Home目录路径
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
