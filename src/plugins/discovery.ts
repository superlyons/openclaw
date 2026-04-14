import fs from "node:fs";
import path from "node:path";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  getPackageManifestMetadata,
  resolvePackageExtensionEntries,
  type OpenClawPackageManifest,
  type PackageManifest,
} from "./manifest.js";
import { formatPosixMode, isPathInside, safeRealpathSync, safeStatSync } from "./path-safety.js";
import type { PluginDiagnostic, PluginOrigin } from "./types.js";

const EXTENSION_EXTS = new Set([".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"]);

export type PluginCandidate = {
  idHint: string;
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageDir?: string;
  packageManifest?: OpenClawPackageManifest;
};

export type PluginDiscoveryResult = {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
};

// lyc: 获取当前进程的UID, 如果提供overrideUid则返回overrideUid, 如果是Windows平台则返回null
function currentUid(overrideUid?: number | null): number | null {
  if (overrideUid !== undefined) {
    return overrideUid;
  }
  if (process.platform === "win32") {
    return null;
  }
  if (typeof process.getuid !== "function") {
    return null;
  }
  return process.getuid();
}

export type CandidateBlockReason =
  | "source_escapes_root"
  | "path_stat_failed"
  | "path_world_writable"
  | "path_suspicious_ownership";

type CandidateBlockIssue = {
  reason: CandidateBlockReason;
  sourcePath: string;
  rootPath: string;
  targetPath: string;
  sourceRealPath?: string;
  rootRealPath?: string;
  modeBits?: number;
  foundUid?: number;
  expectedUid?: number;
};

// lyc: 检查源代码是否逃逸根目录, 即source是否逃逸rootDir
function checkSourceEscapesRoot(params: {
  source: string;
  rootDir: string;
}): CandidateBlockIssue | null {
  const sourceRealPath = safeRealpathSync(params.source);
  const rootRealPath = safeRealpathSync(params.rootDir);
  if (!sourceRealPath || !rootRealPath) {
    return null;
  }
  if (isPathInside(rootRealPath, sourceRealPath)) {
    return null;
  }
  return {
    reason: "source_escapes_root",
    sourcePath: params.source,
    rootPath: params.rootDir,
    targetPath: params.source,
    sourceRealPath,
    rootRealPath,
  };
}

// lyc: 检查source和rootDir是否存在并具有正确的权限, 即source和rootDir: 必须存在, 不是全局可写(其它用户没有写权限), 所有者uid必须为params.uid(params.origin !== "bundled"并且提供了params.uid)
function checkPathStatAndPermissions(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  uid: number | null;
}): CandidateBlockIssue | null {
  if (process.platform === "win32") {
    return null;
  }
  const pathsToCheck = [params.rootDir, params.source];
  const seen = new Set<string>();
  for (const targetPath of pathsToCheck) {
    const normalized = path.resolve(targetPath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const stat = safeStatSync(targetPath);
    // 目标路径,文件不存在
    if (!stat) {
      return {
        reason: "path_stat_failed",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
      };
    }
    /* lyc:
      检查指定路径targetPath（文件或目录）是否对“其他用户”（Other users，即非所有者且非同组用户）开放了“写权限”。
      stat.mode 是一个整数，不仅包含权限（如 rwx），还包含文件类型（如目录、文件、链接）和特殊位（如 setuid, sticky bit）
      stat.mode & 0o777 可以提取出权限部分: 去掉文件类型和特殊位，只保留标准的 9 位权限（所有者、组、其他 的 读/写/执行）
        例如: stat.mode = 0o721: 111 010 001 & 111 111 111 = 111 010 001 = 0o721 = modeBits
      0o002表示其他用户有写权限, 
        721: 111 010 001 & 000 000 010 = 000 000 000 = 0 === 0
        732: 111 011 010 & 000 000 010 = 000 000 010 = 2 !== 0
    */
    const modeBits = stat.mode & 0o777;
    // lyc: 检查目录或文件是否对其它用户开放了写权限, !== 0 代表开放了写权限则返回path_world_writable错误信息
    // lyc: path_world_writable(路径全局可写)错误
    if ((modeBits & 0o002) !== 0) {
      return {
        reason: "path_world_writable",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
        modeBits,
      };
    }
    // lyc: 如果目录或文件的UID者不是params.uid, 则返回path_suspicious_ownership(路径所有权可疑)错误信息
    if (
      params.origin !== "bundled" &&
      params.uid !== null &&
      typeof stat.uid === "number" &&
      stat.uid !== params.uid &&
      stat.uid !== 0
    ) {
      return {
        reason: "path_suspicious_ownership",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
        foundUid: stat.uid,
        expectedUid: params.uid,
      };
    }
  }
  return null;
}

// lyc: 确保插件正确,即sources是否逃逸rootDir, 是否存在正确的权限
function findCandidateBlockIssue(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
}): CandidateBlockIssue | null {
  // lyc: 检查源代码是否逃逸根目录, 即source是否逃逸rootDir
  const escaped = checkSourceEscapesRoot({
    source: params.source,
    rootDir: params.rootDir,
  });
  if (escaped) {
    return escaped;
  }
  // lyc: 检查source和rootDir是否存在并具有正确的权限
  return checkPathStatAndPermissions({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    // lyc: 获取当前进程的UID, 如果提供ownershipUid则返回ownershipUid, 如果是Windows平台则返回null
    uid: currentUid(params.ownershipUid),
  });
}

function formatCandidateBlockMessage(issue: CandidateBlockIssue): string {
  if (issue.reason === "source_escapes_root") {
    return `blocked plugin candidate: source escapes plugin root (${issue.sourcePath} -> ${issue.sourceRealPath}; root=${issue.rootRealPath})`;
  }
  if (issue.reason === "path_stat_failed") {
    return `blocked plugin candidate: cannot stat path (${issue.targetPath})`;
  }
  if (issue.reason === "path_world_writable") {
    return `blocked plugin candidate: world-writable path (${issue.targetPath}, mode=${formatPosixMode(issue.modeBits ?? 0)})`;
  }
  return `blocked plugin candidate: suspicious ownership (${issue.targetPath}, uid=${issue.foundUid}, expected uid=${issue.expectedUid} or root)`;
}

// lyc: 是否是不安全的候选插件, 返回true代表插件是不安全的
function isUnsafePluginCandidate(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  diagnostics: PluginDiagnostic[];
  ownershipUid?: number | null;
}): boolean {
  // lyc: 确保插件正确
  const issue = findCandidateBlockIssue({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    ownershipUid: params.ownershipUid,
  });
  // lyc: 插件正确, 即不是不安全的插件, 返回falase
  if (!issue) {
    return false;
  }
  // lyc: 插件不正确push诊断信息到diagnostics
  params.diagnostics.push({
    level: "warn",
    source: issue.targetPath,
    message: formatCandidateBlockMessage(issue),
  });
  return true;
}

// lyc: 判断filePath是否是扩展文件, 以 EXTENSION_EXTS 中的扩展名结尾, 且不是 .d.ts
// lyc: ".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"
function isExtensionFile(filePath: string): boolean {
  const ext = path.extname(filePath);
  if (!EXTENSION_EXTS.has(ext)) {
    return false;
  }
  return !filePath.endsWith(".d.ts");
}

function shouldIgnoreScannedDirectory(dirName: string): boolean {
  const normalized = dirName.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized.endsWith(".bak")) {
    return true;
  }
  if (normalized.includes(".backup-")) {
    return true;
  }
  if (normalized.includes(".disabled")) {
    return true;
  }
  return false;
}

// lyc: 在插件包的目录中读取清单(Manifest)package.json
function readPackageManifest(dir: string, rejectHardlinks = true): PackageManifest | null {
  const manifestPath = path.join(dir, "package.json");
  const opened = openBoundaryFileSync({
    absolutePath: manifestPath,
    rootPath: dir,
    boundaryLabel: "plugin package directory",
    rejectHardlinks,
  });
  if (!opened.ok) {
    return null;
  }
  try {
    const raw = fs.readFileSync(opened.fd, "utf-8");
    return JSON.parse(raw) as PackageManifest;
  } catch {
    return null;
  } finally {
    fs.closeSync(opened.fd);
  }
}

// lyc: 如果没有提供packageName则返回base(不含扩展名的文件名), 如果存在多个扩展则返回unscoped/base, 否则返回unscoped, unscoped是packageName的最后一个部分
// lyc: Exp: 可能返回: index, feishu/index, feishu
function deriveIdHint(params: {
  filePath: string;
  packageName?: string;
  hasMultipleExtensions: boolean;
}): string {
  const base = path.basename(params.filePath, path.extname(params.filePath));
  const rawPackageName = params.packageName?.trim();
  if (!rawPackageName) {
    return base;
  }

  // Prefer the unscoped name so config keys stay stable even when the npm
  // package is scoped (example: @openclaw/voice-call -> voice-call).
  const unscoped = rawPackageName.includes("/")
    ? (rawPackageName.split("/").pop() ?? rawPackageName)
    : rawPackageName;

  if (!params.hasMultipleExtensions) {
    return unscoped;
  }
  return `${unscoped}/${base}`;
}

// lyc: 将插件添加到candidates候选名单中
function addCandidate(params: {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  idHint: string;
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  manifest?: PackageManifest | null;
  packageDir?: string;
}) {
  const resolved = path.resolve(params.source);
  // lyc: 如果seen中已经存在resolved(params.source) 则直接返回
  if (params.seen.has(resolved)) {
    return;
  }
  const resolvedRoot = safeRealpathSync(params.rootDir) ?? path.resolve(params.rootDir);
  if (
    // 如果插件是不安全的(true), 则直接返回
    isUnsafePluginCandidate({
      source: resolved,
      rootDir: resolvedRoot,
      origin: params.origin,
      diagnostics: params.diagnostics,
      ownershipUid: params.ownershipUid,
    })
  ) {
    return;
  }
  // lyc: 到此代表插件是安全的
  // lyc: 将resolved(params.source) 添加到seen中防止重复处理
  params.seen.add(resolved);
  const manifest = params.manifest ?? null;
  // lyc: 将插件添加到candidates候选名单中
  params.candidates.push({
    idHint: params.idHint,
    source: resolved,
    rootDir: resolvedRoot,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    packageName: manifest?.name?.trim() || undefined,
    packageVersion: manifest?.version?.trim() || undefined,
    packageDescription: manifest?.description?.trim() || undefined,
    packageDir: params.packageDir,
    packageManifest: getPackageManifestMetadata(manifest ?? undefined),
  });
}

// lyc: packageDir/entryPath的真实绝对路径
function resolvePackageEntrySource(params: {
  packageDir: string;
  entryPath: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  const source = path.resolve(params.packageDir, params.entryPath);
  const opened = openBoundaryFileSync({
    absolutePath: source,
    rootPath: params.packageDir,
    boundaryLabel: "plugin package directory",
    rejectHardlinks: params.rejectHardlinks ?? true,
  });
  if (!opened.ok) {
    params.diagnostics.push({
      level: "error",
      message: `extension entry escapes package directory: ${params.entryPath}`,
      source: params.sourceLabel,
    });
    return null;
  }
  const safeSource = opened.path;
  fs.closeSync(opened.fd);
  return safeSource;
}

// lyc: 从目录params.dir中发现插件
function discoverInDirectory(params: {
  dir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
}) {
  if (!fs.existsSync(params.dir)) {
    return;
  }
  let entries: fs.Dirent[] = [];
  try {
    // lyc: 读目录params.dir中的所有文件
    entries = fs.readdirSync(params.dir, { withFileTypes: true });
  } catch (err) {
    params.diagnostics.push({
      level: "warn",
      message: `failed to read extensions dir: ${params.dir} (${String(err)})`,
      source: params.dir,
    });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(params.dir, entry.name);
    if (entry.isFile()) {
      if (!isExtensionFile(fullPath)) {
        continue;
      }
      // lyc: 是符合要求的扩展文件, 则添加到candidates候选名单中
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: path.basename(entry.name, path.extname(entry.name)),
        source: fullPath,
        rootDir: path.dirname(fullPath),
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
      });
    }
    if (!entry.isDirectory()) {
      continue;
    }
    if (shouldIgnoreScannedDirectory(entry.name)) {
      continue;
    }

    // 在子目录中查找插件
    const rejectHardlinks = params.origin !== "bundled";
    const manifest = readPackageManifest(fullPath, rejectHardlinks);
    const extensionResolution = resolvePackageExtensionEntries(manifest ?? undefined);
    const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];

    // lyc: 添加插件的扩展到candidates候选名单中
    if (extensions.length > 0) {
      for (const extPath of extensions) {
        const resolved = resolvePackageEntrySource({
          packageDir: fullPath,
          entryPath: extPath,
          sourceLabel: fullPath,
          diagnostics: params.diagnostics,
          rejectHardlinks,
        });
        if (!resolved) {
          continue;
        }
        addCandidate({
          candidates: params.candidates,
          diagnostics: params.diagnostics,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: resolved,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source: resolved,
          rootDir: fullPath,
          origin: params.origin,
          ownershipUid: params.ownershipUid,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: fullPath,
        });
      }
      continue;
    }

    // lyc: 添加插件的总入口文件到candidates候选名单中
    const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES]
      .map((candidate) => path.join(fullPath, candidate))
      .find((candidate) => fs.existsSync(candidate));
    if (indexFile && isExtensionFile(indexFile)) {
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: entry.name,
        source: indexFile,
        rootDir: fullPath,
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: fullPath,
      });
    }
  }
}

// lyc: 从路径(rawPath)发现插件
function discoverFromPath(params: {
  rawPath: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
}) {
  const resolved = resolveUserPath(params.rawPath);
  // lyc: 如果rawPath不存在, 将诊断信息push到diagnostics中
  if (!fs.existsSync(resolved)) {
    params.diagnostics.push({
      level: "error",
      message: `plugin path not found: ${resolved}`,
      source: resolved,
    });
    return;
  }

  const stat = fs.statSync(resolved);
  // lyc: 如果rawPath是文件, 则继续处理
  if (stat.isFile()) {
    // lyc: 如果rawPath不是扩展文件, 将诊断信息push到diagnostics
    if (!isExtensionFile(resolved)) {
      params.diagnostics.push({
        level: "error",
        message: `plugin path is not a supported file: ${resolved}`,
        source: resolved,
      });
      return;
    }
    // lyc: 将插件添加到candidates候选名单中 之后退出
    addCandidate({
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
      // lyc: 提取文件名, 并去掉扩展名作为idHint
      idHint: path.basename(resolved, path.extname(resolved)),
      source: resolved,
      rootDir: path.dirname(resolved),
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
    });
    return;
  }

  // lyc: 如果rawPath是目录, 则继续处理
  if (stat.isDirectory()) {
    // lyc: 当入参params.origin不是bundled时, 才拒绝硬链接
    const rejectHardlinks = params.origin !== "bundled";
    const manifest = readPackageManifest(resolved, rejectHardlinks);
    const extensionResolution = resolvePackageExtensionEntries(manifest ?? undefined);
    // lyc: resolved/package.json中openclaw.extensions配置的扩展文件
    const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];

    // lyc: 添加插件的扩展到candidates候选名单中
    if (extensions.length > 0) {
      for (const extPath of extensions) {
        // lyc: resolved/extPath文件的真实绝对路径
        const source = resolvePackageEntrySource({
          packageDir: resolved,
          entryPath: extPath,
          sourceLabel: resolved,
          diagnostics: params.diagnostics,
          rejectHardlinks,
        });
        if (!source) {
          continue;
        }
        addCandidate({
          candidates: params.candidates,
          diagnostics: params.diagnostics,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: source,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source,
          rootDir: resolved,
          origin: params.origin,
          ownershipUid: params.ownershipUid,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: resolved,
        });
      }
      return;
    }

    // lyc: 在resolved目录中发现插件的总入口文件(index.ts, index.js, index.mjs, index.cjs)
    const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES]
      .map((candidate) => path.join(resolved, candidate))
      .find((candidate) => fs.existsSync(candidate));

    // lyc: 添加插件到candidates候选名单中
    if (indexFile && isExtensionFile(indexFile)) {
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: path.basename(resolved),
        source: indexFile,
        rootDir: resolved,
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: resolved,
      });
      return;
    }

    // lyc: 如果在resolved目录中没有发现插件的总入口文件, 则继续处理

    // lyc: 继续处理resolved目录中的插件
    discoverInDirectory({
      dir: resolved,
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
    });
    return;
  }
}
/* lyc:
  发现 OpenClaw 插件
  从extraPaths中发现插件, origin: config
  从workspaceDir+/.openclaw/extensions目录中发现插件, origin: workspace
  从捆绑(bundled)插件目录(OPENCLAW_BUNDLED_PLUGINS_DIR或执行根目录下的extensions目录)中发现插件, origin: bundeled
  从全局配置目录((resolveConfigDir()=home目录/.openclaw)+/extensions目录)中发现插件, origin: global
  candidates: 
    插件选插件名单结构如下, 使用extraPath下discoverFromPath举例文件地址和目录地址的candidates数据的区别, discoverInDirectory也一样
    如果是文件地址
    {
        idHint: 文件名去掉扩展名,
        source: extraPath(文件地址)
        rootDir: extraPath(文件地址)去掉文件保留目录地址,
        origin: "config", 也可以是"workspace", "bundeled", "global"
        workspaceDir: undefined,
        packageName:  undefined,
        packageVersion: undefined,
        packageDescription: undefined,
        packageDir: undefined,
        packageManifest: undefined,
    }
    如果是目录
    {
        idHint: package.json.name(最后一个反斜线后的名字)+/+package.json.openclaw.extensions[i]只保留文件名 
                或 extraPath(目录地址)获取路径中最后的名字(即最终目录名)
        source: extraPath(目录地址)+package.json.openclaw.extensions[i]指定的文件 
                或 extraPath(目录地址)+index.ts|js|mjs|cjs
        rootDir: extraPath(目录地址),
        origin: "config", 也可以是"workspace", "bundeled", "global"
        workspaceDir: extraPath(目录地址),
        packageName: package.json.name,
        packageVersion: package.json..version,
        packageDescription: package.json.description,
        packageDir: extraPath(目录地址),
        packageManifest: package.json.openclaw的配置内容,
    }  
 */
export function discoverOpenClawPlugins(params: {
  workspaceDir?: string;
  extraPaths?: string[];
  ownershipUid?: number | null;
}): PluginDiscoveryResult {
  // lyc: 候选插件名单
  const candidates: PluginCandidate[] = [];
  // lyc: 插件诊断信息名单
  const diagnostics: PluginDiagnostic[] = [];
  // lyc: 已处理路径名单
  const seen = new Set<string>();
  // lyc: 工作目录
  const workspaceDir = params.workspaceDir?.trim();

  // lyc: 额外路径名单
  const extra = params.extraPaths ?? [];
  // lyc: 从额外路径名单中发现插件, origin: config
  for (const extraPath of extra) {
    if (typeof extraPath !== "string") {
      continue;
    }
    const trimmed = extraPath.trim();
    if (!trimmed) {
      continue;
    }
    // lyc: 在指定地址(trimmed)发现插件, origin: config
    discoverFromPath({
      rawPath: trimmed,
      origin: "config",
      ownershipUid: params.ownershipUid,
      workspaceDir: workspaceDir?.trim() || undefined,
      candidates,
      diagnostics,
      seen,
    });
  }

  // lyc: 从workspaceDir+/.openclaw/extensions目录中发现插件, origin: workspace
  if (workspaceDir) {
    const workspaceRoot = resolveUserPath(workspaceDir);
    // lyc: workspaceExtDirs = workspaceRoot/.openclaw/extensions
    const workspaceExtDirs = [path.join(workspaceRoot, ".openclaw", "extensions")];
    for (const dir of workspaceExtDirs) {
      // lyc: 在workspaceExtDirs中发现插件, origin: workspace
      discoverInDirectory({
        dir,
        origin: "workspace",
        ownershipUid: params.ownershipUid,
        workspaceDir: workspaceRoot,
        candidates,
        diagnostics,
        seen,
      });
    }
  }

  // lyc: 解析捆绑(bundled)插件目录, OPENCLAW_BUNDLED_PLUGINS_DIR或执行根目录下的extensions目录
  const bundledDir = resolveBundledPluginsDir();
  // lyc: 如果捆绑(bundledDir)存在, 则继续捆绑(bundledDir)中的发现插件 origin: bundeled
  if (bundledDir) {
    // lyc: 在捆绑(bundledDir)中发现插件, origin: bundeled
    discoverInDirectory({
      dir: bundledDir,
      origin: "bundled",
      ownershipUid: params.ownershipUid,
      candidates,
      diagnostics,
      seen,
    });
  }

  // Keep auto-discovered global extensions behind bundled plugins.
  // lyc: 将自动发现的全局扩展保留在已绑定的插件之后。
  // Users can still intentionally override via plugins.load.paths (origin=config).
  // lyc: 用户仍然可以通过 plugins.load.paths（origin=config）进行有意覆盖
  
  // lyc: 在全局配置目录(resolveConfigDir()=home目录/.openclaw)中的extensions目录中发现插件, 即: home目录/.openclaw/extensions, origin: global
  const globalDir = path.join(resolveConfigDir(), "extensions");
  discoverInDirectory({
    dir: globalDir,
    origin: "global",
    ownershipUid: params.ownershipUid,
    candidates,
    diagnostics,
    seen,
  });

  return { candidates, diagnostics };
}
