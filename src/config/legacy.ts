import { LEGACY_CONFIG_MIGRATIONS } from "./legacy.migrations.js";
import { LEGACY_CONFIG_RULES } from "./legacy.rules.js";
import type { LegacyConfigIssue } from "./types.js";

function getPathValue(root: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/* lyc:
  查找遗留配置问题
*/
export function findLegacyConfigIssues(raw: unknown, sourceRaw?: unknown): LegacyConfigIssue[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const root = raw as Record<string, unknown>;
  const sourceRoot =
    sourceRaw && typeof sourceRaw === "object" ? (sourceRaw as Record<string, unknown>) : root;
  const issues: LegacyConfigIssue[] = [];
  for (const rule of LEGACY_CONFIG_RULES) {
    const cursor = getPathValue(root, rule.path);
    // lyc: 被找到 && (没有提供match || 提供了match并且返回true)
    if (cursor !== undefined && (!rule.match || rule.match(cursor, root))) {
      // lyc: 如果需要源配置文件(sourceRoot)
      if (rule.requireSourceLiteral) {
        // lyc: 查找源配置文件的路径值
        const sourceCursor = getPathValue(sourceRoot, rule.path);
        // lyc: 如果源配置文件中路径值不存在则跳过
        if (sourceCursor === undefined) {
          continue;
        }
        // lyc: 如果源配置文件中路径值存在但匹配失败则跳过
        if (rule.match && !rule.match(sourceCursor, sourceRoot)) {
          continue;
        }
      }
      // lyc: 如果不需要源配置文件(sourceRoot)则直接添加问题
      issues.push({ path: rule.path.join("."), message: rule.message });
    }
  }
  return issues;
}

export function applyLegacyMigrations(raw: unknown): {
  next: Record<string, unknown> | null;
  changes: string[];
} {
  if (!raw || typeof raw !== "object") {
    return { next: null, changes: [] };
  }
  const next = structuredClone(raw) as Record<string, unknown>;
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(next, changes);
  }
  if (changes.length === 0) {
    return { next: null, changes: [] };
  }
  return { next, changes };
}
