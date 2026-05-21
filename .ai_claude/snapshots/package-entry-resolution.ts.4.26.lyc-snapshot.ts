import fs from "node:fs";
import path from "node:path";
import {
  matchBoundaryFileOpenFailure,
  openBoundaryFile,
  openBoundaryFileSync,
} from "../infra/boundary-file-read.js";
import { resolveBoundaryPath, resolveBoundaryPathSync } from "../infra/boundary-path.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { getPackageManifestMetadata, type PackageManifest } from "./manifest.js";
import { listBuiltRuntimeEntryCandidates } from "./package-entrypoints.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

type ExtensionEntryValidation = { ok: true; exists: boolean } | { ok: false; error: string };

type RuntimeExtensionsResolution =
  | { ok: true; runtimeExtensions: string[] }
  | { ok: false; error: string };

// lyc: 运行时扩展长度不匹配错误信息
function runtimeExtensionsLengthMismatchMessage(params: {
  runtimeExtensionsLength: number;
  extensionsLength: number;
}): string {
  return (
    `package.json openclaw.runtimeExtensions length (${params.runtimeExtensionsLength}) ` +
    `must match openclaw.extensions length (${params.extensionsLength})`
  );
}

export function normalizePackageManifestStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean);
}

// lyc: 解析包运行时扩展条目(package.json.openclaw.runtimeExtensions)
export function resolvePackageRuntimeExtensionEntries(params: {
  manifest: PackageManifest | null | undefined;
  extensions: readonly string[];
}): RuntimeExtensionsResolution {
  // lyc: 从包清单文件中提取openclaw元数据(package.json.openclaw)
  const packageManifest = getPackageManifestMetadata(params.manifest ?? undefined);
  // lyc: 提取运行时扩展列表(package.json.openclaw.runtimeExtensions)
  const runtimeExtensions = normalizePackageManifestStringList(packageManifest?.runtimeExtensions);
  if (runtimeExtensions.length === 0) {
    return { ok: true, runtimeExtensions: [] };
  }
  // lyc: 配置中的运行时扩展列表长度(package.json.openclaw.runtimeExtensions)必须与扩展列表(package.json.openclaw.extensions)长度一致
  if (runtimeExtensions.length !== params.extensions.length) {
    return {
      ok: false,
      // lyc: 运行时扩展长度不匹配错误信息
      error: runtimeExtensionsLengthMismatchMessage({
        runtimeExtensionsLength: runtimeExtensions.length,
        extensionsLength: params.extensions.length,
      }),
    };
  }
  return { ok: true, runtimeExtensions };
}

async function validatePackageExtensionEntry(params: {
  packageDir: string;
  entry: string;
  label: string;
  requireExisting: boolean;
}): Promise<ExtensionEntryValidation> {
  const absolutePath = path.resolve(params.packageDir, params.entry);
  try {
    const resolved = await resolveBoundaryPath({
      absolutePath,
      rootPath: params.packageDir,
      boundaryLabel: "plugin package directory",
    });
    if (!resolved.exists) {
      return params.requireExisting
        ? { ok: false, error: `${params.label} not found: ${params.entry}` }
        : { ok: true, exists: false };
    }
  } catch {
    return {
      ok: false,
      error: `${params.label} escapes plugin directory: ${params.entry}`,
    };
  }

  const opened = await openBoundaryFile({
    absolutePath,
    rootPath: params.packageDir,
    boundaryLabel: "plugin package directory",
  });
  if (!opened.ok) {
    return matchBoundaryFileOpenFailure(opened, {
      path: () => ({ ok: false, error: `${params.label} not found: ${params.entry}` }),
      io: () => ({ ok: false, error: `${params.label} unreadable: ${params.entry}` }),
      validation: () => ({
        ok: false,
        error: `${params.label} failed plugin directory boundary checks: ${params.entry}`,
      }),
      fallback: () => ({
        ok: false,
        error: `${params.label} failed plugin directory boundary checks: ${params.entry}`,
      }),
    });
  }
  fs.closeSync(opened.fd);
  return { ok: true, exists: true };
}

export async function validatePackageExtensionEntriesForInstall(params: {
  packageDir: string;
  extensions: string[];
  manifest: PackageManifest;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const runtimeResolution = resolvePackageRuntimeExtensionEntries({
    manifest: params.manifest,
    extensions: params.extensions,
  });
  if (!runtimeResolution.ok) {
    return runtimeResolution;
  }

  for (const [index, entry] of params.extensions.entries()) {
    const sourceEntry = await validatePackageExtensionEntry({
      packageDir: params.packageDir,
      entry,
      label: "extension entry",
      requireExisting: false,
    });
    if (!sourceEntry.ok) {
      return sourceEntry;
    }

    const runtimeEntry = runtimeResolution.runtimeExtensions[index];
    if (runtimeEntry) {
      const runtimeResult = await validatePackageExtensionEntry({
        packageDir: params.packageDir,
        entry: runtimeEntry,
        label: "runtime extension entry",
        requireExisting: true,
      });
      if (!runtimeResult.ok) {
        return runtimeResult;
      }
      continue;
    }

    if (sourceEntry.exists) {
      continue;
    }

    let foundBuiltEntry = false;
    for (const builtEntry of listBuiltRuntimeEntryCandidates(entry)) {
      const builtResult = await validatePackageExtensionEntry({
        packageDir: params.packageDir,
        entry: builtEntry,
        label: "inferred runtime extension entry",
        requireExisting: false,
      });
      if (!builtResult.ok) {
        return builtResult;
      }
      if (builtResult.exists) {
        foundBuiltEntry = true;
        break;
      }
    }

    if (!foundBuiltEntry) {
      return { ok: false, error: `extension entry not found: ${entry}` };
    }
  }

  return { ok: true };
}

// lyc: 解析包入口源文件路径(packageDir/entryPath), 保证其在packageDir目录下, 并返回它的安全的路径
function resolvePackageEntrySource(params: {
  packageDir: string;
  packageRootRealPath?: string;
  entryPath: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  const source = path.resolve(params.packageDir, params.entryPath);
  const rejectHardlinks = params.rejectHardlinks ?? true;
  const candidates = [source];
  // lyc: 尝试打开absolutePath, 保证absolutePath在packageDir目录下, 并返回absolutePath的安全的路径
  const openCandidate = (absolutePath: string): string | null => {
    // lyc: 尝试打开absolutePath, 保证absolutePath在packageDir目录下
    const opened = openBoundaryFileSync({
      absolutePath,
      rootPath: params.packageDir,
      ...(params.packageRootRealPath !== undefined
        ? { rootRealPath: params.packageRootRealPath }
        : {}),
      boundaryLabel: "plugin package directory",
      rejectHardlinks,
    });
    if (!opened.ok) {
      // lyc: 根据失败原因, 添加诊断信息
      return matchBoundaryFileOpenFailure(opened, {
        path: () => null,
        io: () => {
          params.diagnostics.push({
            level: "warn",
            message: `extension entry unreadable (I/O error): ${params.entryPath}`,
            source: params.sourceLabel,
          });
          return null;
        },
        fallback: () => {
          params.diagnostics.push({
            level: "error",
            message: `extension entry escapes package directory: ${params.entryPath}`,
            source: params.sourceLabel,
          });
          return null;
        },
      });
    }
    const safeSource = opened.path;
    fs.closeSync(opened.fd);
    return safeSource;
  };
  // lyc: 如果不拒绝硬链接, 则向候选路径列表添加 构建候选路径
  if (!rejectHardlinks) {
    // lyc: 将source的扩展名替换为.js, 作为构建候选路径
    const builtCandidate = source.replace(/\.[^.]+$/u, ".js");
    if (builtCandidate !== source) {
      candidates.push(builtCandidate);
    }
  }

  for (const candidate of new Set(candidates)) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    // lyc: 尝试打开candidate, 保证candidate在packageDir目录下, 并返回candidate的安全的路径
    return openCandidate(candidate);
  }
  // lyc: 如果所有候选路径都失败, 尝试打开source, 保证source在packageDir目录下, 并返回source的安全的路径
  return openCandidate(source);
}

// lyc: 推断是否应该构造运行时设置入口文件路径, origin=config或global则需要构造运行时设置入口文件路径
function shouldInferBuiltRuntimeEntry(origin: PluginOrigin): boolean {
  return origin === "config" || origin === "global";
}

/* lyc: 解析安全的包入口文件路径(packageDir/entryPath): 解析包入口文件路径(packageDir/entryPath), 
返回: null | { relativePath: packageDir到entryPath的相对路径; existingSource?: packageDir/entryPath的安全路径 }
保证其在packageDir目录下, 不在packageDir目录内返回null
如果存在, 则返回它的相对路径(相对于packageDir目录)和它的安全的路径
如果不存在:
  但从路径上判断是在packageDir目录下, 则返回它的相对路径(相对于packageDir目录)
  否则, 则返回null
*/
function resolveSafePackageEntry(params: {
  // lyc: 包清单文件(resolved/package.json)所在的目录
  packageDir: string;
  // lyc: packageDir的绝对路径
  packageRootRealPath?: string;
  // lyc: 设置入口, 相对包清单文件(resolved/package.json)所在目录的相对路径
  entryPath: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): { relativePath: string; existingSource?: string } | null {
  // lyc: 设置入口绝对路径, 相对包清单文件(resolved/package.json)所在目录的绝对路径
  const absolutePath = path.resolve(params.packageDir, params.entryPath);
  if (fs.existsSync(absolutePath)) {
    // lyc: 解析包入口源文件路径(packageDir/entryPath), 保证其在packageDir目录下, 并返回它的安全的路径
    const existingSource = resolvePackageEntrySource({
      packageDir: params.packageDir,
      ...(params.packageRootRealPath !== undefined
        ? { packageRootRealPath: params.packageRootRealPath }
        : {}),
      entryPath: params.entryPath,
      sourceLabel: params.sourceLabel,
      diagnostics: params.diagnostics,
      rejectHardlinks: params.rejectHardlinks,
    });
    if (!existingSource) {
      return null;
    }
    return {
      relativePath: path.relative(params.packageDir, absolutePath).replace(/\\/g, "/"),
      existingSource,
    };
  }

  try {
    // lyc: 判断absolutePath是否在packageDir目录下, 不再会抛出异常
    resolveBoundaryPathSync({
      absolutePath,
      rootPath: params.packageDir,
      ...(params.packageRootRealPath !== undefined
        ? { rootCanonicalPath: params.packageRootRealPath }
        : {}),
      boundaryLabel: "plugin package directory",
    });
  } catch {
    params.diagnostics.push({
      level: "error",
      // lyc: 扩展条目逃逸出包目录: ${params.entryPath}
      message: `extension entry escapes package directory: ${params.entryPath}`,
      source: params.sourceLabel,
    });
    return null;
  }
  return { relativePath: path.relative(params.packageDir, absolutePath).replace(/\\/g, "/") };
}
// lyc: 解析确实存在的包入口源文件路径(packageDir/entryPath), 保证其在packageDir目录下, 并返回它的安全的路径
function resolveExistingPackageEntrySource(params: {
  packageDir: string;
  packageRootRealPath?: string;
  entryPath: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  const source = path.resolve(params.packageDir, params.entryPath);
  if (!fs.existsSync(source)) {
    return null;
  }
  return resolvePackageEntrySource(params);
}

// lyc: 解析包清单中的运行时设置入口源文件路径: 即 packageDir/runtimeEntryPath | entryPath转dist开头 的安全运行时设置入口路径
function resolvePackageRuntimeEntrySource(params: {
  // lyc: 包清单文件(resolved/package.json)所在的目录
  packageDir: string;
  // lyc: packageDir的绝对路径
  packageRootRealPath?: string;
  // lyc: 设置入口文件相对路径, 相对包清单文件(resolved/package.json)所在目录的相对路径
  entryPath: string;
  // lyc: 运行时设置入口文件相对路径, 相对包清单文件(resolved/package.json)所在目录的相对路径
  runtimeEntryPath?: string;
  origin: PluginOrigin;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  // lyc: 解析安全的包入口文件路径(packageDir/entryPath): 
  // safeEntry = null | { relativePath: packageDir到entryPath的相对路径; existingSource?: packageDir/entryPath的安全路径 }
   const safeEntry = resolveSafePackageEntry({
    packageDir: params.packageDir,
    ...(params.packageRootRealPath !== undefined
      ? { packageRootRealPath: params.packageRootRealPath }
      : {}),
    entryPath: params.entryPath,
    sourceLabel: params.sourceLabel,
    diagnostics: params.diagnostics,
    rejectHardlinks: params.rejectHardlinks,
  });
  if (!safeEntry) {
    return null;
  }

  // lyc: 如果有运行时设置入口文件路径, 则解析运行时设置入口文件路径(packageDir/runtimeEntryPath), 符合要求则直接返回它的安全的路径
  if (params.runtimeEntryPath) {
    // lyc: 解析运行时设置入口文件路径(packageDir/runtimeEntryPath), 保证其在packageDir目录下, 并返回它的安全的路径
    const runtimeSource = resolvePackageEntrySource({
      packageDir: params.packageDir,
      ...(params.packageRootRealPath !== undefined
        ? { packageRootRealPath: params.packageRootRealPath }
        : {}),
      entryPath: params.runtimeEntryPath,
      sourceLabel: params.sourceLabel,
      diagnostics: params.diagnostics,
      rejectHardlinks: params.rejectHardlinks,
    });
    if (runtimeSource) {
      return runtimeSource;
    }
  }

  // lyc: 推断是否应该构造运行时设置入口文件路径, origin=config或global则需要
  if (shouldInferBuiltRuntimeEntry(params.origin)) {
    // lyc: 构造运行时设置入口文件路径列表, 排除relativePath本身, 并遍历它们(packageDir/candidate), 如果有符合要求的, 则返回它的安全的路径
    for (const candidate of listBuiltRuntimeEntryCandidates(safeEntry.relativePath)) {
      const runtimeSource = resolveExistingPackageEntrySource({
        packageDir: params.packageDir,
        ...(params.packageRootRealPath !== undefined
          ? { packageRootRealPath: params.packageRootRealPath }
          : {}),
        entryPath: candidate,
        sourceLabel: params.sourceLabel,
        diagnostics: params.diagnostics,
        rejectHardlinks: params.rejectHardlinks,
      });
      if (runtimeSource) {
        return runtimeSource;
      }
    }
  }

  if (safeEntry.existingSource) {
    return safeEntry.existingSource;
  }

  // lyc: 如果所有候选路径都失败, 解析包入口源文件路径(packageDir/entryPath), 保证其在packageDir目录下, 并返回它的安全的路径
  return resolvePackageEntrySource({
    packageDir: params.packageDir,
    ...(params.packageRootRealPath !== undefined
      ? { packageRootRealPath: params.packageRootRealPath }
      : {}),
    entryPath: params.entryPath,
    sourceLabel: params.sourceLabel,
    diagnostics: params.diagnostics,
    rejectHardlinks: params.rejectHardlinks,
  });
}

// lyc: 解析包清单文件中的设置入口文件路径: 即 packageDir/manifest.openclaw.runtimeSetupEntry | manifest.openclaw.setupEntryPath转dist开头 的安全运行时设置入口路径
export function resolvePackageSetupSource(params: {
  // lyc: 包清单文件(resolved/package.json)所在的目录
  packageDir: string;
  // lyc: packageDir的绝对路径
  packageRootRealPath?: string;
  // lyc: 包清单文件(resolved/package.json)实例
  manifest: PackageManifest | null;
  origin: PluginOrigin;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  // lyc: 从包清单文件中提取包元数据(package.json.openclaw)
  const packageManifest = getPackageManifestMetadata(params.manifest ?? undefined);
  // lyc: 从包元数据中提取setupEntry设置入口文件路径(package.json.openclaw.setupEntry), 
  // lyc: 一个相对包清单文件(resolved/package.json)所在目录的相对路径,即相对于packageDir的相对路径
  const setupEntryPath = normalizeOptionalString(packageManifest?.setupEntry);
  if (!setupEntryPath) {
    return null;
  }
  // lyc: 解析包清单中的运行时设置入口源文件路径: 即 packageDir/runtimeSetupEntry | setupEntryPath转dist开头 的安全运行时设置入口路径
  return resolvePackageRuntimeEntrySource({
    packageDir: params.packageDir,
    ...(params.packageRootRealPath !== undefined
      ? { packageRootRealPath: params.packageRootRealPath }
      : {}),
    entryPath: setupEntryPath,
    runtimeEntryPath: normalizeOptionalString(packageManifest?.runtimeSetupEntry),
    origin: params.origin,
    sourceLabel: params.sourceLabel,
    diagnostics: params.diagnostics,
    rejectHardlinks: params.rejectHardlinks,
  });
}

// lyc: 解析包运行时扩展入口文件路径列表(packageDir/runtimeResolution.runtimeExtensions[]), 保证其在packageDir目录下, 并返回它的安全的路径
export function resolvePackageRuntimeExtensionSources(params: {
  packageDir: string;
  packageRootRealPath?: string;
  manifest: PackageManifest | null;
  extensions: readonly string[];
  origin: PluginOrigin;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string[] {
  // lyc: 解析包运行时扩展条目(package.json.openclaw.runtimeExtensions)
  const runtimeResolution = resolvePackageRuntimeExtensionEntries({
    manifest: params.manifest,
    extensions: params.extensions,
  });
  if (!runtimeResolution.ok) {
    params.diagnostics.push({
      level: "error",
      message: runtimeResolution.error,
      source: params.sourceLabel,
    });
    return [];
  }

  return params.extensions.flatMap((entryPath, index) => {
    // lyc: 解析运行时扩展入口文件路径(packageDir/runtimeResolution.runtimeExtensions[index])
    const source = resolvePackageRuntimeEntrySource({
      packageDir: params.packageDir,
      ...(params.packageRootRealPath !== undefined
        ? { packageRootRealPath: params.packageRootRealPath }
        : {}),
      entryPath,
      // lyc: 注意: 配置中的runtimeResolution运行时扩展列表长度(package.json.openclaw.runtimeExtensions)必须与params.extensions扩展列表(package.json.openclaw.extensions)数组索引|位置一致
      runtimeEntryPath: runtimeResolution.runtimeExtensions[index],
      origin: params.origin,
      sourceLabel: params.sourceLabel,
      diagnostics: params.diagnostics,
      rejectHardlinks: params.rejectHardlinks,
    });
    return source ? [source] : [];
  });
}
