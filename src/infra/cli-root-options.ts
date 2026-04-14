export const FLAG_TERMINATOR = "--";

const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level"]);

/* lyc:
  判断一个参数是否应该被视为选项的值(选项值令牌)，而不是一个新的选项。
  false: undefined
  false: --
  false: --profile 
  true: file.txt 
  true: -3.14
*/
export function isValueToken(arg: string | undefined): boolean {
  // lyc: 空值或终止符"--"不是值
  if (!arg || arg === FLAG_TERMINATOR) {
    return false;
  }
  // lyc: 不以 "-" 开头的通常是值（如文件名、数字等）
  if (!arg.startsWith("-")) {
    return true;
  }
  // lyc: 特殊处理：负数（如 -1, -3.14）应该被视为值，而不是选项
  return /^-\d+(?:\.\d+)?$/.test(arg);
}

/* lyc:
  当前选项应该消费(略过)多少个参数，用于正确解析带值的选项。
*/
export function consumeRootOptionToken(args: ReadonlyArray<string>, index: number): number {
  const arg = args[index];
  if (!arg) {
    // lyc: 无参数，不消费
    return 0;
  }
  // lyc: "--dev", "--no-color"是无值的布尔选项，直接消费
  if (ROOT_BOOLEAN_FLAGS.has(arg)) {
    return 1;
  }
  // lyc: 内联值选项：值包含在选项本身中，如 "--profile=file.txt"，直接消费
  if (arg.startsWith("--profile=") || arg.startsWith("--log-level=")) {
    return 1;
  }
  // lyc: "--profile", "--log-level"是带值的选项：需要检查下一个参数是否为值
  if (ROOT_VALUE_FLAGS.has(arg)) {
    // lyc: 如果下一个参数是值，消费 2 个（选项 + 值）；否则只消费自身
    return isValueToken(args[index + 1]) ? 2 : 1;
  }
  // lyc: 不是根选项，不消费
  return 0;
}
