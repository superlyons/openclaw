import fs from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

/* lyc:
  # 假设你执行:
  # 但在某些情况下，process.argv 可能是:
  # 或者
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
  const execPathLower = normalizeLowercaseStringOrEmpty(execPath);
  const execBase = normalizeLowercaseStringOrEmpty(path.basename(execPath));
  const isExecPath = (value: string | undefined): boolean => {
    if (!value) {
      return false;
    }
    const normalized = normalizeCandidate(value);
    if (!normalized) {
      return false;
    }
    const lower = normalizeLowercaseStringOrEmpty(normalized);
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
  */
  for (let i = 1; i <= 3 && i < next.length; ) {
    if (isExecPath(next[i])) {
      next.splice(i, 1);
      continue;
    }
    i += 1;
  }
  /* lyc: 
  */
  const filtered = next.filter((arg, index) => index === 0 || !isExecPath(arg));
  /* lyc: 
    */
  if (filtered.length < 3) {
    return filtered;
  }
  const cleaned = [...filtered];
  /* lyc: 
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
