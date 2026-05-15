import fs from "node:fs";
import path from "node:path";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import { detectBundleManifestFormat, loadBundleManifest } from "./bundle-manifest.js";
import { resolvePackagedBundledLoadPathAlias } from "./bundled-load-path-aliases.js";
import { listBundledSourceOverlayDirs } from "./bundled-source-overlays.js";
import type { PluginBundleFormat, PluginDiagnostic, PluginFormat } from "./manifest-types.js";
import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  getPackageManifestMetadata,
  loadPluginManifest,
  type PluginManifest,
  resolvePackageExtensionEntries,
  type OpenClawPackageManifest,
  type PackageManifest,
} from "./manifest.js";
import {
  resolvePackageRuntimeExtensionSources,
  resolvePackageSetupSource,
} from "./package-entry-resolution.js";
import { formatPosixMode, isPathInside, safeRealpathSync, safeStatSync } from "./path-safety.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { resolvePluginCacheInputs, resolvePluginSourceRoots } from "./roots.js";

const EXTENSION_EXTS = new Set([".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"]);
const SCANNED_DIRECTORY_IGNORE_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".turbo",
  ".yarn",
  ".yarn-cache",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

export type PluginCandidate = {
  idHint: string;
  source: string;
  setupSource?: string;
  rootDir: string;
  origin: PluginOrigin;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  workspaceDir?: string;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageDir?: string;
  packageManifest?: OpenClawPackageManifest;
  bundledManifest?: PluginManifest;
  bundledManifestPath?: string;
};

export type PluginDiscoveryResult = {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
};

const discoveryCache = new Map<string, { expiresAt: number; result: PluginDiscoveryResult }>();

// Keep a short cache window to collapse bursty reloads during startup flows.
const DEFAULT_DISCOVERY_CACHE_MS = 1000;

export function clearPluginDiscoveryCache(): void {
  discoveryCache.clear();
}

// lyc: 解析插件发现缓存过期时间, 从env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS 中获取
function resolveDiscoveryCacheMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS?.trim();
  if (raw === "" || raw === "0") {
    return 0;
  }
  if (!raw) {
    return DEFAULT_DISCOVERY_CACHE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_DISCOVERY_CACHE_MS;
  }
  return Math.max(0, parsed);
}

// lyc: 是否启用插件发现缓存, 从env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE 和 OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS 中判断
function shouldUseDiscoveryCache(env: NodeJS.ProcessEnv): boolean {
  const disabled = env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE?.trim();
  if (disabled) {
    return false;
  }
  return resolveDiscoveryCacheMs(env) > 0;
}

// lyc: 构建作用域发现缓存键
function buildScopedDiscoveryCacheKey(params: {
  workspaceDir?: string;
  extraPaths?: string[];
  ownershipUid?: number | null;
  env: NodeJS.ProcessEnv;
}): string {
  const { roots, loadPaths } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    loadPaths: params.extraPaths,
    env: params.env,
  });
  const workspaceKey = roots.workspace ?? "";
  const bundledRoot = roots.stock ?? "";
  const ownershipUid = params.ownershipUid ?? currentUid();
  return `scoped::${workspaceKey}::${bundledRoot}::${ownershipUid ?? "none"}::${JSON.stringify(loadPaths)}`;
}

function buildSharedDiscoveryCacheKey(params: {
  ownershipUid?: number | null;
  env: NodeJS.ProcessEnv;
}): string {
  const roots = resolvePluginSourceRoots({ env: params.env });
  const configExtensionsRoot = roots.global ?? "";
  const bundledRoot = roots.stock ?? "";
  const ownershipUid = params.ownershipUid ?? currentUid();
  return `shared::${ownershipUid ?? "none"}::${configExtensionsRoot}::${bundledRoot}`;
}

// lyc: 获取当前进程的用户ID, 优先从overrideUid中获取, 否则如果是linux系统再从process.getuid()获取
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

// lyc: 检查source是否逃逸了rootDir目录
function checkSourceEscapesRoot(params: {
  source: string;
  rootDir: string;
  realpathCache: Map<string, string>;
}): CandidateBlockIssue | null {
  const sourceRealPath = safeRealpathSync(params.source, params.realpathCache);
  const rootRealPath = safeRealpathSync(params.rootDir, params.realpathCache);
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

// lyc: 检查source和rootDir是否存在 并 具有正确的权限, 即source和rootDir: 必须存在, 不是全局可写(其它用户没有写权限), 所有者uid必须为params.uid(params.origin !== "bundled"并且提供了params.uid)
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
    let stat = safeStatSync(targetPath);
    if (!stat) {
      return {
        reason: "path_stat_failed",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
      };
    }
    /* lyc:
      0o代表八进制数, 0o777=111 111 111, 0o666=110 110 110, 0o755=111 101 101, 0o744=111 100 100
      检查指定路径targetPath（文件或目录）是否对“其他用户”（Other users，即非所有者且非同组用户）开放了“写权限”。
      stat.mode 是一个整数，不仅包含权限（如 rwx），还包含文件类型（如目录、文件、链接）和特殊位（如 setuid, sticky bit）
      stat.mode & 0o777 可以提取出权限部分: 去掉文件类型和特殊位，只保留标准的 9 位权限（所有者、组、其他 的 读/写/执行）
        例如: stat.mode = 0o721: 111 010 001 & 111 111 111 = 111 010 001 = 0o721 = modeBits
      0o002表示其他用户有写权限, 
        721: 111 010 001 & 000 000 010 = 000 000 000 = 0 === 0
        732: 111 011 010 & 000 000 010 = 000 000 010 = 2 !== 0
    */
    // lyc: 目标目录或文件的仅权限部分
    let modeBits = stat.mode & 0o777;
    // lyc: 检查目录或文件是否对其它用户开放了写权限, !== 0 代表开放了写权限 && params.origin === "bundled"
    if ((modeBits & 0o002) !== 0 && params.origin === "bundled") {
      // npm/global installs can create package-managed extension dirs without
      // directory entries in the tarball, which may widen them to 0777.
      // Tighten bundled dirs in place before applying the normal safety gate.
      // lyc: npm的全局安装可以在压缩包中没有目录条目的情况下创建由包管理的扩展目录，这可能会将这些目录的权限放宽至0777
      // lyc: 为了确保插件的正常运行，我们需要将这些目录的权限限制为0755
      try {
        // lyc: 八进制~0o022=~(000 010 010代表组用户和其他用户有写权限)=111 101 101代表组用户和其他用户没有写权限=0o755 ~是取反操作
        // lyc: modeBits = 0o777 & ~0o022 = 111 111 111 & 111 101 101 = 111 101 101 = 0o755
        // lyc: 限制目录或文件的权限为0755, 限制组用户和其他用户的写权限
        fs.chmodSync(targetPath, modeBits & ~0o022);
        const repairedStat = safeStatSync(targetPath);
        if (!repairedStat) {
          return {
            reason: "path_stat_failed",
            sourcePath: params.source,
            rootPath: params.rootDir,
            targetPath,
          };
        }
        stat = repairedStat;
        modeBits = repairedStat.mode & 0o777;
      } catch {
        // Fall through to the normal block path below when repair is not possible.
      }
    }
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
  realpathCache: Map<string, string>;
}): CandidateBlockIssue | null {
  // lyc: 检查source是否逃逸了rootDir目录
  const escaped = checkSourceEscapesRoot({
    source: params.source,
    rootDir: params.rootDir,
    realpathCache: params.realpathCache,
  });
  if (escaped) {
    return escaped;
  }
  // lyc: 检查source和rootDir是否存在并具有正确的权限
  return checkPathStatAndPermissions({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
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
  realpathCache: Map<string, string>;
}): boolean {
  // lyc: 确保插件正确
  const issue = findCandidateBlockIssue({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    ownershipUid: params.ownershipUid,
    realpathCache: params.realpathCache,
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
  if (filePath.endsWith(".d.ts")) {
    return false;
  }
  const baseName = normalizeLowercaseStringOrEmpty(path.basename(filePath));
  return (
    !baseName.includes(".test.") &&
    !baseName.includes(".live.test.") &&
    !baseName.includes(".e2e.test.")
  );
}

function shouldIgnoreScannedDirectory(dirName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(dirName);
  if (!normalized) {
    return true;
  }
  if (SCANNED_DIRECTORY_IGNORE_NAMES.has(normalized)) {
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

function resolveScannedEntryType(entry: fs.Dirent, fullPath: string): "file" | "directory" | null {
  if (entry.isFile()) {
    return "file";
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  if (!entry.isSymbolicLink()) {
    return null;
  }

  const stat = safeStatSync(fullPath);
  if (!stat) {
    return null;
  }
  if (stat.isFile()) {
    return "file";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  return null;
}

function resolvesToSameDirectory(
  left: string | undefined,
  right: string | undefined,
  realpathCache: Map<string, string>,
): boolean {
  if (!left || !right) {
    return false;
  }
  const leftRealPath = safeRealpathSync(left, realpathCache);
  const rightRealPath = safeRealpathSync(right, realpathCache);
  if (leftRealPath && rightRealPath) {
    return leftRealPath === rightRealPath;
  }
  return path.resolve(left) === path.resolve(right);
}

function createDiscoveryResult(): PluginDiscoveryResult {
  return {
    candidates: [],
    diagnostics: [],
  };
}

function mergeDiscoveryResult(
  target: PluginDiscoveryResult,
  source: PluginDiscoveryResult,
  seenSources: Set<string>,
): void {
  for (const candidate of source.candidates) {
    const key = candidate.source;
    if (seenSources.has(key)) {
      continue;
    }
    seenSources.add(key);
    target.candidates.push(candidate);
  }
  target.diagnostics.push(...source.diagnostics);
}

// lyc: 获取以缓存的插件发现结果
function getCachedDiscoveryResult(params: {
  cacheEnabled: boolean;
  cacheKey: string;
  env: NodeJS.ProcessEnv;
  load: () => PluginDiscoveryResult;
}): PluginDiscoveryResult {
  // lyc: 解析插件发现缓存过期时间, 从env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS 中获取
  const ttl = resolveDiscoveryCacheMs(params.env);
  if (params.cacheEnabled) {
    const cached = discoveryCache.get(params.cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
  }
  const result = params.load();
  if (params.cacheEnabled && ttl > 0) {
    discoveryCache.set(params.cacheKey, { expiresAt: Date.now() + ttl, result });
  }
  return result;
}

// lyc: 读取包清单文件(dir/package.json), 并解析为 PackageManifest 类型
function readPackageManifest(
  dir: string,
  rejectHardlinks = true,
  rootRealPath?: string,
): PackageManifest | null {
  const manifestPath = path.join(dir, "package.json");
  const opened = openBoundaryFileSync({
    absolutePath: manifestPath,
    rootPath: dir,
    ...(rootRealPath !== undefined ? { rootRealPath } : {}),
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
  manifestId?: string;
  packageName?: string;
  hasMultipleExtensions: boolean;
}): string {
  const base = path.basename(params.filePath, path.extname(params.filePath));
  const rawManifestId = params.manifestId?.trim();
  if (rawManifestId) {
    return params.hasMultipleExtensions ? `${rawManifestId}/${base}` : rawManifestId;
  }
  const rawPackageName = params.packageName?.trim();
  if (!rawPackageName) {
    return base;
  }

  // Prefer the unscoped name so config keys stay stable even when the npm
  // package is scoped (example: @openclaw/voice-call -> voice-call).
  const unscoped = rawPackageName.includes("/")
    ? (rawPackageName.split("/").pop() ?? rawPackageName)
    : rawPackageName;
  const normalizedPackageId =
    unscoped.endsWith("-provider") && unscoped.length > "-provider".length
      ? unscoped.slice(0, -"-provider".length)
      : unscoped;

  if (!params.hasMultipleExtensions) {
    return normalizedPackageId;
  }
  return `${normalizedPackageId}/${base}`;
}

// lyc: 从插件清单文件中解析ID(rootDir/openclaw.plugin.json.id)
function resolveIdHintManifestId(
  rootDir: string,
  rejectHardlinks: boolean,
  rootRealPath?: string,
): string | undefined {
  const manifest = loadPluginManifest(rootDir, rejectHardlinks, rootRealPath);
  return manifest.ok ? manifest.manifest.id : undefined;
}
// lyc: 将插件添加到candidates候选名单中
function addCandidate(params: {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  idHint: string;
  source: string;
  setupSource?: string;
  rootDir: string;
  origin: PluginOrigin;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  ownershipUid?: number | null;
  workspaceDir?: string;
  // lyc: 插件的包清单文件(packageRoot/package.json)
  manifest?: PackageManifest | null;
  packageDir?: string;
  bundledManifest?: PluginManifest;
  bundledManifestPath?: string;
  realpathCache: Map<string, string>;
}) {
  const resolved = path.resolve(params.source);
  // lyc: 如果seen中已经存在resolved(params.source) 则直接返回
  if (params.seen.has(resolved)) {
    return;
  }
  const resolvedRoot =
    safeRealpathSync(params.rootDir, params.realpathCache) ?? path.resolve(params.rootDir);
  if (
    // 如果插件是不安全的(true), 则直接返回
    isUnsafePluginCandidate({
      source: resolved,
      rootDir: resolvedRoot,
      origin: params.origin,
      diagnostics: params.diagnostics,
      ownershipUid: params.ownershipUid,
      realpathCache: params.realpathCache,
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
    setupSource: params.setupSource,
    rootDir: resolvedRoot,
    origin: params.origin,
    format: params.format ?? "openclaw",
    bundleFormat: params.bundleFormat,
    workspaceDir: params.workspaceDir,
    packageName: normalizeOptionalString(manifest?.name),
    packageVersion: normalizeOptionalString(manifest?.version),
    packageDescription: normalizeOptionalString(manifest?.description),
    packageDir: params.packageDir,
    // lyc: 只返回清单原数据: manifest.openclaw部分 packageManifest
    packageManifest: getPackageManifestMetadata(manifest ?? undefined),
    bundledManifest: params.bundledManifest,
    bundledManifestPath: params.bundledManifestPath,
  });
}

// lyc: 在根目录rootDir中发现codex|cursor|claude的捆绑包,未发现返回"none", 发现并成功加入candidates候选名单时返回"added", 失败返回"invalid"
function discoverBundleInRoot(params: {
  rootDir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  realpathCache: Map<string, string>;
}): "added" | "invalid" | "none" {
  // lyc: 检测插件包的格式并返回格式名(codex|cursor|claude|null)
  const bundleFormat = detectBundleManifestFormat(params.rootDir);
  if (!bundleFormat) {
    return "none";
  }
  // lyc: rootDir的真实绝对路径
  const rootRealPath = safeRealpathSync(params.rootDir, params.realpathCache) ?? undefined;

  // lyc: 加载绑定插件的清单manifest文件, 特指codex, cursor, claude的绑定插件清单
  const bundleManifest = loadBundleManifest({
    rootDir: params.rootDir,
    ...(rootRealPath !== undefined ? { rootRealPath } : {}),
    bundleFormat,
    rejectHardlinks: params.origin !== "bundled",
  });
  if (!bundleManifest.ok) {
    params.diagnostics.push({
      level: "error",
      message: bundleManifest.error,
      source: bundleManifest.manifestPath,
    });
    return "invalid";
  }
  // lyc: 将绑定插件添加到candidates候选名单中
  addCandidate({
    candidates: params.candidates,
    diagnostics: params.diagnostics,
    seen: params.seen,
    idHint: bundleManifest.manifest.id,
    source: params.rootDir,
    rootDir: params.rootDir,
    origin: params.origin,
    format: "bundle",
    // lyc: codex|cursor|claude
    bundleFormat,
    ownershipUid: params.ownershipUid,
    workspaceDir: params.workspaceDir,
    realpathCache: params.realpathCache,
  });
  return "added";
}

// lyc: 在目录dir中发现插件, 并将其添加到candidates候选名单中
// lyc: 除了目录处理相关逻辑外(遍历,递归等), 核心功能和 discoverFromPath 相同
function discoverInDirectory(params: {
  dir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  realpathCache: Map<string, string>;
  recurseDirectories?: boolean;
  skipDirectories?: Set<string>;
  visitedDirectories?: Set<string>;
}) {
  if (!fs.existsSync(params.dir)) {
    return;
  }
  const resolvedDir =
    safeRealpathSync(params.dir, params.realpathCache) ?? path.resolve(params.dir);
  if (params.recurseDirectories) {
    if (params.visitedDirectories?.has(resolvedDir)) {
      return;
    }
    params.visitedDirectories?.add(resolvedDir);
  }
  let entries: fs.Dirent[] = [];
  try {
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
    const entryType = resolveScannedEntryType(entry, fullPath);
    if (entryType === "file") {
      if (!isExtensionFile(fullPath)) {
        continue;
      }
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
        realpathCache: params.realpathCache,
      });
      continue;
    }
    if (entryType !== "directory") {
      continue;
    }
    if (params.skipDirectories?.has(entry.name)) {
      continue;
    }
    if (shouldIgnoreScannedDirectory(entry.name)) {
      continue;
    }

    const rejectHardlinks = params.origin !== "bundled";
    const fullPathRealPath = safeRealpathSync(fullPath, params.realpathCache) ?? undefined;
    const manifest = readPackageManifest(fullPath, rejectHardlinks, fullPathRealPath);
    const extensionResolution = resolvePackageExtensionEntries(manifest ?? undefined);
    const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
    const manifestId = resolveIdHintManifestId(fullPath, rejectHardlinks, fullPathRealPath);
    const setupSource = resolvePackageSetupSource({
      packageDir: fullPath,
      ...(fullPathRealPath !== undefined ? { packageRootRealPath: fullPathRealPath } : {}),
      manifest,
      origin: params.origin,
      sourceLabel: fullPath,
      diagnostics: params.diagnostics,
      rejectHardlinks,
    });

    if (extensions.length > 0) {
      const resolvedRuntimeSources = resolvePackageRuntimeExtensionSources({
        packageDir: fullPath,
        ...(fullPathRealPath !== undefined ? { packageRootRealPath: fullPathRealPath } : {}),
        manifest,
        extensions,
        origin: params.origin,
        sourceLabel: fullPath,
        diagnostics: params.diagnostics,
        rejectHardlinks,
      });
      for (const resolved of resolvedRuntimeSources) {
        addCandidate({
          candidates: params.candidates,
          diagnostics: params.diagnostics,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: resolved,
            manifestId,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source: resolved,
          ...(setupSource ? { setupSource } : {}),
          rootDir: fullPath,
          origin: params.origin,
          ownershipUid: params.ownershipUid,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: fullPath,
          realpathCache: params.realpathCache,
        });
      }
      continue;
    }

    const bundleDiscovery = discoverBundleInRoot({
      rootDir: fullPath,
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
      realpathCache: params.realpathCache,
    });
    if (bundleDiscovery === "added") {
      continue;
    }

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
        ...(setupSource ? { setupSource } : {}),
        rootDir: fullPath,
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: fullPath,
        realpathCache: params.realpathCache,
      });
      continue;
    }

    if (params.recurseDirectories) {
      discoverInDirectory({
        ...params,
        dir: fullPath,
      });
    }
  }
}

/* lyc: 在指定的路径(rawPath)中发现插件
插件的包清单文件 | 插件包清单文件 (resolved/package.json)
插件清单文件(resolved/openclaw.plugin.json, 或 (codex|cursor|claude)-plugin/plugin.json)
rawPath = resolved = resolvedRealPath
如果rawPath是文件, 则直接添加到params.candidates候选名单中, idHint为去掉扩展名的文件名, origin=params.origin, format="openclaw", bundleFormat=undefined, 退出函数
如果rawPath是目录:
  manifestId: 从插件清单文件中解析ID(resolved/openclaw.plugin.json.id)
  manifest: 插件的包清单文件(resolved/package.json), 它一定在packageRoot目录下因为packageRoot是包清单文件所在目录
  如果设置了 扩展目录列表(resolved/package.json.openclaw.extensions), 将扩展添加到params.candidates候选名单中, 退出函数, 具体如下:
    根据 扩展目录列表 解析 运行时扩展入口文件路径列表(packageDir/package.json.openclaw.runtimeExtensions[]), 保证其在packageDir目录下, 并返回它的安全的路径
      将每个 运行时扩展入口文件路径 添加到params.candidates候选名单中, idHint=manifestId/当前运行时扩展入口文件去扩展名的文件名 origin=params.origin, format="openclaw", bundleFormat=undefined
    退出函数
  在根目录resolved中发现codex|cursor|claude的捆绑包, 如果发现, 则添加到params.candidates候选名单中, 退出函数
    idHint=codex|cursor|claude配置文件中的name属性, origin=params.origin, format="bundle", bundleFormat="codex|cursor|claude"
  没有发现codex|cursor|claude的捆绑包, 则在resolved目录下查找默认的插件入口文件index.ts|js|mjs|cjs
    找到入口文件, 则添加到params.candidates候选名单中, idHint=去掉扩展名的文件名, origin=params.origin, format="openclaw", bundleFormat=undefined, 退出函数
  如果在resolved目录下没有发现codex|cursor|claude的捆绑包, 也没有默认的插件入口文件, 则递归发现resolved目录下的插件, 并将其添加到candidates候选名单中
  退出函数
*/
function discoverFromPath(params: {
  rawPath: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  realpathCache: Map<string, string>;
}) {
  const resolved = resolveUserPath(params.rawPath, params.env);
  if (!fs.existsSync(resolved)) {
    params.diagnostics.push({
      level: "error",
      message: `plugin path not found: ${resolved}`,
      source: resolved,
    });
    return;
  }

  const stat = fs.statSync(resolved);
  // lyc: 如果resolved是文件, 则直接添加到candidates候选名单中, 退出函数
  if (stat.isFile()) {
    if (!isExtensionFile(resolved)) {
      params.diagnostics.push({
        level: "error",
        message: `plugin path is not a supported file: ${resolved}`,
        source: resolved,
      });
      return;
    }
    addCandidate({
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
      idHint: path.basename(resolved, path.extname(resolved)),
      source: resolved,
      rootDir: path.dirname(resolved),
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      realpathCache: params.realpathCache,
    });
    return;
  }

  if (stat.isDirectory()) {
    const rejectHardlinks = params.origin !== "bundled";
    // lyc: 返回 resolved 的真实路径, 并缓存到 realpathCache 中, resolved使用path.resolve(), 这里使用fs.realpathSync() 它们存在本质的区别
    // lyc: path.resolve() 不实际操作文件系统只是在路径字符上进行解析，不会验证路径是否存在, 不会解析符号链接, 返回解析后的绝对路径
    // lyc: fs.realpathSync() 实际会操作文件系统检查路径是否真实存在, 会解析软连接或快捷方式, 返回解析后的绝对路径
    const resolvedRealPath = safeRealpathSync(resolved, params.realpathCache) ?? undefined;
    // lyc: 读取插件的包清单文件(resolved/package.json), 并解析为 PackageManifest 类型
    // lyc: 插件的包清单文件一定在packageRoot目录下, 因为packageRoot是插件的包清单文件所在目录
    const manifest = readPackageManifest(resolved, rejectHardlinks, resolvedRealPath);
    // lyc: 从包清单文件中提取扩展目录列表(resolved/package.json.openclaw.extensions)并返回{status: "ok", entries: [extensions列表]}
    const extensionResolution = resolvePackageExtensionEntries(manifest ?? undefined);
    // lyc: 代表扩展目录列表(resolved/package.json.openclaw.extensions)
    const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
    // lyc: 从插件清单文件中解析ID(resolved/openclaw.plugin.json.id)
    const manifestId = resolveIdHintManifestId(resolved, rejectHardlinks, resolvedRealPath);
    // lyc: 解析包清单文件中的设置入口文件路径: 即 packageDir/manifest.openclaw.runtimeSetupEntry | manifest.openclaw.setupEntryPath转dist开头 的安全运行时设置入口路径
    const setupSource = resolvePackageSetupSource({
      packageDir: resolved,
      ...(resolvedRealPath !== undefined ? { packageRootRealPath: resolvedRealPath } : {}),
      manifest,
      origin: params.origin,
      sourceLabel: resolved,
      diagnostics: params.diagnostics,
      rejectHardlinks,
    });

    // lyc: 如果扩展目录列表resolved/package.json.openclaw.extensions不为空, 
    // lyc: 则解析运行时扩展入口文件路径列表resolved/package.json.openclaw.runtimeExtensions[], 并将其添加到candidates候选名单中, 退出函数
    if (extensions.length > 0) {
      // lyc: 解析包运行时扩展入口文件路径列表(packageDir/package.json.openclaw.runtimeExtensions[]), 保证其在packageDir目录下, 并返回它的安全的路径
      const resolvedRuntimeSources = resolvePackageRuntimeExtensionSources({
        packageDir: resolved,
        ...(resolvedRealPath !== undefined ? { packageRootRealPath: resolvedRealPath } : {}),
        manifest,
        extensions,
        origin: params.origin,
        sourceLabel: resolved,
        diagnostics: params.diagnostics,
        rejectHardlinks,
      });
      for (const source of resolvedRuntimeSources) {
        addCandidate({
          candidates: params.candidates,
          diagnostics: params.diagnostics,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: source,
            manifestId,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source,
          ...(setupSource ? { setupSource } : {}),
          rootDir: resolved,
          origin: params.origin,
          ownershipUid: params.ownershipUid,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: resolved,
          realpathCache: params.realpathCache,
        });
      }
      return;
    }

    // lyc: 在根目录rootDir中发现codex|cursor|claude的捆绑包,未发现返回"none", 发现并成功加入candidates候选名单时返回"added", 失败返回"invalid"
    const bundleDiscovery = discoverBundleInRoot({
      rootDir: resolved,
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
      realpathCache: params.realpathCache,
    });
    if (bundleDiscovery === "added") {
      return;
    }

    // lyc: 如果在resolved目录下没有发现codex|cursor|claude的捆绑包, 则在resolved目录下查找默认的插件入口文件index.ts|js|mjs|cjs
    const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES]
      .map((candidate) => path.join(resolved, candidate))
      .find((candidate) => fs.existsSync(candidate));

    // lyc: 如果存在默认的插件入口文件, 则将其添加到candidates候选名单中, 退出函数
    if (indexFile && isExtensionFile(indexFile)) {
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: path.basename(resolved),
        source: indexFile,
        ...(setupSource ? { setupSource } : {}),
        rootDir: resolved,
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: resolved,
        realpathCache: params.realpathCache,
      });
      return;
    }

    // lyc: 如果在resolved目录下没有发现codex|cursor|claude的捆绑包, 也没有默认的插件入口文件, 则递归发现resolved目录下的插件, 并将其添加到candidates候选名单中
    discoverInDirectory({
      dir: resolved,
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
      realpathCache: params.realpathCache,
    });
    return;
  }
}

/* lyc: 发现OpenClaw插件, 发现位置
openclaw.json.plugins.load.paths[], 
workspace/.openclaw/extensions, 
packageRoot/extensions, 
packageRoot/.../extensions, 
openclaw.json的配置目录/extensions中发现插件

roots.stock: 捆绑|内置 插件所在目录 | OpenClaw插件的捆绑根目录, 一般在 packageRoot/dist-runtime | dist | ""/extensions
从params.extraPaths(openclaw.json.plugins.load.paths[])中发现插件, 路径不在 roots.stock(OpenClaw插件的捆绑加载路径) 下
  origin="config", format="openclaw|bundle", bundleFormat=undefined | "codex|cursor|claude"
从params.workspaceDir/.openclaw/extensions中发现插件
  origin="workspace", format="openclaw|bundle", bundleFormat=undefined | "codex|cursor|claude"
从覆盖目录(packageRoot/extensions)中发现插件
  origin="bundled", format="openclaw|bundle", bundleFormat=undefined | "codex|cursor|claude"
从roots.stock(packageRoot/.../extensions)中发现插件
  origin="bundled", format="openclaw|bundle", bundleFormat=undefined | "codex|cursor|claude"
从roots.global(openclaw.json的配置目录/extensions)中发现插件
  origin="global", format="openclaw|bundle", bundleFormat=undefined | "codex|cursor|claude"
*/
export function discoverOpenClawPlugins(params: {
  workspaceDir?: string;
  // lyc: 一般为openclaw.json.plugins.load.paths中的路径
  extraPaths?: string[];
  ownershipUid?: number | null;
  cache?: boolean;
  env?: NodeJS.ProcessEnv;
}): PluginDiscoveryResult {
  const env = params.env ?? process.env;
  // lyc: 是否启用插件发现缓存
  const cacheEnabled = params.cache !== false && shouldUseDiscoveryCache(env);
  const workspaceDir = normalizeOptionalString(params.workspaceDir);
  const workspaceRoot = workspaceDir ? resolveUserPath(workspaceDir, env) : undefined;
  // lyc: 解析插件源根目录 { stock: packageRoot/.../extensions, global: openclaw的配置目录/extensions, workspace: workspaceRoot/.openclaw/extensions }
  const roots = resolvePluginSourceRoots({ workspaceDir: workspaceRoot, env });
  // lyc: 从缓存中获取作用域发现结果, 如果缓存中没有, 则从入参load()加载并缓存结果并返回
  // lyc: 即: 从params.extraPaths(不在 roots.stock(OpenClaw插件的捆绑加载路径) 中的路径)和params.workspaceDir/.openclaw/extensions中发现插件
  const scopedResult = getCachedDiscoveryResult({
    cacheEnabled,
    // lyc: 构建作用域发现缓存键
    cacheKey: buildScopedDiscoveryCacheKey({
      workspaceDir: params.workspaceDir,
      extraPaths: params.extraPaths,
      ownershipUid: params.ownershipUid,
      env,
    }),
    env,
    load: () => {
      // lyc: 创建返回结果包含{candidates候选目录: [], diagnostics诊断问题: []}
      const result = createDiscoveryResult();
      const seen = new Set<string>();
      const realpathCache = new Map<string, string>();
      // lyc: 一般为openclaw.json.plugins.load.paths中的路径
      const extra = params.extraPaths ?? [];
      for (const extraPath of extra) {
        if (typeof extraPath !== "string") {
          continue;
        }
        const trimmed = extraPath.trim();
        if (!trimmed) {
          continue;
        }
        // lyc: 解析OpenClaw插件的捆绑加载路径别名
        const bundledAlias = resolvePackagedBundledLoadPathAlias({
          bundledRoot: roots.stock,
          loadPath: resolveUserPath(trimmed, env),
        });
        // lyc: 如果loadPath在OpenClaw插件的捆绑加载路径中, 则忽略
        if (bundledAlias) {
          result.diagnostics.push({
            level: "warn",
            source: trimmed,
            // lyc: 忽略了指向OpenClaw current当前 | legacy遗留 捆绑插件目录的plugins.load.paths条目；请删除此冗余路径或运行openclaw doctor --fix
            message: `ignored plugins.load.paths entry that points at OpenClaw's ${bundledAlias.kind} bundled plugin directory; remove this redundant path or run openclaw doctor --fix`,
          });
          continue;
        }
        // lyc: 在指定的路径(loadPath = rawPath)中发现插件
        discoverFromPath({
          rawPath: trimmed,
          origin: "config",
          ownershipUid: params.ownershipUid,
          workspaceDir,
          env,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
          realpathCache,
        });
      }
      // lyc: workspaceRoot(入参workspaceDir) == OpenClaw插件的捆绑根目录(roots.stock)
      const workspaceMatchesBundledRoot = resolvesToSameDirectory(
        workspaceRoot,
        roots.stock,
        realpathCache,
      );
      // lyc: 如果workspaceRoot不是OpenClaw插件的捆绑根目录(roots.stock) 且 workspaceRoot(入参workspaceDir) 和 roots.workspace(工作空间目录/.openclaw/extensions) 有值
      // lyc: 即: params.workspaceDir/.openclaw/extensions不是OpenClaw插件的捆绑加载路径, 则在params.workspaceDir/.openclaw/extensions目录下发现插件, 并将其添加到candidates候选名单中
      if (roots.workspace && workspaceRoot && !workspaceMatchesBundledRoot) {
        // Keep workspace auto-discovery constrained to the OpenClaw extensions root.
        // Recursively scanning the full workspace treats arbitrary project folders as
        // plugin candidates and causes noisy "plugin manifest not found" validation failures.
        // lyc: 将工作区自动发现限制在OpenClaw扩展的根目录内(OpenClaw插件的捆绑根目录(roots.stock))。
        // lyc: 递归扫描整个工作区会将任意项目文件夹视为插件候选对象，从而导致“未找到插件清单”的验证失败提示。
        discoverInDirectory({
          dir: roots.workspace,
          origin: "workspace",
          ownershipUid: params.ownershipUid,
          workspaceDir: workspaceRoot,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
          realpathCache,
        });
      }
      return result;
    },
  });
  // lyc: 从缓存中获取共享发现结果, 如果缓存中没有, 则从入参load()加载并缓存结果并返回
  // lyc: 即: 从覆盖目录(packageRoot/extensions), roots.stock(packageRoot/.../extensions) 和 roots.global(openclaw的配置目录/extensions)中发现插件
  const sharedResult = getCachedDiscoveryResult({
    cacheEnabled,
    cacheKey: buildSharedDiscoveryCacheKey({
      ownershipUid: params.ownershipUid,
      env,
    }),
    env,
    load: () => {
      const result = createDiscoveryResult();
      const seen = new Set<string>();
      const realpathCache = new Map<string, string>();
      // lyc: 列出所有在挂载点上的覆盖插件目录(packageRoot/extensions/**), 覆盖插件目录基于 bundledRoot(捆绑|内置 插件所在目录) 生成即去掉dist-runtime|dist目录后的路径
      for (const sourceOverlayDir of listBundledSourceOverlayDirs({
        bundledRoot: roots.stock,
        env,
      })) {
        // lyc: 在挂载点上的覆盖插件目录中发现插件, 来代替openclaw原本的 捆绑|内置插件
        discoverFromPath({
          rawPath: sourceOverlayDir,
          origin: "bundled",
          ownershipUid: params.ownershipUid,
          workspaceDir,
          env,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
          realpathCache,
        });
        // lyc: 因为是在挂载点上的覆盖插件目录, 所以需要警告用户插件ID相同, 但是插件路径不同
        result.diagnostics.push({
          level: "warn",
          source: sourceOverlayDir,
          // lyc: 正在使用绑定挂载的内置插件源码覆盖层；该源码将覆盖同一插件 ID 对应的已打包 dist 产物
          message:
            "using bind-mounted bundled plugin source overlay; this source overrides the packaged dist bundle for the same plugin id",
        });
      }
      // lyc: 如果有 捆绑|内置 插件所在目录(roots.stock), 则递归发现捆绑插件目录下的插件, 并将其添加到candidates候选名单中
      // lyc: 注意之前先运行了 覆盖插件目录 因此这里加入的 捆绑|内置 插件 id可能重复, 即同一个插件id可能有两个候选插件
      if (roots.stock) {
        discoverInDirectory({
          dir: roots.stock,
          origin: "bundled",
          ownershipUid: params.ownershipUid,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
          realpathCache,
        });
      }
      // Keep auto-discovered global extensions behind bundled plugins.
      // Users can still intentionally override via plugins.load.paths (origin=config).
      // lyc: 如果有 openclaw的配置目录/extensions(roots.global), 则递归发现openclaw的配置目录/extensions目录下的插件, 并将其添加到candidates候选名单中
      discoverInDirectory({
        dir: roots.global,
        origin: "global",
        ownershipUid: params.ownershipUid,
        candidates: result.candidates,
        diagnostics: result.diagnostics,
        seen,
        realpathCache,
      });
      return result;
    },
  });
  const result = createDiscoveryResult();
  const seenSources = new Set<string>();
  mergeDiscoveryResult(result, scopedResult, seenSources);
  mergeDiscoveryResult(result, sharedResult, seenSources);
  return result;
}
