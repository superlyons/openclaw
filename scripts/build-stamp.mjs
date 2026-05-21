#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { writeBuildStamp } from "./lib/local-build-metadata.mjs";

// lyc:aic v2026.5：resolveGitHead 和 writeBuildStamp 的实现被抽到 ./lib/local-build-metadata.mjs，
//         本文件只是 re-export。你原本附在实现上的 lyc 注释已迁移到 lib/local-build-metadata.mjs 对应函数上方。
export { BUILD_STAMP_FILE, resolveGitHead, writeBuildStamp } from "./lib/local-build-metadata.mjs";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    writeBuildStamp();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
