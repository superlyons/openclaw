import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE } from "./local-build-metadata-paths.mjs";

export { BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE };

/* lyc: 解析当前Git分支的HEAD, 返回HEAD值|null
*/
// lyc:aic 注释从 scripts/build-stamp.mjs 迁移过来（v2026.5 把实现抽到本文件）
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

 * 写入构建戳文件(.buildstamp是文件): /home/openclaw/dist/.buildstamp
 *
 * 此函数将当前构建的时间戳和 Git 提交哈希写入到 dist/.buildstamp 文件中。
 * 文件内容为 JSON 格式，包含 builtAt 和 head 字段。
 */
// lyc:aic 注释从 scripts/build-stamp.mjs 迁移过来
export function writeBuildStamp(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const now = params.now ?? Date.now;
  const distRoot = path.join(cwd, "dist");
  const buildStampPath = path.join(distRoot, BUILD_STAMP_FILE);
  const head = resolveGitHead({
    cwd,
    spawnSync: params.spawnSync,
  });

  fsImpl.mkdirSync(distRoot, { recursive: true });
  fsImpl.writeFileSync(buildStampPath, `${JSON.stringify({ builtAt: now(), head })}\n`, "utf8");
  return buildStampPath;
}

export function writeRuntimePostBuildStamp(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const now = params.now ?? Date.now;
  const distRoot = path.join(cwd, "dist");
  const stampPath = path.join(distRoot, RUNTIME_POSTBUILD_STAMP_FILE);
  const head = resolveGitHead({
    cwd,
    spawnSync: params.spawnSync,
  });

  fsImpl.mkdirSync(distRoot, { recursive: true });
  fsImpl.writeFileSync(
    stampPath,
    `${JSON.stringify(
      {
        syncedAt: now(),
        ...(head ? { head } : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return stampPath;
}
