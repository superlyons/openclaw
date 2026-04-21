import { isBunRuntime, isNodeRuntime } from "../daemon/runtime-binary.js";
import {
  consumeRootOptionToken,
  FLAG_TERMINATOR,
  isValueToken,
} from "../infra/cli-root-options.js";

const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-V", "--version"]);
const ROOT_VERSION_ALIAS_FLAG = "-v";
// lyc: 判断命令行参数是否包含帮助标志、版本标志或根版本别名(-v)
export function hasHelpOrVersion(argv: string[]): boolean {
  return (
    argv.some((arg) => HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg)) || hasRootVersionAlias(argv)
  );
}

function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export function hasFlag(argv: string[], name: string): boolean {
  const args = argv.slice(2);
  for (const arg of args) {
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (arg === name) {
      return true;
    }
  }
  return false;
}

/* lyc: 
  判断命令行参数是否包含根版本别名(-v)
  true:  node app.js -v build
  true:  node app.js --profile test -v
  false: node app.js -- -v
  false: node app.js build -v
  */
export function hasRootVersionAlias(argv: string[]): boolean {
  // lyc: 忽略 node 路径和脚本路径
  const args = argv.slice(2);
  let hasAlias = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    // lyc: 遇到参数终止符 "--" 就停止解析, "--"代表之后的参数不再解析选项
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    // lyc: 找到根版本别名(-v)
    if (arg === ROOT_VERSION_ALIAS_FLAG) { 
      hasAlias = true;
      continue;
    }
    // lyc: 尝试消费(略过)根选项（如 --profile, --log-level 等）
    const consumed = consumeRootOptionToken(args, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    // lyc: 遇到其他选项("-"或"--"开头) 但未找到 -v，继续搜索
    if (arg.startsWith("-")) {
      continue;
    }
    // lyc: 遇到第一个非选项参数（如文件名(file.txt)、命令(build)等）且还没找到 -v 或 终止符 "--"，返回 false
    return false;
  }
  return hasAlias;
}

export function isRootVersionInvocation(argv: string[]): boolean {
  return isRootInvocationForFlags(argv, VERSION_FLAGS, { includeVersionAlias: true });
}

/* lyc: 
检参数是否是targetFlags中指定的针对跟程序的选项, 并且不能包含子命令选项和非根选项(RootOptions)
  targetFlags={"-h", "--help", "-V", "--version"}
  options={includeVersionAlias: true} 代表targetFlags添加了根版本别名(-v)
以下返回true, 参数-h是跟程序app.js的选项
node app.js --profile -h
node app.js -h --profile
以下返回false, 因为有子命令(command1), 
node app.js command1 -h // 参数-h是command1的选项, 不是跟程序app.js的选项
node app.js -h command1 // 参数-h是跟程序app.js的选项, 但存在了不允许的子命令选项
以下返回false, 因为有非根选项(RootOptions), 
node app.js -h --param1 // 参数-h是跟程序app.js的选项, 但存在了不允许的根选项(RootOptions)
node app.js --param1 -h // 存在了不允许的根选项(RootOptions)
*/
function isRootInvocationForFlags(
  argv: string[],
  targetFlags: Set<string>,
  options?: { includeVersionAlias?: boolean },
): boolean {
  const args = argv.slice(2);
  let hasTarget = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (
      targetFlags.has(arg) ||
      (options?.includeVersionAlias === true && arg === ROOT_VERSION_ALIAS_FLAG)
    ) {
      hasTarget = true;
      continue;
    }
    const consumed = consumeRootOptionToken(args, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    // Unknown flags and subcommand-scoped help/version should fall back to Commander.
    // lyc: 未知选项和子命令范围的 帮助/版本选项 应该回退到 Commander。
    // lyc: arg不是"--", 目标选项(targetFlags), 不是根选项(RootOptions), 则返回false
    return false;
  }
  return hasTarget;
}

export function isRootHelpInvocation(argv: string[]): boolean {
  return isRootInvocationForFlags(argv, HELP_FLAGS);
}

export function getFlagValue(argv: string[], name: string): string | null | undefined {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (arg === name) {
      const next = args[i + 1];
      return isValueToken(next) ? next : null;
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1);
      return value ? value : null;
    }
  }
  return undefined;
}

export function getVerboseFlag(argv: string[], options?: { includeDebug?: boolean }): boolean {
  if (hasFlag(argv, "--verbose")) {
    return true;
  }
  if (options?.includeDebug && hasFlag(argv, "--debug")) {
    return true;
  }
  return false;
}

export function getPositiveIntFlagValue(argv: string[], name: string): number | null | undefined {
  const raw = getFlagValue(argv, name);
  if (raw === null || raw === undefined) {
    return raw;
  }
  return parsePositiveInt(raw);
}

export function getCommandPath(argv: string[], depth = 2): string[] {
  return getCommandPathInternal(argv, depth, { skipRootOptions: false });
}

export function getCommandPathWithRootOptions(argv: string[], depth = 2): string[] {
  return getCommandPathInternal(argv, depth, { skipRootOptions: true });
}

/* lyc:
  获取命令(argv)中的路径
  depth: 路径深度, 2代表返回的path最长为2个
  opts.skipRootOptions: 是否跳过根选项(RootOptions), true代表跳过根选项, false代表不跳过根选项, 
      根选项(RootOptions) = {--dev, --no-color, --profile|--profile=, --log-level|--log-level=, --container|--container=}
      内联选项(如 --profile=file.json)会被跳过, 非内联选项(如 --profile file.json)也会被跳过(跳到file.json的下一个参数)
  例如: 
    node app.js --profile test build -> ["test", "build"]
    node openclaw run dev --profile 1000 -> ["run", "dev"]
*/
function getCommandPathInternal(
  argv: string[],
  depth: number,
  opts: { skipRootOptions: boolean },
): string[] {
  const args = argv.slice(2);
  const path: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    // lyc: 遇到参数终止符 "--" 就停止解析, "--"代表之后的参数不再解析选项
    if (arg === "--") {
      break;
    }

    /* lyc: 
      如果需要跳过根选项(RootOptions)，尝试消费(略过)根选项(RootOptions)
      --profile file.json --log-level: 跳过 --profile 选项 和 选项值 file.json，继续搜索, 
            即 i=i+2-1=i+1 指向 file.json 参数, continue后i++指向 --log-level 选项
      --profile=file.json --log-level: 跳过 --profile=file.json 选项，继续搜索, 
            即i=i+1-1=i 指向 --profile=file.json 选项(没有动), continue后i++指向 --log-level 选项
      --params --log-level: --params不是根选项, 继续执行当前循环内剩下的逻辑
      */
    if (opts.skipRootOptions) {
      // lyc: 只关注根选项(RootOptions) 其它一律返回0
      const consumed = consumeRootOptionToken(args, i);
      // lyc: consumed == 0代表args[i]不是根选项,继续下面的搜索
      if (consumed > 0) {
        i += consumed - 1;
        continue;
      }
    }
    // lyc: 当前参数以"-"或"--"开头, 则一定不是命令路径 和 根选项(RootOptions), 而是其它的选项参数
    if (arg.startsWith("-")) {
      continue;
    }
    // lyc: 一定是命令路径, 则加入路径
    path.push(arg);
    // lyc: 达到指定命令路径的深度, 则跳出循环
    if (path.length >= depth) {
      break;
    }
  }
  return path;
}

export function getPrimaryCommand(argv: string[]): string | null {
  const [primary] = getCommandPathWithRootOptions(argv, 1);
  return primary ?? null;
}

type CommandPositionalsParseOptions = {
  commandPath: ReadonlyArray<string>;
  booleanFlags?: ReadonlyArray<string>;
  valueFlags?: ReadonlyArray<string>;
};

function consumeKnownOptionToken(
  args: ReadonlyArray<string>,
  index: number,
  booleanFlags: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>,
): number {
  const arg = args[index];
  if (!arg || arg === FLAG_TERMINATOR || !arg.startsWith("-")) {
    return 0;
  }

  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);

  if (booleanFlags.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }

  if (!valueFlags.has(flag)) {
    return 0;
  }

  if (equalsIndex !== -1) {
    const value = arg.slice(equalsIndex + 1).trim();
    return value ? 1 : 0;
  }

  return isValueToken(args[index + 1]) ? 2 : 0;
}

export function getCommandPositionalsWithRootOptions(
  argv: string[],
  options: CommandPositionalsParseOptions,
): string[] | null {
  const args = argv.slice(2);
  const commandPath = options.commandPath;
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const valueFlags = new Set(options.valueFlags ?? []);
  const positionals: string[] = [];
  let commandIndex = 0;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }

    const rootConsumed = consumeRootOptionToken(args, i);
    if (rootConsumed > 0) {
      i += rootConsumed - 1;
      continue;
    }

    if (arg.startsWith("-")) {
      const optionConsumed = consumeKnownOptionToken(args, i, booleanFlags, valueFlags);
      if (optionConsumed === 0) {
        return null;
      }
      i += optionConsumed - 1;
      continue;
    }

    if (commandIndex < commandPath.length) {
      if (arg !== commandPath[commandIndex]) {
        return null;
      }
      commandIndex += 1;
      continue;
    }

    positionals.push(arg);
  }

  if (commandIndex < commandPath.length) {
    return null;
  }
  return positionals;
}

export function buildParseArgv(params: {
  programName?: string;
  rawArgs?: string[];
  fallbackArgv?: string[];
}): string[] {
  const baseArgv =
    params.rawArgs && params.rawArgs.length > 0
      ? params.rawArgs
      : params.fallbackArgv && params.fallbackArgv.length > 0
        ? params.fallbackArgv
        : process.argv;
  const programName = params.programName ?? "";
  const normalizedArgv =
    programName && baseArgv[0] === programName
      ? baseArgv.slice(1)
      : baseArgv[0]?.endsWith("openclaw")
        ? baseArgv.slice(1)
        : baseArgv;
  const looksLikeNode =
    normalizedArgv.length >= 2 &&
    (isNodeRuntime(normalizedArgv[0] ?? "") || isBunRuntime(normalizedArgv[0] ?? ""));
  if (looksLikeNode) {
    return normalizedArgv;
  }
  return ["node", programName || "openclaw", ...normalizedArgv];
}

// lyc: 判断是否需要迁移状态(根据命令路径) (如从旧版本升级)
// lyc: health, status, sessions, update status, config get|unset, models list|status, agent 不需要迁移状态
export function shouldMigrateStateFromPath(path: string[]): boolean {
  if (path.length === 0) {
    return true;
  }
  const [primary, secondary] = path;
  if (primary === "health" || primary === "status" || primary === "sessions") {
    return false;
  }
  if (primary === "update" && secondary === "status") {
    return false;
  }
  if (primary === "config" && (secondary === "get" || secondary === "unset")) {
    return false;
  }
  if (primary === "models" && (secondary === "list" || secondary === "status")) {
    return false;
  }
  if (primary === "agent") {
    return false;
  }
  return true;
}

export function shouldMigrateState(argv: string[]): boolean {
  return shouldMigrateStateFromPath(getCommandPath(argv, 2));
}
