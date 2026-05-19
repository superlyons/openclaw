import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";

/** lyc
 * 复制插件SDK根别名文件到分发目录
 * 
 * 此函数将源代码中的插件SDK根别名文件(src/plugin-sdk/root-alias.cjs)
 * 复制到分发目录(dist/plugin-sdk/root-alias.cjs)。
 * 这个别名文件用于在运行时提供正确的模块解析路径，
 * 确保插件能够正确引用SDK的根目录。
 * 
 * @param {Object} params - 配置参数对象
 * @param {string} [params.cwd] - 当前工作目录，默认使用 process.cwd()
 */
export function copyPluginSdkRootAlias(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const source = resolve(cwd, "src/plugin-sdk/root-alias.cjs");
  const target = resolve(cwd, "dist/plugin-sdk/root-alias.cjs");

  writeTextFileIfChanged(target, readFileSync(source, "utf8"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  copyPluginSdkRootAlias();
}
