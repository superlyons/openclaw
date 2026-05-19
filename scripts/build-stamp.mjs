#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/* lyc: 解析当前Git分支的HEAD, 返回HEAD值|null
git rev-parse HEAD 是 Git 中用于‌获取当前提交（即 HEAD 指向的提交）的完整 SHA-1 哈希值‌的命令。
HEAD‌ 是 Git 中的一个特殊指针，通常指向当前分支的最新提交。
‌git rev-parse‌ 是一个底层命令，用于将人类可读的引用（如分支名、标签、HEAD 等）解析为 Git 内部使用的对象哈希值。
因此，‌git rev-parse HEAD 的作用是将 HEAD 这个符号引用转换为具体的提交哈希‌。
*/
export function resolveGitHead(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  try {
    const result = spawnSyncImpl("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) {
      return null;
    }
    const head = (result.stdout ?? "").trim();
    return head || null;
  } catch {
    return null;
  }
}

/** lyc
 * 写入构建戳文件(.buildstamp是文件): /home/openclaw/dist/.buildstamp
 * 
 * 此函数将当前构建的时间戳和 Git 提交哈希写入到 dist/.buildstamp 文件中。
 * 文件内容为 JSON 格式，包含 builtAt 和 head 字段。
 */
export function writeBuildStamp(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const now = params.now ?? Date.now;
  const distRoot = path.join(cwd, "dist");
  const buildStampPath = path.join(distRoot, ".buildstamp");
  const head = resolveGitHead({
    cwd,
    spawnSync: params.spawnSync,
  });

  fsImpl.mkdirSync(distRoot, { recursive: true });
  fsImpl.writeFileSync(buildStampPath, `${JSON.stringify({ builtAt: now(), head })}\n`, "utf8");
  return buildStampPath;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    writeBuildStamp();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
