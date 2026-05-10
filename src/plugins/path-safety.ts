import fs from "node:fs";
import { isPathInside as isBoundaryPathInside } from "../infra/path-guards.js";

export function isPathInside(baseDir: string, targetPath: string): boolean {
  return isBoundaryPathInside(baseDir, targetPath);
}

// lyc: 安全地获取路径的绝对路径, 并缓存结果, realpathSync为同步方法它会返回解析后的绝对路径
// lyc： realpathSync 实际会操作文件系统检查路径是否真实存在, 会解析软连接或快捷方式, 返回解析后的绝对路径
export function safeRealpathSync(targetPath: string, cache?: Map<string, string>): string | null {
  const cached = cache?.get(targetPath);
  if (cached) {
    return cached;
  }
  try {
    // lyc: 解析路径为绝对路径, 路径中存在软连接或快捷方式时会返回解析后的绝对路径
    const resolved = fs.realpathSync(targetPath);
    cache?.set(targetPath, resolved);
    cache?.set(resolved, resolved);
    return resolved;
  } catch {
    return null;
  }
}

export function safeStatSync(targetPath: string): fs.Stats | null {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}

export function formatPosixMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}
