import { FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { forwardConsumedCliRootOption } from "./root-option-forward.js";

type CliRootOptionScanResult = { ok: true; argv: string[] } | { ok: false; error: string };

type CliRootOptionVisitResult =
  | { kind: "pass" }
  | { kind: "handled"; consumedNext?: boolean }
  | { kind: "error"; error: string };

// lyc: 扫描CLI根选项, 并调用visit函数处理每个选项
export function scanCliRootOptions(
  argv: string[],
  visit: (params: {
    arg: string;
    args: string[];
    index: number;
    out: string[];
  }) => CliRootOptionVisitResult,
): CliRootOptionScanResult {
  if (argv.length < 2) {
    return { ok: true, argv };
  }
  // lyc: out直接等于argv的前两个参数, 例如: ["node", "/path/openclaw.mjs", "run", "dev", "--container", "name"] -> ["node", "/path/openclaw.mjs"]

  const out: string[] = argv.slice(0, 2);
  // lyc: 遍历argv的剩余参数, 例如: ["node", "/path/openclaw.mjs", "run", "dev", "--container", "name"] -> ["run", "dev", "--container", "name"]
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    // lyc: 如果是终止标志"--"则将后面的所有参数都直接添加到out数组中并退出循环
    if (arg === FLAG_TERMINATOR) {
      out.push(arg, ...args.slice(i + 1));
      break;
    }
    // lyc: 调用回调函数visit处理当前参数

    const visited = visit({ arg, args, index: i, out });
    if (visited.kind === "error") {
      return { ok: false, error: visited.error };
    }
    // lyc: 代表当前参数已被回调函数visit处理, 不需要继续处理, 直接进入下一个循环的参数处理
    // lyc: 注意: 当前参数arg以及下一个参数是否被添加到out中由回调函数visit自行决定, 主函数不做任何处理
    if (visited.kind === "handled") {
      if (visited.consumedNext) {
        i += 1;
      }
      continue;
    }
    // lyc: 到这里代表当前参数未被回调函数visit处理, 即是不关心的参数, 需要继续处理
    // lyc: 处理根选项(--dev, --no-color, --profile, --log-level, --container), 并将参数添加到out数组中

    const consumedRootOption = forwardConsumedCliRootOption(args, i, out);
    // lyc: 如果处理了根选项, 则将i指向根选项后的第一个参数, 并继续下一个循环的参数处理
    if (consumedRootOption > 0) {
      i += consumedRootOption - 1;
      continue;
    }
    // lyc: 其他参数直接添加到out数组中

    out.push(arg);
  }

  return { ok: true, argv: out };
}
