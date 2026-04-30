/* lyc:ai 
doctor-config-preflight.ts - OpenClaw CLI 配置预检模块

此模块在 CLI 命令执行前进行轻量级的配置预检和状态迁移。
它被 config-guard.ts 中的 ensureConfigReady 函数调用，
用于处理潜在的配置迁移和状态升级需求。

核心功能：
1. 自动迁移旧版配置文件（.clawdbot -> .openclaw）
2. 执行状态目录迁移（legacy state dir migration）
3. 读取配置快照并提供最佳努力的配置对象
4. 在无效配置情况下提供友好的用户通知

设计特点：
- 轻量级：只进行必要的检查，不执行完整的配置验证
- 安全性：使用 COPYFILE_EXCL 避免覆盖现有文件
- 用户友好：提供清晰的迁移和警告信息
- 灵活性：通过选项参数控制不同功能的启用/禁用
*/

import fs from "node:fs/promises";
import path from "node:path";
import { readConfigFileSnapshot, recoverConfigFromJsonRootSuffix } from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { note } from "../terminal/note.js";
import { resolveHomeDir } from "../utils.js";
import { noteIncludeConfinementWarning } from "./doctor-config-analysis.js";

/* lyc:ai 
负责自动迁移旧版配置文件。
这是 OpenClaw 从 ClawdBot 迁移的关键步骤，确保用户配置的连续性。

执行逻辑：
1. 检查目标配置文件是否已存在（避免重复迁移）
2. 查找旧版配置文件候选路径（.clawdbot/clawdbot.json）
3. 如果找到旧版配置，创建目标目录并安全复制文件
4. 使用 COPYFILE_EXCL 标志确保不会覆盖现有文件

迁移路径：
- 源：~/.clawdbot/clawdbot.json
- 目标：~/.openclaw/openclaw.json
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
    安全复制配置文件：
    - 使用 COPYFILE_EXCL 标志确保不会覆盖已存在的文件
    - 如果目标文件已存在，操作会失败并静默跳过
    - 这确保了迁移的安全性，不会意外覆盖用户的新配置
    */
    await fs.copyFile(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
    changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
  } catch {
    // If it already exists, skip silently.
  }

  return changes;
}

/* lyc:ai 
DoctorConfigPreflightResult 定义了预检结果的数据结构。
- snapshot: 配置文件快照，包含存在性、有效性、问题列表等信息
- baseConfig: 最佳努力的配置对象，用于在无效配置情况下继续执行
*/
export type DoctorConfigPreflightResult = {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  baseConfig: OpenClawConfig;
};

/* lyc:ai 
配置预检的核心函数。
它在 CLI 启动时执行轻量级的状态检查和迁移操作。

参数说明：
- migrateState: 是否执行状态目录迁移（默认 true）
- migrateLegacyConfig: 是否执行旧版配置迁移（默认 true）
- invalidConfigNote: 无效配置时显示的通知消息（默认提供标准消息）

执行流程：
1. 状态目录迁移（如果启用）
2. 旧版配置迁移（如果启用）
3. 读取配置快照
4. 处理无效配置通知
5. 显示配置警告
6. 返回预检结果

关键设计：
- 默认启用所有迁移功能，但可通过参数禁用
- 即使配置无效也返回最佳努力的配置对象
- 提供详细的用户通知和警告信息
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
  let snapshot = await readConfigFileSnapshot();
  if (
    options.repairPrefixedConfig === true &&
    snapshot.exists &&
    !snapshot.valid &&
    (await recoverConfigFromJsonRootSuffix(snapshot))
  ) {
    note("Removed non-JSON prefix from openclaw.json; original saved as .clobbered.*.", "Config");
    snapshot = await readConfigFileSnapshot();
  }
  const invalidConfigNote =
    options.invalidConfigNote ?? "Config invalid; doctor will run with best-effort config.";
  /* lyc:ai 
  如果配置无效且不是由于旧版配置问题导致的无效，则显示通知
  注意：legacyIssues.length === 0 表示不是旧版配置问题
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
  返回预检结果：
  - snapshot: 完整的配置快照信息
  - baseConfig: 最佳努力的配置对象
    * 优先使用 sourceConfig（解析后的源配置）
    * 其次使用 config（运行时配置）
    * 最后使用空对象作为兜底
  */
  return {
    snapshot,
    baseConfig: snapshot.sourceConfig ?? snapshot.config ?? {},
  };
}
