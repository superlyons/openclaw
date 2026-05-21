/* lyc:aic v2026.5 大重构：本文件从 ~250 行的本地实现，被整个抽到了外部包 @openclaw/fs-safe/advanced。
 * 现在只剩 re-export。你原本对 openBoundaryFileSync 的 lyc 注释保留如下（描述对象现在叫 openRootFileSync）：
 *
 * lyc: 在安全边界内读取文件
 *   params:
 *     absolutePath: 要读取的文件的绝对路径
 *     rootPath: 根目录（边界），确保文件在此目录内
 *     boundaryLabel: 边界标签，用于错误信息
 *     rejectHardlinks: 是否拒绝硬链接
 */
import "./fs-safe-defaults.js";
export {
  canUseRootFileOpen,
  matchRootFileOpenFailure,
  openRootFile,
  openRootFileSync,
  type OpenRootFileParams,
  type OpenRootFileSyncParams,
  type RootFileOpenFailure,
  type RootFileOpenFailureReason,
  type RootFileOpenResult,
} from "@openclaw/fs-safe/advanced";
