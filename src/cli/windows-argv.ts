import fs from "node:fs";
import path from "node:path";
/* lyc:
  清理和规范化 Windows 上的命令行参数数组，特别是处理由于 Windows 命令解析方式导致的重复的 Node.js 可执行文件路径问题
  这个函数通过多层清理策略，确保了即使在 Windows 参数混乱的情况下，也能得到一个干净的、可预测的 argv 数组。
  在 Windows 上，当你通过某些方式（如 .bat 文件、cmd.exe 或其他程序）启动 Node.js 脚本时，命令行参数中可能会多次出现 Node.js 可执行文件的路径：
  # 假设你执行:
  node script.js
  # 但在某些情况下，process.argv 可能是:
    ['C:\\node.exe', 'C:\\node.exe', 'C:\\node.exe', 'script.js']
  # 或者
    ['C:\\node.exe', 'C:\\Program Files\\nodejs\\node.exe', 'script.js']
 */
export function normalizeWindowsArgv(argv: string[]): string[] {
  // lyc: 只在 Windows 平台上处理
  if (process.platform !== "win32") {
    return argv;
  }
  if (argv.length < 2) {
    return argv;
  }

  const stripControlChars = (value: string): string => {
    let out = "";
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      // lyc: 过滤控制字符; 0～31及127(共33个)是控制字符或通信专用字符（其余为可显示字符）
      if (code >= 32 && code !== 127) {
        out += value[i];
      }
    }
    return out;
  };

  const normalizeArg = (value: string): string =>
    stripControlChars(value)
      .replace(/^['"]+|['"]+$/g, "")
      .trim();
  const normalizeCandidate = (value: string): string =>
    normalizeArg(value).replace(/^\\\\\\?\\/, "");

  // lyc: execPath当前 Node.js(node.exe) 可执行文件的绝对路径‌
  const execPath = normalizeCandidate(process.execPath);
  const execPathLower = execPath.toLowerCase();
  const execBase = path.basename(execPath).toLowerCase();
  const isExecPath = (value: string | undefined): boolean => {
    if (!value) {
      return false;
    }
    const normalized = normalizeCandidate(value);
    if (!normalized) {
      return false;
    }
    const lower = normalized.toLowerCase();
    return (
      lower === execPathLower ||
      path.basename(lower) === execBase ||
      lower.endsWith("\\node.exe") ||
      lower.endsWith("/node.exe") ||
      lower.includes("node.exe") ||
      (path.basename(lower) === "node.exe" && fs.existsSync(normalized))
    );
  };

  const next = [...argv];
  /* lyc: 
    步骤1: 清理前3个参数中重复的 execPath
    next 为什么从 1 开始遍历并且 <=3
    前几个参数通常是 node.exe 路径的重复出现位置
    // process.argv 的标准结构:
    // [0]: node.exe 路径
    // [1]: 脚本文件路径
    // [2]: 第一个真正的参数

    // 但在 Windows 异常情况下:
    // [0]: node.exe 路径
    // [1]: node.exe 路径 (重复)
    // [2]: node.exe 路径 (可能再次重复)
    // [3]: script.js
    // [4]: --help
    从 i = 1 开始：跳过索引 0（这是原始的 node.exe 路径，需要保留）
    i <= 3：最多检查前 3 个位置，因为重复通常不会超过这个范围
    EXP: ['C:\\node.exe', 'C:\\node.exe', 'C:\\node.exe', 'script.js', '--help']
    清理后: ['C:\\node.exe', 'script.js', '--help']
  */
  for (let i = 1; i <= 3 && i < next.length; ) {
    if (isExecPath(next[i])) {
      next.splice(i, 1);
      continue;
    }
    i += 1;
  }
  /* lyc: 
    步骤2: 过滤掉所有 execPath 条目 但保护第一个参数
    确保彻底清除所有可能遗留的 execPath 条目，同时保护索引 0。
    因为第一步只检查了前 3 个位置，但 execPath 可能出现在更后面的位置。
    EXP: ['C:\\node.exe', 'script.js', 'C:\\node.exe', '--help', 'C:\\node.exe']
    过滤后: ['C:\\node.exe', 'script.js', '--help']
  */
  const filtered = next.filter((arg, index) => index === 0 || !isExecPath(arg));
  /* lyc: 
    步骤3: 检查参数数量
    参数数量少于 3 意味着不可能有脚本文件路径需要处理。
    EXP: ['C:\\node.exe', 'script.js']
    */
  if (filtered.length < 3) {
    return filtered;
  }
  const cleaned = [...filtered];
  /* lyc: 
    步骤4: 清理非选项参数中的 execPath
    - 从 i = 2 开始：跳过索引 0（node.exe）和索引 1（脚本文件）
    - 遇到选项 -：跳过，继续检查下一个
    - 选项参数：检查是否为 execPath，是则删除
    - 遇到第一个非选项且非 execPath 的参数：停止搜索
    为什么遇到非选项就停止？
      因为参数解析的规则：一旦遇到第一个非选项参数（通常是要执行的命令或文件名），后面的参数都是它的参数，不应该再被清理。
      EXP: ['C:\\node.exe', 'script.js', 'build', 'C:\\node.exe', '--verbose']
        i=2: build不是选项参数, 后面的参数都是他的参数, 不应该再被清理。
      EXP: ['C:\\node.exe', 'script.js', 'C:\\node.exe', 'build', '--verbose'] // 其实不存在这种情况,因为前面filtered已经过滤掉了execPath
        i=2: 'C:\\node.exe' 是 execPath → 删除
        下次循环i=2: 现在是 'build'，不是选项，不是 execPath → break
        结果: ['C:\\node.exe', 'script.js', 'build', '--verbose']
  */
  for (let i = 2; i < cleaned.length; ) {
    const arg = cleaned[i];
    if (!arg || arg.startsWith("-")) {
      i += 1;
      continue;
    }
    if (isExecPath(arg)) {
      cleaned.splice(i, 1);
      continue;
    }
    break;
  }
  return cleaned;
}
