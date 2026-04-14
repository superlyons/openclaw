import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { isValidProfileName } from "./profile-utils.js";

export type CliProfileParseResult =
  | { ok: true; profile: string | null; argv: string[] }
  | { ok: false; error: string };

function takeValue(
  raw: string,
  next: string | undefined,
): {
  value: string | null;
  consumedNext: boolean;
} {
  if (raw.includes("=")) {
    const [, value] = raw.split("=", 2);
    const trimmed = (value ?? "").trim();
    return { value: trimmed || null, consumedNext: false };
  }
  const trimmed = (next ?? "").trim();
  return { value: trimmed || null, consumedNext: Boolean(next) };
}

/* lyc: 解析CLI Profile配置参数 
  - 解析命令行参数, 提取Profile名称(存入return.profile)和命令参数(存入return.argv)以及是否成功解析(return.ok)
  - 处理--dev标志, 不能与--profile标志结合使用
  - 处理--profile标志, 不能与--dev标志结合使用
  - argv中除了dev和profile标志及命令参数, 其他参数都作为命令参数处理放入out数组
*/
export function parseCliProfileArgs(argv: string[]): CliProfileParseResult {
  if (argv.length < 2) {
    return { ok: true, profile: null, argv };
  }

  const out: string[] = argv.slice(0, 2);
  let profile: string | null = null;
  let sawDev = false;
  let sawCommand = false;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }

    if (sawCommand) {
      out.push(arg);
      continue;
    }

    if (arg === "--dev") {
      if (profile && profile !== "dev") {
        // lyc: 不能将 --dev 与 --profile 结合使用 应该是 --profile debug 或 --dev
        return { ok: false, error: "Cannot combine --dev with --profile" };
      }
      sawDev = true;
      profile = "dev";
      continue;
    }

    if (arg === "--profile" || arg.startsWith("--profile=")) {
      // lyc: 之前已指定了--dev标志, 不能与--profile标志结合使用
      if (sawDev) {
        return { ok: false, error: "Cannot combine --dev with --profile" };
      }
      const next = args[i + 1];
      const { value, consumedNext } = takeValue(arg, next);
      if (consumedNext) {
        i += 1;
      }
      if (!value) {
        return { ok: false, error: "--profile requires a value" };
      }
      if (!isValidProfileName(value)) {
        return {
          ok: false,
          error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
        };
      }
      profile = value;
      continue;
    }

    if (!arg.startsWith("-")) {
      sawCommand = true;
      out.push(arg);
      continue;
    }

    out.push(arg);
  }

  return { ok: true, profile, argv: out };
}
// lyc: 解析Profile状态目录路径, 注意Profile名称为default时, 状态目录为~/.openclaw, 否则为~/.openclaw-${profile}
function resolveProfileStateDir(
  profile: string,
  env: Record<string, string | undefined>,
  homedir: () => string,
): string {
  const suffix = profile.toLowerCase() === "default" ? "" : `-${profile}`;
  return path.join(resolveRequiredHomeDir(env as NodeJS.ProcessEnv, homedir), `.openclaw${suffix}`);
}

/* lyc: 应用CLI Profile配置的环境变量
  - 设置OPENCLAW_PROFILE环境变量为Profile名称
  - 设置OPENCLAW_STATE_DIR环境变量为Profile状态目录
  - 设置OPENCLAW_CONFIG_PATH环境变量为Profile配置文件路径
  - 如果Profile为dev, 则设置OPENCLAW_GATEWAY_PORT环境变量为19001
*/
export function applyCliProfileEnv(params: {
  profile: string;
  env?: Record<string, string | undefined>;
  homedir?: () => string;
}) {
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  // lyc: os.homedir()返回当前用户的主目录路径
  const homedir = params.homedir ?? os.homedir;
  const profile = params.profile.trim();
  if (!profile) {
    return;
  }

  // Convenience only: fill defaults, never override explicit env values.
  env.OPENCLAW_PROFILE = profile;
  // lyc: 从环境变量env.OPENCLAW_HOME, env.HOME, env.USERPROFILE, homedir函数或当前目录(process.cwd())中解析Profile状态目录(.openclaw-${profile})的路径
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || resolveProfileStateDir(profile, env, homedir);
  if (!env.OPENCLAW_STATE_DIR?.trim()) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }

  if (!env.OPENCLAW_CONFIG_PATH?.trim()) {
    env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  }

  if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) {
    env.OPENCLAW_GATEWAY_PORT = "19001";
  }
}
