import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mjs";
import { copyPluginSdkRootAlias } from "./copy-plugin-sdk-root-alias.mjs";
import {
  copyStaticExtensionAssets,
  copyStaticExtensionAssetsToRuntimeOverlay,
  listStaticExtensionAssetOutputs,
} from "./lib/static-extension-assets.mjs";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mjs";
import { writeOfficialChannelCatalog } from "./write-official-channel-catalog.mjs";

export { copyStaticExtensionAssets, listStaticExtensionAssetOutputs };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_RUNTIME_ALIAS_PATTERN = /^(?<base>.+\.(?:runtime|contract))-[A-Za-z0-9_-]+\.js$/u;
const ROOT_STABLE_RUNTIME_ALIAS_PATTERN = /^.+\.(?:runtime|contract)\.js$/u;
const ROOT_RUNTIME_IMPORT_SPECIFIER_PATTERN =
  /(["'])\.\/([^"']+\.(?:runtime|contract)-[A-Za-z0-9_-]+\.js)\1/gu;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const PLUGIN_SDK_ROOT_ALIAS_OUTPUT = "dist/plugin-sdk/root-alias.cjs";
const OFFICIAL_CHANNEL_CATALOG_OUTPUT = "dist/channel-catalog.json";
const LEGACY_ROOT_RUNTIME_COMPAT_ALIASES = [
  // v2026.4.29 dispatch lazy chunks. Package updates used to replace the
  // dist tree before the live gateway had restarted, so an already-loaded old
  // dispatch chunk could still resolve these names after the swap.
  ["abort.runtime-DX6vo4yJ.js", "abort.runtime.js"],
  ["get-reply-from-config.runtime-uABrvCZ-.js", "get-reply-from-config.runtime.js"],
  ["reply-media-paths.runtime-C5UnVaLF.js", "reply-media-paths.runtime.js"],
  ["route-reply.runtime-D4PGzijU.js", "route-reply.runtime.js"],
  ["runtime-plugins.runtime-fLHuT7Vs.js", "runtime-plugins.runtime.js"],
  ["tts.runtime-66taD50M.js", "tts.runtime.js"],
  // v2026.5.2-beta.1 dispatch lazy chunks.
  ["abort.runtime-CKviLU0L.js", "abort.runtime.js"],
  ["get-reply-from-config.runtime-BzFAggVK.js", "get-reply-from-config.runtime.js"],
  ["reply-media-paths.runtime-ZpULeITb.js", "reply-media-paths.runtime.js"],
  ["route-reply.runtime-uzaOjbd1.js", "route-reply.runtime.js"],
  ["runtime-plugins.runtime-CNAfmQRG.js", "runtime-plugins.runtime.js"],
  ["tts.runtime-D-THXDsp.js", "tts.runtime.js"],
  // v2026.5.2 -> v2026.5.3-beta.3 gateway shutdown chunks. The running
  // gateway may resolve these only after an npm package tree replacement.
  ["server-close-DsVPJDIx.js", "server-close.runtime.js"],
  ["server-close-DvAvfgr8.js", "server-close.runtime.js"],
  // v2026.5.12-beta.8 gateway shutdown hook chunks.
  ["hook-runner-global-B8rMIo8I.js", "plugins/hook-runner-global.js"],
  // v2026.5.3 beta reply-dispatch lazy chunks.
  ["provider-dispatcher-6EQEtc-t.js", "provider-dispatcher.runtime.js"],
  ["provider-dispatcher-BpL2E92x.js", "provider-dispatcher.runtime.js"],
  ["provider-dispatcher-JG96SkLX.js", "provider-dispatcher.runtime.js"],
  // v2026.5.4 tool/control-plane lazy chunks. These predate the stable
  // nested dist entries, but live gateways may still import them after update.
  ["manager-DzRWrKSA.js", "acp/control-plane/manager.js"],
  ["runtime-CeGN4XUC.js", "web-fetch/runtime.js"],
];
const LEGACY_PLUGIN_INSTALL_RUNTIME_MARKERS = [
  "scanPackageInstallSource",
  "scanFileInstallSource",
  "scanInstalledPackageDependencyTree",
  "scanBundleInstallSource",
];
const PLUGIN_INSTALL_RUNTIME_ALIAS = {
  aliasFileName: "install.runtime.js",
  sourceIncludes: LEGACY_PLUGIN_INSTALL_RUNTIME_MARKERS,
};
const LEGACY_PLUGIN_INSTALL_RUNTIME_COMPAT_ALIASES = [
  // Published releases from v2026.3.22 onward. Older updaters could
  // overlay package dist instead of swapping it, leaving old install chunks
  // that still import these hashed plugin install runtime files.
  "install.runtime-D7SL02B2.js",
  "install.runtime-Deq6Beal.js",
  "install.runtime-Eoq8y3HE.js",
  "install.runtime-DDmlaKdG.js",
  "install.runtime-ADTafpVD.js",
  "install.runtime-v8X-j3Tm.js",
  "install.runtime-BLcZ-44g.js",
  "install.runtime-vS4aFJvO.js",
  "install.runtime-Dm_c092A.js",
  "install.runtime-D_7OUvuY.js",
  "install.runtime-BLEE0OIk.js",
  "install.runtime-3LpjZbr8.js",
  "install.runtime-BrsB9OnV.js",
  "install.runtime-BEOb-kNW.js",
  "install.runtime-Cx_xphd1.js",
  "install.runtime-B-MtEMSR.js",
  "install.runtime-C-Y4HAqX.js",
  "install.runtime-j1SedTZh.js",
  "install.runtime-4zsL_8wt.js",
  "install.runtime-BhCKlLSJ.js",
  "install.runtime-tGJ0KhMF.js",
  "install.runtime-DtmATpak.js",
  "install.runtime-BzZ38ePb.js",
  "install.runtime-DwQr7nEE.js",
  "install.runtime-CEIURnUz.js",
  "install.runtime-D3EPlM0r.js",
  "install.runtime-DIlN5H3O.js",
  "install.runtime-DjcOwVH_.js",
  "install.runtime-B13jZink.js",
  "install.runtime-O8MXNrwm.js",
  "install.runtime-Bkf_VMnk.js",
  "install.runtime-QOfEzAcZ.js",
  "install.runtime-BRVACueI.js",
  "install.runtime-DX8jy7tN.js",
  "install.runtime-BdfsTamp.js",
  "install.runtime-B6OA2_P8.js",
  "install.runtime-D9cTH-C0.js",
  "install.runtime-OCJULXQo.js",
  "install.runtime-9ZXBhZSk.js",
  "install.runtime-DlL3C3t_.js",
  "install.runtime-TU-jP-TN.js",
  "install.runtime-a2FlfOSp.js",
  "install.runtime-BwuRABU1.js",
  "install.runtime-B3mZL_R2.js",
  "install.runtime-CWUzypNQ.js",
  "install.runtime-D6FSd9v2.js",
  "install.runtime-DQ-ui3nL.js",
  "install.runtime-CNHwKOIb.js",
  "install.runtime-Dzuj9tSw.js",
  "install.runtime-BuF-YAfQ.js",
  "install.runtime-Xom5hOHq.js",
  "install.runtime-tnhNR9WW.js",
].map((legacyFileName) => ({
  legacyFileName,
  aliasFileName: PLUGIN_INSTALL_RUNTIME_ALIAS.aliasFileName,
  sourceIncludes: LEGACY_PLUGIN_INSTALL_RUNTIME_MARKERS,
}));
export const LEGACY_CLI_EXIT_COMPAT_CHUNKS = [
  {
    dest: "dist/memory-state-CcqRgDZU.js",
    contents: "export function hasMemoryRuntime() {\n  return false;\n}\n",
  },
  {
    dest: "dist/memory-state-DwGdReW4.js",
    contents: "export function hasMemoryRuntime() {\n  return false;\n}\n",
  },
];

// lyc:aic v2026.5：listStaticExtensionAssetOutputs 与 copyStaticExtensionAssets 已抽到
//         scripts/lib/static-extension-assets.mjs；你原本的 JSDoc lyc 注释已迁移过去。
//         本文件改为 import 它们（见文件顶部），并新增了下面 5+ 个 list*Outputs / resolve* helper。
export function listPluginSdkRootAliasOutputs() {
  return [PLUGIN_SDK_ROOT_ALIAS_OUTPUT];
}

export function listOfficialChannelCatalogOutputs() {
  return [OFFICIAL_CHANNEL_CATALOG_OUTPUT];
}

function collectStableRootRuntimeAliasCandidates(params) {
  const distDir = params.distDir;
  const fsImpl = params.fs;
  let entries = [];
  try {
    entries = fsImpl.readdirSync(distDir, { withFileTypes: true });
  } catch {
    return new Map();
  }

  const candidatesByAlias = new Map();
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(ROOT_RUNTIME_ALIAS_PATTERN);
    if (!match?.groups?.base) {
      continue;
    }
    const aliasFileName = `${match.groups.base}.js`;
    const candidates = candidatesByAlias.get(aliasFileName) ?? [];
    candidates.push(entry.name);
    candidatesByAlias.set(aliasFileName, candidates);
  }
  return candidatesByAlias;
}

function resolveStableRootRuntimeAliasCandidate(params) {
  const { aliasFileName, candidates, distDir, fsImpl } = params;
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (aliasFileName === PLUGIN_INSTALL_RUNTIME_ALIAS.aliasFileName) {
    return resolveRootRuntimeCandidateByMarkers({
      distDir,
      fsImpl,
      aliasFileName,
      sourceIncludes: PLUGIN_INSTALL_RUNTIME_ALIAS.sourceIncludes,
    });
  }
  const candidateSet = new Set(candidates);
  const wrappers = candidates.filter((candidate) => {
    const filePath = path.join(distDir, candidate);
    let source;
    try {
      source = fsImpl.readFileSync(filePath, "utf8");
    } catch {
      return false;
    }
    return candidates.some(
      (target) =>
        target !== candidate &&
        candidateSet.has(target) &&
        source.includes(`"./${target}"`) &&
        !source.includes("\n//#region "),
    );
  });
  return wrappers.length === 1 ? wrappers[0] : null;
}

export function listStableRootRuntimeAliasOutputs(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  return [...collectStableRootRuntimeAliasCandidates({ distDir, fs: fsImpl })]
    .filter(([aliasFileName, candidates]) =>
      resolveStableRootRuntimeAliasCandidate({
        distDir,
        fsImpl,
        aliasFileName,
        candidates,
      }),
    )
    .map(([aliasFileName]) => `dist/${aliasFileName}`)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listLegacyCliExitCompatOutputs(params = {}) {
  const chunks = params.chunks ?? LEGACY_CLI_EXIT_COMPAT_CHUNKS;
  return chunks
    .map(({ dest }) => dest.replace(/\\/g, "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

export function listLegacyRootRuntimeCompatOutputs(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  return [
    ...LEGACY_ROOT_RUNTIME_COMPAT_ALIASES.map(([legacyFileName, aliasFileName]) => ({
      legacyFileName,
      aliasFileName,
    })),
    ...LEGACY_PLUGIN_INSTALL_RUNTIME_COMPAT_ALIASES,
  ]
    .filter((entry) =>
      resolveLegacyRootRuntimeCompatTarget({
        distDir,
        fsImpl,
        legacyFileName: entry.legacyFileName,
        aliasFileName: entry.aliasFileName,
        sourceIncludes: entry.sourceIncludes,
      }),
    )
    .map(({ legacyFileName }) => `dist/${legacyFileName}`)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listCoreRuntimePostBuildOutputs(params = {}) {
  return [
    ...listPluginSdkRootAliasOutputs(),
    ...listOfficialChannelCatalogOutputs(),
    ...listStableRootRuntimeAliasOutputs(params),
    ...listLegacyRootRuntimeCompatOutputs(params),
    ...listLegacyCliExitCompatOutputs(params),
  ].toSorted((left, right) => left.localeCompare(right));
}

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
  const candidatesByAlias = collectStableRootRuntimeAliasCandidates({ distDir, fs: fsImpl });

  for (const [aliasFileName, candidates] of candidatesByAlias) {
    const aliasPath = path.join(distDir, aliasFileName);
    const candidate = resolveStableRootRuntimeAliasCandidate({
      distDir,
      fsImpl,
      aliasFileName,
      candidates,
    });
    if (!candidate) {
      fsImpl.rmSync?.(aliasPath, { force: true });
      continue;
    }
    writeTextFileIfChanged(aliasPath, `export * from "./${candidate}";\n`);
  }
}

export function rewriteRootRuntimeImportsToStableAliases(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  let entries = [];
  try {
    entries = fsImpl.readdirSync(distDir, { withFileTypes: true });
  } catch {
    return;
  }

  const candidatesByAlias = new Map();
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(ROOT_RUNTIME_ALIAS_PATTERN);
    if (match?.groups?.base) {
      const aliasFileName = `${match.groups.base}.js`;
      const candidates = candidatesByAlias.get(aliasFileName) ?? [];
      candidates.push(entry.name);
      candidatesByAlias.set(aliasFileName, candidates);
    }
  }
  const runtimeAliasFiles = new Map();
  for (const [aliasFileName, candidates] of candidatesByAlias) {
    if (candidates.length === 1) {
      runtimeAliasFiles.set(candidates[0], aliasFileName);
      continue;
    }
    if (aliasFileName === PLUGIN_INSTALL_RUNTIME_ALIAS.aliasFileName) {
      const candidate = resolveRootRuntimeCandidateByMarkers({
        distDir,
        fsImpl,
        aliasFileName,
        sourceIncludes: PLUGIN_INSTALL_RUNTIME_ALIAS.sourceIncludes,
      });
      if (candidate) {
        runtimeAliasFiles.set(candidate, aliasFileName);
      }
    }
  }
  if (runtimeAliasFiles.size === 0) {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }
    if (ROOT_STABLE_RUNTIME_ALIAS_PATTERN.test(entry.name)) {
      continue;
    }
    const filePath = path.join(distDir, entry.name);
    let source;
    try {
      source = fsImpl.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const rewritten = source.replace(
      ROOT_RUNTIME_IMPORT_SPECIFIER_PATTERN,
      (specifier, quote, fileName) => {
        const aliasFileName = runtimeAliasFiles.get(fileName);
        return aliasFileName ? `${quote}./${aliasFileName}${quote}` : specifier;
      },
    );
    if (rewritten !== source) {
      writeTextFileIfChanged(filePath, rewritten);
    }
  }
}

function resolveRootRuntimeCandidateByMarkers(params) {
  if (!params.sourceIncludes?.length) {
    return null;
  }
  const match = params.aliasFileName.match(ROOT_STABLE_RUNTIME_ALIAS_PATTERN);
  if (!match) {
    return null;
  }
  const aliasBaseFileName = params.aliasFileName.replace(/\.js$/u, "");
  const hashedPattern = new RegExp(`^${escapeRegExp(aliasBaseFileName)}-[A-Za-z0-9_-]+\\.js$`, "u");
  let entries = [];
  try {
    entries = params.fsImpl.readdirSync(params.distDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !hashedPattern.test(entry.name)) {
      continue;
    }
    const candidatePath = path.join(params.distDir, entry.name);
    let source;
    try {
      source = params.fsImpl.readFileSync(candidatePath, "utf8");
    } catch {
      continue;
    }
    if (params.sourceIncludes.every((marker) => source.includes(marker))) {
      candidates.push(entry.name);
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function resolveLegacyRootRuntimeCompatTarget(params) {
  if (
    params.aliasFileName &&
    params.fsImpl.existsSync(path.join(params.distDir, params.aliasFileName))
  ) {
    return params.aliasFileName;
  }
  const match = params.legacyFileName.match(ROOT_RUNTIME_ALIAS_PATTERN);
  if (!match?.groups?.base) {
    return null;
  }
  return resolveRootRuntimeCandidateByMarkers({
    distDir: params.distDir,
    fsImpl: params.fsImpl,
    aliasFileName: `${match.groups.base}.js`,
    sourceIncludes: params.sourceIncludes,
  });
}

export function writeLegacyRootRuntimeCompatAliases(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  for (const entry of [
    ...LEGACY_ROOT_RUNTIME_COMPAT_ALIASES.map(([legacyFileName, aliasFileName]) => ({
      legacyFileName,
      aliasFileName,
    })),
    ...LEGACY_PLUGIN_INSTALL_RUNTIME_COMPAT_ALIASES,
  ]) {
    const { legacyFileName } = entry;
    const legacyPath = path.join(distDir, legacyFileName);
    if (fsImpl.existsSync(legacyPath)) {
      continue;
    }
    const targetFileName = resolveLegacyRootRuntimeCompatTarget({
      distDir,
      fsImpl,
      legacyFileName,
      aliasFileName: entry.aliasFileName,
      sourceIncludes: entry.sourceIncludes,
    });
    if (!targetFileName) {
      continue;
    }
    writeTextFileIfChanged(legacyPath, `export * from "./${targetFileName}";\n`);
  }
}

export function writeLegacyCliExitCompatChunks(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const chunks = params.chunks ?? LEGACY_CLI_EXIT_COMPAT_CHUNKS;
  for (const { dest, contents } of chunks) {
    writeTextFileIfChanged(path.join(rootDir, dest), contents);
  }
}

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
  // lyc:aic v2026.5：所有 phase 用 runPhase() 包了一层做计时（可用 OPENCLAW_RUNTIME_POSTBUILD_TIMINGS=0 关闭）。
  //         相比 4.26 多了"stable root runtime imports/aliases/legacy compat"几个 phase；
  //         原本的 stageBundledPluginRuntimeDeps 函数已被 upstream 删除（注释见 .ai_claude/orphaned-comments.md）。
  const timingsEnabled = params.timings ?? process.env.OPENCLAW_RUNTIME_POSTBUILD_TIMINGS !== "0";
  const runPhase = (label, action) => {
    const startedAt = performance.now();
    try {
      return action();
    } finally {
      if (timingsEnabled) {
        const durationMs = Math.round(performance.now() - startedAt);
        console.error(`runtime-postbuild: ${label} completed in ${durationMs}ms`);
      }
    }
  };

  // 1. 复制插件SDK根别名文件
  // 将 src/plugin-sdk/root-alias.cjs 复制到 dist/plugin-sdk/root-alias.cjs
  // 这个文件为插件SDK提供根目录别名，确保模块解析正确
  runPhase("plugin SDK root alias", () => copyPluginSdkRootAlias(params));

  // lyc: copyBundledPluginMetadata实现位置:scripts\copy-bundled-plugin-metadata.mjs
  // 2. 复制捆绑插件的元数据
  // 处理 extensions/ 目录下的插件，将它们的 openclaw.plugin.json 和 package.json
  // 复制到 dist/extensions/ 对应目录，并进行必要的重写和清理
  // 包括处理插件技能(skill)路径、重写入口点等
  runPhase("bundled plugin metadata", () => copyBundledPluginMetadata(params));

  // lyc: writeOfficialChannelCatalog实现位置:scripts\write-official-channel-catalog.mjs
  // 3. 生成官方频道目录
  // 扫描所有 extensions/ 插件，根据 package.json 中的 openclaw.channel 配置
  // 生成 dist/channel-catalog.json 文件，用于插件发现和安装
  runPhase("official channel catalog", () => writeOfficialChannelCatalog(params));

  // lyc: stageBundledPluginRuntime实现位置:scripts\stage-bundled-plugin-runtime.mjs
  // 4. 分阶段处理捆绑插件的运行时文件（原 4.26 是第 5 步）
  // 创建 dist-runtime/ 目录，将 dist/extensions/ 中的插件文件
  // 通过符号链接或复制的方式映射到运行时目录
  // 对 .js 文件进行包装以支持 ES 模块导入导出
  // lyc:aic v2026.5：4.26 中的"第 4 步 stageBundledPluginRuntimeDeps"已被 upstream 删除
  runPhase("bundled plugin runtime overlay", () => stageBundledPluginRuntime(params));

  // 5. 复制静态扩展资源
  // 将预定义的静态资源文件从源目录复制到分发目录
  // 这些文件在捆绑的扩展代码中通过源相对路径引用
  // 例如：ACPX MCP 代理、差异查看器运行时等
  // lyc:aic v2026.5：除了复制到 dist/，还多了一份"runtime overlay"副本
  runPhase("static extension assets", () => {
    const staticAssetParams = {
      rootDir: ROOT,
      ...params,
    };
    copyStaticExtensionAssets(staticAssetParams);
    copyStaticExtensionAssetsToRuntimeOverlay(staticAssetParams);
  });

  // lyc:aic v2026.5 新增的 4 个 phase：重写运行时 import / 生成稳定别名 / legacy 兼容别名 / legacy CLI exit chunk
  runPhase("stable root runtime imports", () => rewriteRootRuntimeImportsToStableAliases(params));

  // 6. 写入稳定的根运行时别名
  // 在 dist/ 目录中为带哈希的运行时文件创建不带哈希的别名文件
  // 例如：main-abc123.js -> main.js (包含 export * from "./main-abc123.js")
  // 确保运行时可以稳定地引用这些文件
  runPhase("stable root runtime aliases", () => writeStableRootRuntimeAliases(params));

  // lyc:aic v2026.5 新增：legacy 兼容别名 / legacy CLI exit chunk
  runPhase("legacy root runtime compat aliases", () => writeLegacyRootRuntimeCompatAliases(params));
  runPhase("legacy CLI exit compat chunks", () => writeLegacyCliExitCompatChunks(params));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRuntimePostBuild();
}
