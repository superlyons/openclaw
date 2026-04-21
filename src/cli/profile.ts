import os from "node:os";
import path from "node:path";
import { FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { isValidProfileName } from "./profile-utils.js";
import { forwardConsumedCliRootOption } from "./root-option-forward.js";
import { takeCliRootOptionValue } from "./root-option-value.js";

export type CliProfileParseResult =
  | { ok: true; profile: string | null; argv: string[] }
  | { ok: false; error: string };

/* lyc: 解析CLI profile或dev跟选项参数, 并返回解析结果
如果解析失败, 则返回错误信息
profile或dev跟选项参数默认互斥, 只有当主命令是"gateway"时, --dev 和 --profile 可以结合使用, 
    这种情况下本函数返回的profile的值为--profile选项的值, 同时返回的argv中会包含--dev参数
*/
export function parseCliProfileArgs(argv: string[]): CliProfileParseResult {
  if (argv.length < 2) {
    return { ok: true, profile: null, argv };
  }

  // lyc: out直接等于argv的前两个参数, 例如: ["node", "openclaw", "run", "dev", "--profile", "1000"] -> ["node", "openclaw"]
  const out: string[] = argv.slice(0, 2);
  let profile: string | null = null;
  let sawDev = false;

  // lyc: 遍历argv的剩余参数, 例如: ["node", "openclaw", "run", "dev", "--profile", "1000"] -> ["run", "dev", "--profile", "1000"]
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === FLAG_TERMINATOR) {
      out.push(arg, ...args.slice(i + 1));
      break;
    }

    if (arg === "--dev") {
      // lyc: ["node", "openclaw", "gateway", "--dev", "--profile", "/path/f.json"]
      // lyc: 当前参数arg为--dev时, 主命令为"gateway", 则将--dev添加到out数组中, continue继续处理下一个参数
      /* lyc: 注意: 只有当主命令是"gateway"时, --dev 和 --profile 可以结合使用, 
              但本函数返回的profile的值为--profile选项的值, 同时返回的argv中会包含--dev参数
          */
      if (resolveCliArgvInvocation(out).primary === "gateway") {
        out.push(arg);
        continue;
      }
      // lyc: 执行到这里代表主命令不是"gateway", --dev和--profile不能同时使用
      if (profile && profile !== "dev") {
        // lyc: --dev 不能与 --profile 结合使用
        return { ok: false, error: "Cannot combine --dev with --profile" };
      }
      sawDev = true;
      profile = "dev";
      continue;
    }

    if (arg === "--profile" || arg.startsWith("--profile=")) {
      if (sawDev) {
        // lyc: --profile 不能与 --dev 结合使用
        return { ok: false, error: "Cannot combine --dev with --profile" };
      }
      const next = args[i + 1];
      const { value, consumedNext } = takeCliRootOptionValue(arg, next);
      if (consumedNext) {
        i += 1;
      }
      if (!value) {
        return { ok: false, error: "--profile requires a value" };
      }
      if (!isValidProfileName(value)) {
        return {
          ok: false,
          // lyc: --profile 无效, 只能包含字母、数字、下划线和短横线
          error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
        };
      }
      profile = value;
      continue;
    }

    // lyc: 处理其他根选项, 并将参数添加到out数组中
    const consumedRootOption = forwardConsumedCliRootOption(args, i, out);
    if (consumedRootOption > 0) {
      i += consumedRootOption - 1;
      continue;
    }

    // lyc: 其他参数直接添加到out数组中
    out.push(arg);
  }

  return { ok: true, profile, argv: out };
}

function resolveProfileStateDir(
  profile: string,
  env: Record<string, string | undefined>,
  homedir: () => string,
): string {
  const suffix = normalizeLowercaseStringOrEmpty(profile) === "default" ? "" : `-${profile}`;
  return path.join(resolveRequiredHomeDir(env as NodeJS.ProcessEnv, homedir), `.openclaw${suffix}`);
}

// lyc: 应用profile环境变量, 并根据profile值设置其他环境变量
export function applyCliProfileEnv(params: {
  profile: string;
  env?: Record<string, string | undefined>;
  homedir?: () => string;
}) {
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  const homedir = params.homedir ?? os.homedir;
  const profile = params.profile.trim();
  if (!profile) {
    return;
  }

  // Convenience only: fill defaults, never override explicit env values.
  // lyc: 仅用于方便, 不会覆盖显式设置的环境变量值
  env.OPENCLAW_PROFILE = profile;

  // lyc: 设置OPENCLAW_STATE_DIR环境变量, 如果不存在则 则根据profile值设置为"homedir/.openclaw[-${profile}]"
  const existingStateDir = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
  const stateDir = existingStateDir || resolveProfileStateDir(profile, env, homedir);
  if (!existingStateDir) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }

  // lyc: 设置OPENCLAW_CONFIG_PATH环境变量, 如果不存在则 则根据stateDir设置为"homedir/.openclaw[-${profile}]/openclaw.json"
  if (!normalizeOptionalString(env.OPENCLAW_CONFIG_PATH)) {
    env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  }

  // lyc: 设置OPENCLAW_GATEWAY_PORT环境变量, 如果不存在 && profile为"dev"时 设置为"19001"
  if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) {
    env.OPENCLAW_GATEWAY_PORT = "19001";
  }
}
