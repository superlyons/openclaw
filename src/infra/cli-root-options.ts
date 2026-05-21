export const FLAG_TERMINATOR = "--";

const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level", "--container"]);

// lyc: 判断是否是值参数令牌
export function isValueToken(arg: string | undefined): boolean {
  if (!arg || arg === FLAG_TERMINATOR) {
    return false;
  }
  if (!arg.startsWith("-")) {
    return true;
  }
  // lyc: 当前参数以-开头的参数, 如果是负数返回true, 否则返回false
  return /^-\d+(?:\.\d+)?$/.test(arg);
}

/* lyc: 消费根选项令牌
*/
export function consumeRootOptionToken(args: ReadonlyArray<string>, index: number): number {
  const arg = args[index];
  if (!arg) {
    return 0;
  }
  // lyc: 当前参数是布尔值根选项, --dev, --no-color, 消费令牌数为1, 即代表消费当前参数即可
  if (ROOT_BOOLEAN_FLAGS.has(arg)) {
    return 1;
  }
  // lyc: 当前参数是值参数内联根选项, --profile=1000, --log-level=info, --container=123456, 消费令牌数为1, 即代表消费当前参数即可
  if (
    arg.startsWith("--profile=") ||
    arg.startsWith("--log-level=") ||
    arg.startsWith("--container=")
  ) {
    return 1;
  }
  // lyc: 当前参数是有后续参数的根选项, --profile, --log-level, --container, 且下一个参数是值参数, 消费令牌数为2, 即代表消费当前参数和下一个参数
  // lyc: 例如 --log-level info 消费令牌数为2, 即代表消费当前参数和下一个参数info
  if (ROOT_VALUE_FLAGS.has(arg)) {
    return isValueToken(args[index + 1]) ? 2 : 1;
  }
  return 0;
}
