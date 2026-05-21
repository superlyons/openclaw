/* lyc:aic v2026.5 重构：本文件从约 60 行的本地实现抽到了外部包 @openclaw/fs-safe/path。
 * 现在只剩 re-export。你之前的 7 处 lyc 中文注释（ENOENT/ELOOP 含义、isPathInside 防穿越逻辑等）
 * 已完整保存到 .ai_claude/snapshots/path-guards.4.26.lyc-snapshot.ts。
 */
import "./fs-safe-defaults.js";
export {
  isNotFoundPathError,
  hasNodeErrorCode,
  isNodeError,
  isPathInside,
  isPathInsideWithRealpath,
  isSymlinkOpenError,
  isWithinDir,
  normalizeWindowsPathForComparison,
  resolveSafeBaseDir,
  resolveSafeRelativePath,
  safeRealpathSync,
  safeStatSync,
  splitSafeRelativePath,
} from "@openclaw/fs-safe/path";
