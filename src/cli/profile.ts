import os from "node:os";
import path from "node:path";
import { isValueToken } from "../infra/cli-root-options.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { isValidProfileName } from "./profile-utils.js";
import { scanCliRootOptions } from "./root-option-scan.js";
import { takeCliRootOptionValue } from "./root-option-value.js";

type CliProfileParseResult =
  | { ok: true; profile: string | null; argv: string[] }
  | { ok: false; error: string };

// lyc: 主次命令是否为 qa matrix
function isCommandLocalProfileOption(out: string[]): boolean {
  const [primary, secondary] = resolveCliArgvInvocation(out).commandPath;
  return primary === "qa" && secondary === "matrix";
}
/* lyc: 解析CLI profile或dev跟选项参数, 并返回解析结果, return.argv不会包含profile(命令qa matrix例外)或dev(主命令gateway例外)参数, 如果解析解析失败, 则返回错误信息, 
*/

export function parseCliProfileArgs(argv: string[]): CliProfileParseResult {
  let profile: string | null = null;
  let sawDev = false;

  const scanned = scanCliRootOptions(argv, ({ arg, args, index, out }) => {
    if (arg === "--dev") {
      /* lyc: 
      */
      if (resolveCliArgvInvocation(out).primary === "gateway") {
        out.push(arg);
        return { kind: "handled" };
      }
      // lyc: 执行到这里代表主命令不是"gateway", --dev和--profile不能同时使用
      if (profile && profile !== "dev") {
        // lyc: --dev 不能与 --profile 结合使用
        return { kind: "error", error: "Cannot combine --dev with --profile" };
      }
      sawDev = true;
      profile = "dev";
      return { kind: "handled" };
    }

    if (arg === "--profile" || arg.startsWith("--profile=")) {
      // lyc: 主次命令是否为 qa matrix
      if (isCommandLocalProfileOption(out)) {
        out.push(arg);
        if (arg === "--profile" && isValueToken(args[index + 1])) {
          out.push(args[index + 1]);
          return { kind: "handled", consumedNext: true };
        }
        return { kind: "handled" };
      }
      if (sawDev) {
        // lyc: --profile 不能与 --dev 结合使用
        return { kind: "error", error: "Cannot combine --dev with --profile" };
      }
      const next = args[index + 1];
      const { value, consumedNext } = takeCliRootOptionValue(arg, next);
      if (!value) {
        return { kind: "error", error: "--profile requires a value" };
      }
      if (!isValidProfileName(value)) {
        return {
          kind: "error",
          // lyc: --profile 无效, 只能包含字母、数字、下划线和短横线
          error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
        };
      }
      profile = value;
      return { kind: "handled", consumedNext };
    }
    return { kind: "pass" };
  });

  if (!scanned.ok) {
    return scanned;
  }

  return { ok: true, profile, argv: scanned.argv };
}

// lyc: 解析profile状态目录路径, homeDir/.openclaw[-${profile}]
function resolveProfileStateDir(
  profile: string,
  env: Record<string, string | undefined>,
  homedir: () => string,
): string {
  const suffix = normalizeLowercaseStringOrEmpty(profile) === "default" ? "" : `-${profile}`;
  return path.join(resolveRequiredHomeDir(env as NodeJS.ProcessEnv, homedir), `.openclaw${suffix}`);
}

// lyc: 应用profile环境变量(env变量), 并根据profile值设置其他环境变量
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

  // lyc: 设置env.OPENCLAW_CONFIG_PATH环境变量, 如果不存在则 则根据stateDir设置为"homedir/.openclaw[-${profile}]/openclaw.json"
  if (!normalizeOptionalString(env.OPENCLAW_CONFIG_PATH)) {
    env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  }

  // lyc: 设置env.OPENCLAW_GATEWAY_PORT环境变量, 如果不存在 && profile为"dev"时 设置为"19001"
  if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) {
    env.OPENCLAW_GATEWAY_PORT = "19001";
  }
}
