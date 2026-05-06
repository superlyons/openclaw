import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

// lyc: ENOENT 没有这样的文件或目录, ENOTDIR不是一个目录,
const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR"]);
// lyc: ELOOP‌：‌符号链接层级过多, EINVAL‌：‌无效参数, ENOTSUP‌：‌不支持的操作
const SYMLINK_OPEN_CODES = new Set(["ELOOP", "EINVAL", "ENOTSUP"]);
const PARENT_SEGMENT_PREFIX = /^\.\.(?:[\\/]|$)/u;

export function normalizeWindowsPathForComparison(input: string): string {
  let normalized = path.win32.normalize(input);
  if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
    if (normalized.toUpperCase().startsWith("UNC\\")) {
      normalized = `\\\\${normalized.slice(4)}`;
    }
  }
  return normalizeLowercaseStringOrEmpty(normalized.replaceAll("/", "\\"));
}

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return Boolean(
    value && typeof value === "object" && "code" in (value as Record<string, unknown>),
  );
}

export function hasNodeErrorCode(value: unknown, code: string): boolean {
  return isNodeError(value) && value.code === code;
}

export function isNotFoundPathError(value: unknown): boolean {
  return isNodeError(value) && typeof value.code === "string" && NOT_FOUND_CODES.has(value.code);
}

export function isSymlinkOpenError(value: unknown): boolean {
  return isNodeError(value) && typeof value.code === "string" && SYMLINK_OPEN_CODES.has(value.code);
}

// lyc: 判断target是否在root内部(防止路径穿越，如 ../../../etc)
export function isPathInside(root: string, target: string): boolean {
  if (process.platform === "win32") {
    const rootForCompare = normalizeWindowsPathForComparison(path.win32.resolve(root));
    const targetForCompare = normalizeWindowsPathForComparison(path.win32.resolve(target));
    // lyc: 计算相对路径, rootForCompare 到 targetForCompare的相对路径
    const relative = path.win32.relative(rootForCompare, targetForCompare);
    return (
      // lyc: 如果 relative 为空（同一路径）或者不以 ".." 开头且不是绝对路径，则说明 target 在 root 内部
      relative === "" || (!PARENT_SEGMENT_PREFIX.test(relative) && !path.win32.isAbsolute(relative))
    );
  }

  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  // lyc: 计算相对路径, resolvedRoot 到 resolvedTarget的相对路径
  const relative = path.relative(resolvedRoot, resolvedTarget);
  // lyc: 如果相对路径为 空（同一路径）或者 不以..开头并且不是绝对路径, 则返回true代表resolvedTarget在resolvedRoot内部
  return relative === "" || (!PARENT_SEGMENT_PREFIX.test(relative) && !path.isAbsolute(relative));
}
