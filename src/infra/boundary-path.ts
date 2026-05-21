/* lyc:aic v2026.5 大重构：本文件从 ~1080 行的本地实现，被整个抽到了外部包 @openclaw/fs-safe/advanced。
 * 现在只剩 re-export。
 *
 * ⚠️ 你之前对 resolveBoundaryPath / resolveBoundaryPathSync / 各种边界守卫的 85 处 lyc 中文注释
 *    已完整保存到 .ai_claude/snapshots/boundary-path.4.26.lyc-snapshot.ts (1072 行)。
 *    新函数名对照：
 *      resolveBoundaryPath      → resolveRootPath
 *      resolveBoundaryPathSync  → resolveRootPathSync
 *      BoundaryPathAliasPolicy  → RootPathAliasPolicy
 *      BOUNDARY_PATH_ALIAS_POLICIES → ROOT_PATH_ALIAS_POLICIES
 *    若要看你的中文注释，去 .ai_claude/snapshots/ 找。
 */
import "./fs-safe-defaults.js";
export {
  ROOT_PATH_ALIAS_POLICIES,
  resolvePathViaExistingAncestorSync,
  resolveRootPath,
  resolveRootPathSync,
  type ResolvedRootPath,
  type RootPathAliasPolicy,
} from "@openclaw/fs-safe/advanced";
