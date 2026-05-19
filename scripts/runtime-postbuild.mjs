import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mjs";
import { copyPluginSdkRootAlias } from "./copy-plugin-sdk-root-alias.mjs";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";
import { stageBundledPluginRuntimeDeps } from "./stage-bundled-plugin-runtime-deps.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mjs";
import { writeOfficialChannelCatalog } from "./write-official-channel-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_RUNTIME_ALIAS_PATTERN = /^(?<base>.+\.(?:runtime|contract))-[A-Za-z0-9_-]+\.js$/u;

/**
 * Copy static (non-transpiled) runtime assets that are referenced by their
 * source-relative path inside bundled extension code.
 *
 * Each entry: { src: repo-root-relative source, dest: dist-relative dest }
 */
export const STATIC_EXTENSION_ASSETS = [
  // acpx MCP proxy — co-deployed alongside the acpx index bundle so that
  // `path.resolve(dirname(import.meta.url), "mcp-proxy.mjs")` resolves correctly
  // at runtime from the built ACPX extension directory.
  {
    src: "extensions/acpx/src/runtime-internals/mcp-proxy.mjs",
    dest: "dist/extensions/acpx/mcp-proxy.mjs",
  },
  // diffs viewer runtime bundle — co-deployed inside the plugin package so the
  // built bundle can resolve `./assets/viewer-runtime.js` from dist.
  {
    src: "extensions/diffs/assets/viewer-runtime.js",
    dest: "dist/extensions/diffs/assets/viewer-runtime.js",
  },
];

/** lyc
 * 获取静态扩展资源的输出路径列表
 * 
 * 此函数返回所有静态扩展资源在分发目录中的目标路径列表，
 * 路径使用正斜杠格式并按字母顺序排序。
 * 主要用于构建系统确定输出文件依赖关系。
 * 
 * @param {Object} params - 配置参数对象
 * @param {Array} [params.assets] - 静态资源列表，默认使用 STATIC_EXTENSION_ASSETS
 * @returns {string[]} 排序后的输出路径数组
 */
export function listStaticExtensionAssetOutputs(params = {}) {
  const assets = params.assets ?? STATIC_EXTENSION_ASSETS;
  return assets
    .map(({ dest }) => dest.replace(/\\/g, "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

/** lyc
 * 复制静态扩展资源文件到分发目录
 * 
 * 某些扩展在运行时需要引用特定的静态资源文件，这些文件在捆绑的扩展代码中
 * 通过源相对路径引用。此函数将这些预定义的静态资源从源目录复制到分发目录，
 * 确保运行时能够正确找到它们。
 * 
 * 当前包含的静态资源：
 * - ACPX MCP 代理 (mcp-proxy.mjs) - 用于 MCP 协议通信
 * - 差异查看器运行时 (viewer-runtime.js) - 用于显示代码差异
 * 
 * @param {Object} params - 配置参数对象
 * @param {string} [params.rootDir] - 项目根目录，默认使用 ROOT 常量
 * @param {Array} [params.assets] - 要复制的静态资源列表，默认使用 STATIC_EXTENSION_ASSETS
 * @param {Object} [params.fs] - 文件系统实现，默认使用 node:fs 模块
 * @param {Function} [params.warn] - 警告输出函数，默认使用 console.warn
 */
export function copyStaticExtensionAssets(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const assets = params.assets ?? STATIC_EXTENSION_ASSETS;
  const fsImpl = params.fs ?? fs;
  const warn = params.warn ?? console.warn;
  for (const { src, dest } of assets) {
    const srcPath = path.join(rootDir, src);
    const destPath = path.join(rootDir, dest);
    if (fsImpl.existsSync(srcPath)) {
      fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
      fsImpl.copyFileSync(srcPath, destPath);
    } else {
      warn(`[runtime-postbuild] static asset not found, skipping: ${src}`);
    }
  }
}

/** lyc
 * 为带哈希的运行时文件创建稳定的别名
 * 
 * 在构建过程中，运行时文件通常会被添加内容哈希（如 main-abc123.js）。
 * 此函数在 dist/ 目录中为这些带哈希的文件创建不带哈希的别名文件，
 * 别名文件内容为：export * from "./original-hashed-filename.js"
 * 
 * 这样可以确保运行时代码能够通过稳定的文件名引用这些模块，
 * 而不需要知道具体的哈希值。
 * 
 * @param {Object} params - 配置参数对象
 * @param {string} [params.rootDir] - 项目根目录，默认使用 ROOT 常量
 * @param {Object} [params.fs] - 文件系统实现，默认使用 node:fs 模块
 */
export function writeStableRootRuntimeAliases(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  let entries = [];
  try {
    entries = fsImpl.readdirSync(distDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(ROOT_RUNTIME_ALIAS_PATTERN);
    if (!match?.groups?.base) {
      continue;
    }
    const aliasPath = path.join(distDir, `${match.groups.base}.js`);
    writeTextFileIfChanged(aliasPath, `export * from "./${entry.name}";\n`);
  }
}

/** lyc
 * lyc: 执行运行时后构建脚本, 就是在运行时才构建的一些文件
 * 执行运行时后构建(post-build)流程
 * 
 * 此函数在构建过程完成后运行，负责处理运行时所需的额外文件和配置。
 * 它协调多个子任务来确保插件和扩展在分发目录(dist)中正确设置，
 * 以便在运行时能够正常工作。
 * 
 * @param {Object} params - 配置参数对象
 * @param {string} [params.rootDir] - 项目根目录路径，默认为当前脚本所在目录的父目录
 * @param {Object} [params.fs] - 文件系统实现，默认使用 node:fs 模块
 * @param {Function} [params.warn] - 警告输出函数，默认使用 console.warn
 * @param {Object} [params.env] - 环境变量对象，默认使用 process.env
 * @param {string} [params.cwd] - 当前工作目录，默认使用 process.cwd()
 */
export function runRuntimePostBuild(params = {}) {
  // 1. 复制插件SDK根别名文件
  // 将 src/plugin-sdk/root-alias.cjs 复制到 dist/plugin-sdk/root-alias.cjs
  // 这个文件为插件SDK提供根目录别名，确保模块解析正确
  copyPluginSdkRootAlias(params);
  // lyc: copyBundledPluginMetadata实现位置:scripts\copy-bundled-plugin-metadata.mjs
  // 2. 复制捆绑插件的元数据
  // 处理 extensions/ 目录下的插件，将它们的 openclaw.plugin.json 和 package.json 
  // 复制到 dist/extensions/ 对应目录，并进行必要的重写和清理
  // 包括处理插件技能(skill)路径、重写入口点等
  copyBundledPluginMetadata(params);
  
  // lyc: writeOfficialChannelCatalog实现位置:scripts\write-official-channel-catalog.mjs
  // 3. 生成官方频道目录
  // 扫描所有 extensions/ 插件，根据 package.json 中的 openclaw.channel 配置
  // 生成 dist/channel-catalog.json 文件，用于插件发现和安装
  writeOfficialChannelCatalog(params);
  
  // 4. 分阶段处理捆绑插件的运行时依赖
  // 为标记了 bundle.stageRuntimeDependencies=true 的插件
  // 安装或复制其运行时依赖到 dist/extensions/{plugin}/node_modules/
  // 支持从根目录 node_modules 复用已安装的依赖，或独立安装
  stageBundledPluginRuntimeDeps(params);
  
  // lyc: stageBundledPluginRuntime实现位置:scripts\stage-bundled-plugin-runtime.mjs
  // 5. 分阶段处理捆绑插件的运行时文件
  // 创建 dist-runtime/ 目录，将 dist/extensions/ 中的插件文件
  // 通过符号链接或复制的方式映射到运行时目录
  // 对 .js 文件进行包装以支持 ES 模块导入导出
  stageBundledPluginRuntime(params);
  
  // 6. 写入稳定的根运行时别名
  // 在 dist/ 目录中为带哈希的运行时文件创建不带哈希的别名文件
  // 例如：main-abc123.js -> main.js (包含 export * from "./main-abc123.js")
  // 确保运行时可以稳定地引用这些文件
  writeStableRootRuntimeAliases(params);
  
  // 7. 复制静态扩展资源
  // 将预定义的静态资源文件从源目录复制到分发目录
  // 这些文件在捆绑的扩展代码中通过源相对路径引用
  // 例如：ACPX MCP 代理、差异查看器运行时等
  copyStaticExtensionAssets(params);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRuntimePostBuild();
}
