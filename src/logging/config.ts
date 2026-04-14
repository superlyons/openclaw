import fs from "node:fs";
import json5 from "json5";
import { resolveConfigPath } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";

type LoggingConfig = OpenClawConfig["logging"];
/* lyc:
  读取日志配置
  如果配置文件不存在, 则返回 undefined
  如果配置文件存在, 则返回日志配置
*/
export function readLoggingConfig(): LoggingConfig | undefined {
  const configPath = resolveConfigPath();
  try {
    if (!fs.existsSync(configPath)) {
      return undefined;
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = json5.parse(raw);
    const logging = parsed?.logging;
    if (!logging || typeof logging !== "object" || Array.isArray(logging)) {
      return undefined;
    }
    return logging as LoggingConfig;
  } catch {
    return undefined;
  }
}
