import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STARTUP_METADATA_FILE = "cli-startup-metadata.json";
const startupMetadataByPath = new Map<string, Record<string, unknown> | null>();

// lyc: 解析启动元数据的候选路径, 以moduleUrl为基准, 解析cli-startup-metadata.json文件路径候选列表
// lyc: 返回 [moduleUrl当前目录/cli-startup-metadata.json, moduleUrl上一级目录/cli-startup-metadata.json]
function resolveStartupMetadataPathCandidates(moduleUrl: string): string[] {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return [
    path.resolve(moduleDir, STARTUP_METADATA_FILE),
    path.resolve(moduleDir, "..", STARTUP_METADATA_FILE),
  ];
}

// lyc: 读取启动元数据, 从启动元数据文件路径候选列表中读取, 返回启动元数据对象, 如果不存在, 则返回 null
export function readCliStartupMetadata(moduleUrl: string): Record<string, unknown> | null {
  for (const metadataPath of resolveStartupMetadataPathCandidates(moduleUrl)) {
    const cached = startupMetadataByPath.get(metadataPath);
    if (cached !== undefined) {
      if (cached) {
        return cached;
      }
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
      startupMetadataByPath.set(metadataPath, parsed);
      return parsed;
    } catch {
      // Try the next bundled/source layout before falling back to dynamic startup work.
      startupMetadataByPath.set(metadataPath, null);
    }
  }
  return null;
}

export const __testing = {
  resolveStartupMetadataPathCandidates,
  clearStartupMetadataCache(): void {
    startupMetadataByPath.clear();
  },
};
