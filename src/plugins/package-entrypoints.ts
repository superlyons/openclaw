import path from "node:path";

export function isTypeScriptPackageEntry(entryPath: string): boolean {
  return [".ts", ".mts", ".cts"].includes(path.extname(entryPath).toLowerCase());
}

// lyc: 列出entryPath的运行时设置入口候选地址列表, 排除entryPath本身, 即将entryPath路径转换为以dist开头且无扩展名的路径候选列表
export function listBuiltRuntimeEntryCandidates(entryPath: string): string[] {
  // lyc: entryPath是否是TypeScript语言的包入口(ts, mts, cts)
  if (!isTypeScriptPackageEntry(entryPath)) {
    return [];
  }
  const normalized = entryPath.replace(/\\/g, "/");
  // lyc: entryPath的无扩展名路径, 例如: "./utils/helper.js" -> "./utils/helper"
  const withoutExtension = normalized.replace(/\.[^.]+$/u, "");
  // lyc: entryPath的无当前目录路径, 去掉"./", 例如"./src/utils/helper.js" -> "src/utils/helper.js"
  const normalizedRelative = normalized.replace(/^\.\//u, "");
  /* lyc: entryPath无扩展名的dist路径地址
  entryPath如果以"./src/"开头, 则./dist/+去掉"./src/"和扩展名, 例如"./src/utils/helper.js" -> "./dist/utils/helper"
    否则./dist/+去掉"./"和扩展名, 例如"./utils/helper.js" -> "./dist/utils/helper"
  */
  const distWithoutExtension = normalizedRelative.startsWith("src/")
    // lyc: normalizedRelative = src/utils/helper.js -> utils/helper.js -> utils/helper -> ./dist/utils/helper
    ? `./dist/${normalizedRelative.slice("src/".length).replace(/\.[^.]+$/u, "")}`
    // lyc: withoutExtension = ./utils/helper -> utils/helper -> ./dist/utils/helper
    : `./dist/${withoutExtension.replace(/^\.\//u, "")}`;
  const withJavaScriptExtensions = (basePath: string) => [
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
  ];
  // lyc: 构造entryPath的候选入口地址列表
  const candidates = [
    ...withJavaScriptExtensions(distWithoutExtension),
    ...withJavaScriptExtensions(withoutExtension),
  ];
  // lyc: 返回entryPath的运行时候选入口地址列表, 排除entryPath本身
  return [...new Set(candidates)].filter((candidate) => candidate !== normalized);
}
