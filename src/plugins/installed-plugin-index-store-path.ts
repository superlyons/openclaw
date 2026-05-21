import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const INSTALLED_PLUGIN_INDEX_STORE_PATH = path.join("plugins", "installs.json");

export type InstalledPluginIndexStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  filePath?: string;
};

// lyc: 解析已安装插件注册表存储路径, 默认值: ~/.openclaw/plugins/installs.json
export function resolveInstalledPluginIndexStorePath(
  options: InstalledPluginIndexStoreOptions = {},
): string {
  if (options.filePath) {
    // lyc: 如果指定了文件路径, 则直接返回该路径
    return options.filePath;
  }
  // lyc: 如果未指定文件路径, 则根据环境变量和状态目录解析默认路径
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  // lyc: ~/.openclaw/plugins/installs.json
  return path.join(stateDir, INSTALLED_PLUGIN_INDEX_STORE_PATH);
}
