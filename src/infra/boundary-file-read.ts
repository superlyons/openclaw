import fs from "node:fs";
import path from "node:path";
import {
  resolveBoundaryPath,
  resolveBoundaryPathSync,
  type ResolvedBoundaryPath,
} from "./boundary-path.js";
import type { PathAliasPolicy } from "./path-alias-guards.js";
import {
  openVerifiedFileSync,
  type SafeOpenSyncAllowedType,
  type SafeOpenSyncFailureReason,
} from "./safe-open-sync.js";

type BoundaryReadFs = Pick<
  typeof fs,
  | "closeSync"
  | "constants"
  | "fstatSync"
  | "lstatSync"
  | "openSync"
  | "readFileSync"
  | "realpathSync"
>;

export type BoundaryFileOpenFailureReason = SafeOpenSyncFailureReason | "validation";

export type BoundaryFileOpenResult =
  | { ok: true; path: string; fd: number; stat: fs.Stats; rootRealPath: string }
  | { ok: false; reason: BoundaryFileOpenFailureReason; error?: unknown };

export type OpenBoundaryFileSyncParams = {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  rootRealPath?: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: SafeOpenSyncAllowedType;
  skipLexicalRootCheck?: boolean;
  ioFs?: BoundaryReadFs;
};

export type OpenBoundaryFileParams = OpenBoundaryFileSyncParams & {
  aliasPolicy?: PathAliasPolicy;
};

type ResolvedBoundaryFilePath = {
  absolutePath: string;
  resolvedPath: string;
  rootRealPath: string;
};

export function canUseBoundaryFileOpen(ioFs: typeof fs): boolean {
  return (
    typeof ioFs.openSync === "function" &&
    typeof ioFs.closeSync === "function" &&
    typeof ioFs.fstatSync === "function" &&
    typeof ioFs.lstatSync === "function" &&
    typeof ioFs.realpathSync === "function" &&
    typeof ioFs.readFileSync === "function" &&
    typeof ioFs.constants === "object" &&
    ioFs.constants !== null
  );
}

/* lyc:
  在安全边界内读取文件
  params:
    absolutePath: 要读取的文件的绝对路径
    rootPath: 根目录（边界），确保文件在此目录内
    boundaryLabel: 边界标签，用于错误信息
    rejectHardlinks: 是否拒绝硬链接
*/
export function openBoundaryFileSync(params: OpenBoundaryFileSyncParams): BoundaryFileOpenResult {
  const ioFs = params.ioFs ?? fs;
  // lyc: 解析边界路径
  const resolved = resolveBoundaryFilePathGeneric({
    absolutePath: params.absolutePath,
    resolve: (absolutePath) =>
      resolveBoundaryPathSync({
        absolutePath,
        rootPath: params.rootPath,
        rootCanonicalPath: params.rootRealPath,
        boundaryLabel: params.boundaryLabel,
        skipLexicalRootCheck: params.skipLexicalRootCheck,
      }),
  });
  if (resolved instanceof Promise) {
    return toBoundaryValidationError(new Error("Unexpected async boundary resolution"));
  }
  return finalizeBoundaryFileOpen({
    resolved,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    allowedType: params.allowedType,
    ioFs,
  });
}

/* lyc:
  在安全边界内读取文件
*/
function openBoundaryFileResolved(params: {
  absolutePath: string;
  resolvedPath: string;
  rootRealPath: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: SafeOpenSyncAllowedType;
  ioFs: BoundaryReadFs;
}): BoundaryFileOpenResult {
  const opened = openVerifiedFileSync({
    filePath: params.absolutePath,
    resolvedPath: params.resolvedPath,
    rejectHardlinks: params.rejectHardlinks ?? true,
    maxBytes: params.maxBytes,
    allowedType: params.allowedType,
    ioFs: params.ioFs,
  });
  if (!opened.ok) {
    return opened;
  }
  return {
    ok: true,
    path: opened.path,
    fd: opened.fd,
    stat: opened.stat,
    rootRealPath: params.rootRealPath,
  };
}

// lyc: 完成边界文件读取
function finalizeBoundaryFileOpen(params: {
  resolved: ResolvedBoundaryFilePath | BoundaryFileOpenResult;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: SafeOpenSyncAllowedType;
  ioFs: BoundaryReadFs;
}): BoundaryFileOpenResult {
  // lyc: 如果resolved是BoundaryFileOpenResult, 代表已打开文件直接返回
  if ("ok" in params.resolved) {
    return params.resolved;
  }
  // lyc: 如果resolved是ResolvedBoundaryFilePath, 代表需要打开文件
  return openBoundaryFileResolved({
    absolutePath: params.resolved.absolutePath,
    resolvedPath: params.resolved.resolvedPath,
    rootRealPath: params.resolved.rootRealPath,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    allowedType: params.allowedType,
    ioFs: params.ioFs,
  });
}

export async function openBoundaryFile(
  params: OpenBoundaryFileParams,
): Promise<BoundaryFileOpenResult> {
  const ioFs = params.ioFs ?? fs;
  const maybeResolved = resolveBoundaryFilePathGeneric({
    absolutePath: params.absolutePath,
    resolve: (absolutePath) =>
      resolveBoundaryPath({
        absolutePath,
        rootPath: params.rootPath,
        rootCanonicalPath: params.rootRealPath,
        boundaryLabel: params.boundaryLabel,
        policy: params.aliasPolicy,
        skipLexicalRootCheck: params.skipLexicalRootCheck,
      }),
  });
  const resolved = maybeResolved instanceof Promise ? await maybeResolved : maybeResolved;
  return finalizeBoundaryFileOpen({
    resolved,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    allowedType: params.allowedType,
    ioFs,
  });
}

function toBoundaryValidationError(error: unknown): BoundaryFileOpenResult {
  return { ok: false, reason: "validation", error };
}

function mapResolvedBoundaryPath(
  absolutePath: string,
  resolved: ResolvedBoundaryPath,
): ResolvedBoundaryFilePath {
  return {
    absolutePath,
    resolvedPath: resolved.canonicalPath,
    rootRealPath: resolved.rootCanonicalPath,
  };
}

function resolveBoundaryFilePathGeneric(params: {
  absolutePath: string;
  resolve: (absolutePath: string) => ResolvedBoundaryPath | Promise<ResolvedBoundaryPath>;
}):
  | ResolvedBoundaryFilePath
  | BoundaryFileOpenResult
  | Promise<ResolvedBoundaryFilePath | BoundaryFileOpenResult> {
  const absolutePath = path.resolve(params.absolutePath);
  try {
    const resolved = params.resolve(absolutePath);
    if (resolved instanceof Promise) {
      return resolved
        .then((value) => mapResolvedBoundaryPath(absolutePath, value))
        .catch((error) => toBoundaryValidationError(error));
    }
    return mapResolvedBoundaryPath(absolutePath, resolved);
  } catch (error) {
    return toBoundaryValidationError(error);
  }
}
