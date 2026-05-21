/* lyc:aic v2026.5：本文件从本地实现改为 re-export ../infra/path-safety.js（infra 那边又抽到 @openclaw/fs-safe/path）。
 * 你原本对 safeRealpathSync 的 2 处 lyc 注释保留如下：
 *
 *   lyc: 安全地获取路径的绝对路径, 并缓存结果, realpathSync 为同步方法它会返回解析后的绝对路径
 *   lyc: realpathSync 实际会操作文件系统检查路径是否真实存在, 会解析软连接或快捷方式, 返回解析后的绝对路径
 */
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
  formatPosixMode,
} from "../infra/path-safety.js";
