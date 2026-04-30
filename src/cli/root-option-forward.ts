import { consumeRootOptionToken } from "../infra/cli-root-options.js";

// lyc: 判断args[index]是否为根选项, 如果是则向out数组中添加根选项参数, 返回添加的参数数量
// lyc: 如果参数不是根选项, 则返回0
export function forwardConsumedCliRootOption(
  args: readonly string[],
  index: number,
  out: string[],
): number {
  const consumedRootOption = consumeRootOptionToken(args, index);
  // lyc: 如果参数不是根选项, 则返回0
  if (consumedRootOption <= 0) {
    return 0;
  }

  // lyc: 向out数组中添加根选项参数和参数值(内联值不添加, 后续参数添加)
  for (let offset = 0; offset < consumedRootOption; offset += 1) {
    const token = args[index + offset];
    if (token !== undefined) {
      out.push(token);
    }
  }

  return consumedRootOption;
}
