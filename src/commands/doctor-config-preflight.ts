/* lyc:ai 



*/

import fs from "node:fs/promises";
import path from "node:path";
import {
  readConfigFileSnapshot,
  recoverConfigFromJsonRootSuffix,
  recoverConfigFromLastKnownGood,
} from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { LegacyConfigIssue } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { note } from "../terminal/note.js";
import { resolveHomeDir } from "../utils.js";
import { noteIncludeConfinementWarning } from "./doctor-config-analysis.js";
import { findDoctorLegacyConfigIssues } from "./doctor/shared/legacy-config-issues.js";

/* lyc:ai 


*/
async function maybeMigrateLegacyConfig(): Promise<string[]> {
  const changes: string[] = [];
  const home = resolveHomeDir();
  if (!home) {
    return changes;
  }

  const targetDir = path.join(home, ".openclaw");
  const targetPath = path.join(targetDir, "openclaw.json");
  /* lyc:ai 检查目标配置是否已存在，如果存在则跳过迁移 */
  try {
    await fs.access(targetPath);
    return changes;
  } catch {
    // missing config
  }

  /* lyc:ai 定义旧版配置文件的候选路径列表 */
  const legacyCandidates = [path.join(home, ".clawdbot", "clawdbot.json")];

  let legacyPath: string | null = null;
  /* lyc:ai 尝试访问每个候选路径，找到第一个存在的旧版配置 */
  for (const candidate of legacyCandidates) {
    try {
      await fs.access(candidate);
      legacyPath = candidate;
      break;
    } catch {
      // continue
    }
  }
  if (!legacyPath) {
    return changes;
  }

  /* lyc:ai 创建目标目录（递归创建，权限 0o700） */
  await fs.mkdir(targetDir, { recursive: true });
  try {
    /* lyc:ai 
    */
    await fs.copyFile(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
    changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
  } catch {
    // If it already exists, skip silently.
  }

  return changes;
}

/* lyc:ai 
*/
export type DoctorConfigPreflightResult = {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  baseConfig: OpenClawConfig;
};

// lyc:aic v2026.5 新增：collectDoctorLegacyIssues + addDoctorLegacyIssues + shouldSkipPluginValidationForDoctorConfigPreflight
//         分别用于：扫 legacy 配置问题、把它附到 snapshot 上、判断是否要跳过插件验证（在 update-in-progress 时跳）
function collectDoctorLegacyIssues(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): LegacyConfigIssue[] {
  if (!snapshot.exists) {
    return [];
  }
  const resolvedRaw = snapshot.sourceConfig ?? snapshot.config ?? {};
  const sourceRaw = snapshot.parsed ?? resolvedRaw;
  return findDoctorLegacyConfigIssues(resolvedRaw, sourceRaw);
}

function addDoctorLegacyIssues(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): Awaited<ReturnType<typeof readConfigFileSnapshot>> {
  const legacyIssues = collectDoctorLegacyIssues(snapshot);
  if (legacyIssues.length === 0) {
    return snapshot;
  }
  return { ...snapshot, legacyIssues };
}

export function shouldSkipPluginValidationForDoctorConfigPreflight(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS);
}

/* lyc:ai



*/
export async function runDoctorConfigPreflight(
  options: {
    /* lyc:ai 是否执行状态目录迁移（legacy state dir migration） */
    migrateState?: boolean;
    /* lyc:ai 是否执行旧版配置文件迁移 */
    migrateLegacyConfig?: boolean;
    repairPrefixedConfig?: boolean;
    /* lyc:ai 无效配置时显示的通知消息，false 表示不显示 */
    invalidConfigNote?: string | false;
  } = {},
): Promise<DoctorConfigPreflightResult> {
  /* lyc: ========== 阶段一：状态目录迁移 将~/.clawdbot迁移到~/.openclaw========== */
  if (options.migrateState !== false) {
    /* lyc:ai 动态导入状态迁移模块，避免不必要的依赖加载 */
    const { autoMigrateLegacyStateDir } = await import("./doctor-state-migrations.js");
    /* lyc:ai 执行自动状态目录迁移 将~/.clawdbot迁移到~/.openclaw*/
    const stateDirResult = await autoMigrateLegacyStateDir({ env: process.env });
    if (stateDirResult.changes.length > 0) {
      note(stateDirResult.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
    }
    if (stateDirResult.warnings.length > 0) {
      note(stateDirResult.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
    }
  }

  /* lyc: ========== 阶段二：旧版配置迁移 将~/.clawdbot/clawdbot.json迁移到~/.openclaw/openclaw.json ========== */
  if (options.migrateLegacyConfig !== false) {
    const legacyConfigChanges = await maybeMigrateLegacyConfig();
    if (legacyConfigChanges.length > 0) {
      note(legacyConfigChanges.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
    }
  }

  /* lyc:ai ========== 阶段三：配置快照读取和通知 ========== */
  // lyc:aic v2026.5 增强：
  //   1. readOptions 多传 skipPluginValidation（update-in-progress 时跳过）
  //   2. snapshot 现在裹一层 addDoctorLegacyIssues 把 legacy issues 附上
  //   3. 修复失败时多了一个 recoverConfigFromLastKnownGood 回退路径
  const readOptions = {
    skipPluginValidation: shouldSkipPluginValidationForDoctorConfigPreflight(),
  };
  let snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot(readOptions));
  if (options.repairPrefixedConfig === true && snapshot.exists && !snapshot.valid) {
    if (await recoverConfigFromJsonRootSuffix(snapshot)) {
      note("Removed non-JSON prefix from openclaw.json; original saved as .clobbered.*.", "Config");
      snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot(readOptions));
    } else if (
      await recoverConfigFromLastKnownGood({ snapshot, reason: "doctor-invalid-config" })
    ) {
      note(
        "Restored openclaw.json from last-known-good; original saved as .clobbered.*.",
        "Config",
      );
      snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot(readOptions));
    }
  }
  const invalidConfigNote =
    options.invalidConfigNote ?? "Config invalid; doctor will run with best-effort config.";
  /* lyc:ai 
  */
  if (
    invalidConfigNote &&
    snapshot.exists &&
    !snapshot.valid &&
    snapshot.legacyIssues.length === 0
  ) {
    note(invalidConfigNote, "Config");
    noteIncludeConfinementWarning(snapshot);
  }

  /* lyc:ai 显示配置警告信息（非致命问题） */
  const warnings = snapshot.warnings ?? [];
  if (warnings.length > 0) {
    note(formatConfigIssueLines(warnings, "-").join("\n"), "Config warnings");
  }

  /* lyc:ai 
    * 优先使用 sourceConfig（解析后的源配置）
    * 其次使用 config（运行时配置）
    * 最后使用空对象作为兜底
  */
  return {
    snapshot,
    baseConfig: snapshot.sourceConfig ?? snapshot.config ?? {},
  };
}
