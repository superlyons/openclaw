import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isNotFoundPathError, isPathInside } from "./path-guards.js";

export type BoundaryPathIntent = "read" | "write" | "create" | "delete" | "stat";

export type BoundaryPathAliasPolicy = {
  allowFinalSymlinkForUnlink?: boolean;
  allowFinalHardlinkForUnlink?: boolean;
};

export const BOUNDARY_PATH_ALIAS_POLICIES = {
  strict: Object.freeze({
    allowFinalSymlinkForUnlink: false,
    allowFinalHardlinkForUnlink: false,
  }),
  unlinkTarget: Object.freeze({
    allowFinalSymlinkForUnlink: true,
    allowFinalHardlinkForUnlink: true,
  }),
} as const;

export type ResolveBoundaryPathParams = {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  intent?: BoundaryPathIntent;
  policy?: BoundaryPathAliasPolicy;
  skipLexicalRootCheck?: boolean;
  rootCanonicalPath?: string;
};

export type ResolvedBoundaryPathKind = "missing" | "file" | "directory" | "symlink" | "other";

export type ResolvedBoundaryPath = {
  absolutePath: string;
  canonicalPath: string;
  rootPath: string;
  rootCanonicalPath: string;
  relativePath: string;
  exists: boolean;
  kind: ResolvedBoundaryPathKind;
};

export async function resolveBoundaryPath(
  params: ResolveBoundaryPathParams,
): Promise<ResolvedBoundaryPath> {
  const rootPath = path.resolve(params.rootPath);
  const absolutePath = path.resolve(params.absolutePath);
  const rootCanonicalPath = params.rootCanonicalPath
    ? path.resolve(params.rootCanonicalPath)
    : await resolvePathViaExistingAncestor(rootPath);
  const context = createBoundaryResolutionContext({
    resolveParams: params,
    rootPath,
    absolutePath,
    rootCanonicalPath,
    outsideLexicalCanonicalPath: await resolveOutsideLexicalCanonicalPathAsync({
      rootPath,
      absolutePath,
    }),
  });

  const outsideResult = await resolveOutsideBoundaryPathAsync({
    boundaryLabel: params.boundaryLabel,
    context,
  });
  if (outsideResult) {
    return outsideResult;
  }

  return resolveBoundaryPathLexicalAsync({
    params,
    absolutePath: context.absolutePath,
    rootPath: context.rootPath,
    rootCanonicalPath: context.rootCanonicalPath,
  });
}

/* lyc:
  路径边界解析（Path Boundary Resolution），主要用于判断一个绝对路径是否“逃逸”出了指定的根目录边界（Root Boundary），同时处理符号链接（Symlinks）和不存在的路径段。
  这里的“界”通常指项目的根目录或沙箱边界。该函数决定了一个文件是属于当前项目（内部路径），还是位于项目之外（外部路径），并返回相应的规范化结果
  核心目的
    在构建工具（如 OpenClaw，可能是某种打包器、转译器或文件系统监控工具）中，经常需要处理文件引用。
    - 如果引用的文件在项目根目录内，我们通常希望保持其相对路径或规范化后的内部路径。
    - 如果引用的文件在项目根目录外（例如 node_modules 或系统库），我们需要识别它是“外部依赖”，可能需要特殊处理（如标记为外部化、保留绝对路径或进行符号链接解析）。  
    这个函数就是用来做这个“守门员”的。
  params:
    absolutePath: 要解析的文件的绝对路径
    rootPath: 根目录（边界），确保文件在此目录内
    boundaryLabel: 边界标签，用于错误信息
    rootCanonicalPath: 根目录的规范路径, 默认是 rootPath
    skipLexicalRootCheck: 是否跳过词法根检查, 默认是 false
  return: {
    absolutePath: context.absolutePath(params.absolutePath)
    rootPath: context.rootPath(params.rootPath)
    rootCanonicalPath: context.rootCanonicalPath(params.rootCanonicalPath 或 params.rootPath的规范路径)
    canonicalPath: context.canonicalOutsideLexicalPath(absolutePath的规范路径(outsideLexicalCanonicalPath) 或 absolutePath路径)
            内部: state.canonicalCursor: 以 rootCanonicalPath 为基础 + rootPath 到 absolutePath 的规范化路径(解析符号链接)地址
    relativePath: context.rootCanonicalPath到context.canonicalOutsideLexicalPath的相对路径
            内部: context.rootCanonicalPath 到 state.canonicalCursor 的相对路径
    exists: context.absolutePath是否存在
    kind: context.absolutePath的文件类型file|directory|symlink|other
  }
*/
export function resolveBoundaryPathSync(params: ResolveBoundaryPathParams): ResolvedBoundaryPath {
  const rootPath = path.resolve(params.rootPath);
  const absolutePath = path.resolve(params.absolutePath);
  // lyc: 确定根目录的规范路径（Canonical Path）,  rootCanonicalPath 是 rootPath的规范的路径 或 入参rootCanonicalPath
  const rootCanonicalPath = params.rootCanonicalPath
    ? path.resolve(params.rootCanonicalPath)
    : resolvePathViaExistingAncestorSync(rootPath);
  /* lyc:
  absolutePath 在 rootPath 内 或 rootCanonicalPath 在 outsideLexicalCanonicalPath(可能的值为: absolutePath的规范路径|absolutePath路径) 内部, 否则抛出异常
  context = { 
      rootPath, absolutePath, rootCanonicalPath, 
      lexicalInside = rootPath在absolutePath内部时为true否则为false
      canonicalOutsideLexicalPath = absolutePath的规范路径(outsideLexicalCanonicalPath) 或 absolutePath路径
    }
  */
  const context = createBoundaryResolutionContext({
    resolveParams: params,
    rootPath,
    absolutePath,
    rootCanonicalPath,
    /* lyc: 
      外部词法的规范路径 = 如果 absolutePath 在 rootPath 外部, 则返回absolutePath的规范路径, 在内部则返回undefined
      即只有absolutePath在rootPath外部时才会有外部词法的规范路径(outsideLexicalCanonicalPath=absolutePath的规范路径)否则为undefined
    */
    outsideLexicalCanonicalPath: resolveOutsideLexicalCanonicalPathSync({
      rootPath,
      absolutePath,
    }),
  });

  /* lyc: 解析外部边界路径, 如果路径在边界内，返回 null, 如果路径在边界外，返回外部边界路径
    边界内: absolutePath 在 rootPath 内
    边界外: rootCanonicalPath 在 canonicalPath(即 canonicalOutsideLexicalPath)内部
    context.lexicalInside = true: 在边界内
      outsideResult = null
    否则context.lexicalInside != true && rootCanonicalPath 在 canonicalPath(即 canonicalOutsideLexicalPath)内部: 边界外
    outsideResult = {
      absolutePath,
      canonicalPath = canonicalOutsideLexicalPath,
      rootPath,
      rootCanonicalPath,
      relativePath: rootCanonicalPath 到 canonicalPath 的相对路径
      exists: kind.exists, 文件是否存在
      kind: kind.kind, 类型: file|directory|symlink|other
    }
    resolveOutsideBoundaryPathSync 会验证外部路径是否真的逃逸了边界
  */
  const outsideResult = resolveOutsideBoundaryPathSync({
    boundaryLabel: params.boundaryLabel,
    context,
  });
  // lyc: 如果返回了结果，说明路径确实在边界外，直接返回
  if (outsideResult) {
    return outsideResult;
  }

  // lyc: 代表路径在边界内, 逐段解析路径，处理中间的符号链接，防止符号链接导致的边界逃逸。
  return resolveBoundaryPathLexicalSync({
    params,
    absolutePath: context.absolutePath,
    rootPath: context.rootPath,
    rootCanonicalPath: context.rootCanonicalPath,
  });
}

type LexicalTraversalState = {
  segments: string[];
  allowFinalSymlink: boolean;
  canonicalCursor: string;
  lexicalCursor: string;
  preserveFinalSymlink: boolean;
};

type BoundaryResolutionContext = {
  rootPath: string;
  absolutePath: string;
  rootCanonicalPath: string;
  lexicalInside: boolean;
  canonicalOutsideLexicalPath: string;
};

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function",
  );
}

// lyc: 获得rootPath到absolutePath的相对路径片段及相关信息
function createLexicalTraversalState(params: {
  params: ResolveBoundaryPathParams;
  rootPath: string;
  rootCanonicalPath: string;
  absolutePath: string;
}): LexicalTraversalState {
  // lyc: 计算相对路径, params.rootPath 到 params.absolutePath的相对路径
  const relative = path.relative(params.rootPath, params.absolutePath);
  /* lyc:
    segments: 相对路径的片段数组
    allowFinalSymlink: 是否允许路径中最后一个片段是最终符号链接, allowFinalSymlinkForUnlink 允许最终符号链接不进行解析(unlink)
    canonicalCursor: 规范游标(规范化后的绝对路径游标)
    lexicalCursor: 词法游标(未规范化的路径游标)
    preserveFinalSymlink: 后续处理中是否保留了路径中最后一个片段的最终符号链接, 默认是 false
  */
  return {
    segments: relative.split(path.sep).filter(Boolean),
    allowFinalSymlink: params.params.policy?.allowFinalSymlinkForUnlink === true,
    canonicalCursor: params.rootCanonicalPath,
    lexicalCursor: params.rootPath,
    preserveFinalSymlink: false,
  };
}

// lyc: 断言 rootCanonicalPath 在 candidatePath 内部, 否则抛异常
function assertLexicalCursorInsideBoundary(params: {
  params: ResolveBoundaryPathParams;
  rootCanonicalPath: string;
  absolutePath: string;
  candidatePath: string;
}): void {
  assertInsideBoundary({
    boundaryLabel: params.params.boundaryLabel,
    rootCanonicalPath: params.rootCanonicalPath,
    candidatePath: params.candidatePath,
    absolutePath: params.absolutePath,
  });
}

function applyMissingSuffixToCanonicalCursor(params: {
  state: LexicalTraversalState;
  missingFromIndex: number;
  rootCanonicalPath: string;
  params: ResolveBoundaryPathParams;
  absolutePath: string;
}): void {
  // lyc: 获取从当前不存在的路径片段开始一直到之后的所有路径片段存入missingSuffix
  const missingSuffix = params.state.segments.slice(params.missingFromIndex);
  // lyc: 将不存在的路径片段都追加到canonicalCursor后
  params.state.canonicalCursor = path.resolve(params.state.canonicalCursor, ...missingSuffix);
  // lyc: 安全检查断言 rootCanonicalPath 在 candidatePath(canonicalCursor) 内部, 否则抛异常
  // lyc: 确保即使在路径不存在的情况下，这个“假设”的路径也没有逃逸出根目录边界。
  assertLexicalCursorInsideBoundary({
    params: params.params,
    rootCanonicalPath: params.rootCanonicalPath,
    candidatePath: params.state.canonicalCursor,
    absolutePath: params.absolutePath,
  });
}

function advanceCanonicalCursorForSegment(params: {
  state: LexicalTraversalState;
  segment: string;
  rootCanonicalPath: string;
  params: ResolveBoundaryPathParams;
  absolutePath: string;
}): void {
  params.state.canonicalCursor = path.resolve(params.state.canonicalCursor, params.segment);
  assertLexicalCursorInsideBoundary({
    params: params.params,
    rootCanonicalPath: params.rootCanonicalPath,
    candidatePath: params.state.canonicalCursor,
    absolutePath: params.absolutePath,
  });
}

function finalizeLexicalResolution(params: {
  params: ResolveBoundaryPathParams;
  rootPath: string;
  rootCanonicalPath: string;
  absolutePath: string;
  state: LexicalTraversalState;
  kind: { exists: boolean; kind: ResolvedBoundaryPathKind };
}): ResolvedBoundaryPath {
  // lyc: 断言 candidatePath(canonicalCursor) 在 rootCanonicalPath 内部, 否则抛异常
  // lyc: 确保最终的 canonicalCursor 没有逃逸出根目录
  assertLexicalCursorInsideBoundary({
    params: params.params,
    rootCanonicalPath: params.rootCanonicalPath,
    candidatePath: params.state.canonicalCursor,
    absolutePath: params.absolutePath,
  });
  return buildResolvedBoundaryPath({
    absolutePath: params.absolutePath,
    canonicalPath: params.state.canonicalCursor,
    rootPath: params.rootPath,
    rootCanonicalPath: params.rootCanonicalPath,
    kind: params.kind,
  });
}

function handleLexicalLstatFailure(params: {
  error: unknown;
  state: LexicalTraversalState;
  missingFromIndex: number;
  rootCanonicalPath: string;
  resolveParams: ResolveBoundaryPathParams;
  absolutePath: string;
}): boolean {
  // lyc: 不是文件,目录不存在的错误, 则返回 false
  if (!isNotFoundPathError(params.error)) {
    return false;
  }
  // lyc: 是文件,目录不存在的错误, 则应用缺失后缀到规范化后的绝对路径游标(规范游标)
  // lyc: 这意味着路径中的某个中间目录不存在，解析器需要假设后续所有路径段都不存在，并直接将它们拼接到“规范游标”后，不再进行实际的文件系统检查。
  applyMissingSuffixToCanonicalCursor({
    state: params.state,
    missingFromIndex: params.missingFromIndex,
    rootCanonicalPath: params.rootCanonicalPath,
    params: params.resolveParams,
    absolutePath: params.absolutePath,
  });
  return true;
}

// lyc: 处理词法游标指向的文件或目录的信息读取失败
function handleLexicalStatReadFailure(params: {
  error: unknown;
  state: LexicalTraversalState;
  missingFromIndex: number;
  rootCanonicalPath: string;
  resolveParams: ResolveBoundaryPathParams;
  absolutePath: string;
}): null {
  if (
    handleLexicalLstatFailure({
      error: params.error,
      state: params.state,
      missingFromIndex: params.missingFromIndex,
      rootCanonicalPath: params.rootCanonicalPath,
      resolveParams: params.resolveParams,
      absolutePath: params.absolutePath,
    })
  ) {
    return null;
  }
  // lyc: 不是文件,目录不存在的错误(如权限不足), 则直接重新抛出错误
  throw params.error;
}

// lyc: 根据当前路径段的类型（普通文件/目录 vs 符号链接）以及是否是最后一个路径段，决定解析器的行为
function handleLexicalStatDisposition(params: {
  state: LexicalTraversalState;
  isSymbolicLink: boolean;
  segment: string;
  isLast: boolean;
  rootCanonicalPath: string;
  resolveParams: ResolveBoundaryPathParams;
  absolutePath: string;
}): "continue" | "break" | "resolve-link" {
  // lyc: 如果不是符号链接，则代表是普通文件/目录
  if (!params.isSymbolicLink) {
    // lyc: 继续下一个路径段, 将规范游标(params.state.canonicalCursor)向前移动一个段params.segment（直接拼接路径），然后返回 "continue"。
    advanceCanonicalCursorForSegment({
      state: params.state,
      segment: params.segment,
      rootCanonicalPath: params.rootCanonicalPath,
      params: params.resolveParams,
      absolutePath: params.absolutePath,
    });
    return "continue";
  }

  // lyc: 到这里代表当前一定是符号链接

  // lyc: allowFinalSymlink=true(允许最终符号链接) && params.isLast(最后一个路径段)
  // lyc: 这代表允许保留最终符号链接：这通常发生在路径的最后一个段是一个悬空的符号链接（Dangling Symlink）且策略允许时。它移动规范游标(params.state.canonicalCursor)向前移动一个段params.segment（直接拼接路径）并标记 preserveFinalSymlink，然后返回 "break" 停止遍历
  if (params.state.allowFinalSymlink && params.isLast) {
    params.state.preserveFinalSymlink = true;
    advanceCanonicalCursorForSegment({
      state: params.state,
      segment: params.segment,
      rootCanonicalPath: params.rootCanonicalPath,
      params: params.resolveParams,
      absolutePath: params.absolutePath,
    });
    return "break";
  }
  // lyc: 如果是符号链接（需要解析）：返回 "resolve-link"
  return "resolve-link";
}

// lyc: 应用符号链接解析后的结果
function applyResolvedSymlinkHop(params: {
  state: LexicalTraversalState;
  linkCanonical: string;
  rootCanonicalPath: string;
  boundaryLabel: string;
}): void {
  // lyc: 检查符号链接(linkCanonical)指向的路径是否在根目录边界内(rootCanonicalPath)。如果不在，抛出 symlinkEscapeError
  if (!isPathInside(params.rootCanonicalPath, params.linkCanonical)) {
    throw symlinkEscapeError({
      boundaryLabel: params.boundaryLabel,
      rootCanonicalPath: params.rootCanonicalPath,
      symlinkPath: params.state.lexicalCursor,
    });
  }
  // lyc: 更新游标：如果安全，将 state.canonicalCursor 和 state.lexicalCursor 都更新为符号链接指向的路径。这意味着解析器“跳”到了符号链接指向的位置，后续的路径遍历将从那里开始
  params.state.canonicalCursor = params.linkCanonical;
  params.state.lexicalCursor = params.linkCanonical;
}

function readLexicalStat(params: {
  state: LexicalTraversalState;
  missingFromIndex: number;
  rootCanonicalPath: string;
  resolveParams: ResolveBoundaryPathParams;
  absolutePath: string;
  read: (cursor: string) => fs.Stats | Promise<fs.Stats>;
}): fs.Stats | null | Promise<fs.Stats | null> {
  try {
    // lyc: 读取词法游标指向的文件或目录的信息
    const stat = params.read(params.state.lexicalCursor);
    if (isPromiseLike<fs.Stats>(stat)) {
      return Promise.resolve(stat).catch((error) =>
        handleLexicalStatReadFailure({ ...params, error }),
      );
    }
    return stat;
  } catch (error) {
    // lyc: 读取发生了错误
    return handleLexicalStatReadFailure({ ...params, error });
  }
}

function resolveAndApplySymlinkHop(params: {
  state: LexicalTraversalState;
  rootCanonicalPath: string;
  boundaryLabel: string;
  resolveLinkCanonical: (cursor: string) => string | Promise<string>;
}): void | Promise<void> {
  // lyc: 解析符号链接指向的目标路径
  const linkCanonical = params.resolveLinkCanonical(params.state.lexicalCursor);
  if (isPromiseLike<string>(linkCanonical)) {
    return Promise.resolve(linkCanonical).then((value) =>
      applyResolvedSymlinkHop({
        state: params.state,
        linkCanonical: value,
        rootCanonicalPath: params.rootCanonicalPath,
        boundaryLabel: params.boundaryLabel,
      }),
    );
  }
  // lyc: 应用符号链接解析后的结果
  applyResolvedSymlinkHop({
    state: params.state,
    linkCanonical,
    rootCanonicalPath: params.rootCanonicalPath,
    boundaryLabel: params.boundaryLabel,
  });
}

type LexicalTraversalStep = {
  idx: number;
  segment: string;
  isLast: boolean;
};

function* iterateLexicalTraversal(state: LexicalTraversalState): Iterable<LexicalTraversalStep> {
  for (let idx = 0; idx < state.segments.length; idx += 1) {
    const segment = state.segments[idx] ?? "";
    const isLast = idx === state.segments.length - 1;
    state.lexicalCursor = path.join(state.lexicalCursor, segment);
    yield { idx, segment, isLast };
  }
}

async function resolveBoundaryPathLexicalAsync(params: {
  params: ResolveBoundaryPathParams;
  absolutePath: string;
  rootPath: string;
  rootCanonicalPath: string;
}): Promise<ResolvedBoundaryPath> {
  const state = createLexicalTraversalState(params);
  const sharedStepParams = {
    state,
    rootCanonicalPath: params.rootCanonicalPath,
    resolveParams: params.params,
    absolutePath: params.absolutePath,
  };

  for (const { idx, segment, isLast } of iterateLexicalTraversal(state)) {
    const stat = await readLexicalStat({
      ...sharedStepParams,
      missingFromIndex: idx,
      read: (cursor) => fsp.lstat(cursor),
    });
    if (!stat) {
      break;
    }

    const disposition = handleLexicalStatDisposition({
      ...sharedStepParams,
      isSymbolicLink: stat.isSymbolicLink(),
      segment,
      isLast,
    });
    if (disposition === "continue") {
      continue;
    }
    if (disposition === "break") {
      break;
    }

    await resolveAndApplySymlinkHop({
      state,
      rootCanonicalPath: params.rootCanonicalPath,
      boundaryLabel: params.params.boundaryLabel,
      resolveLinkCanonical: (cursor) => resolveSymlinkHopPath(cursor),
    });
  }

  const kind = await getPathKind(params.absolutePath, state.preserveFinalSymlink);
  return finalizeLexicalResolution({
    ...params,
    state,
    kind,
  });
}

// lyc: 逐段解析路径，处理中间的符号链接，防止符号链接导致的边界逃逸。
function resolveBoundaryPathLexicalSync(params: {
  params: ResolveBoundaryPathParams;
  absolutePath: string;
  rootPath: string;
  rootCanonicalPath: string;
}): ResolvedBoundaryPath {
  // lyc: 初始化遍历状态（游标(lexicalCursor词法游标 canonicalCursor规范游标)、路径段(rootPath到absolutePath的相对路径片段), 符号链接的设置）
  const state = createLexicalTraversalState(params);
  // lyc: 逐段遍历路径
  for (let idx = 0; idx < state.segments.length; idx += 1) {
    const segment = state.segments[idx] ?? "";
    const isLast = idx === state.segments.length - 1;
    // lyc: 移动词汇游标到当前目录段
    state.lexicalCursor = path.join(state.lexicalCursor, segment);
    // lyc: 读取当前游标指向的文件状态
    const maybeStat = readLexicalStat({
      state,
      missingFromIndex: idx,
      rootCanonicalPath: params.rootCanonicalPath,
      resolveParams: params.params,
      absolutePath: params.absolutePath,
      read: (cursor) => fs.lstatSync(cursor),
    });
    if (isPromiseLike<fs.Stats | null>(maybeStat)) {
      throw new Error("Unexpected async lexical stat");
    }
    const stat = maybeStat;
    // lyc: readLexicalStat读取失败（目录或文件不存在），记录缺失后缀(存入stat.canonicalCursor)并跳出循环
    if (!stat) {
      break;
    }

    // lyc: readLexicalStat 成功读取到一个目录或文件状态后，程序需要决定下一步做什么：是继续下一个路径段，还是处理符号链接？
    // lyc: disposition 处理行为：继续下一个路径段、跳出循环、解析符号链接
    const disposition = handleLexicalStatDisposition({
      state,
      isSymbolicLink: stat.isSymbolicLink(),
      segment,
      isLast,
      rootCanonicalPath: params.rootCanonicalPath,
      resolveParams: params.params,
      absolutePath: params.absolutePath,
    });
    // lyc: 继续下一个路径段
    if (disposition === "continue") {
      continue;
    }
    if (disposition === "break") {
      break;
    }
    // lyc: 到这里代表stat是符号链接
    // lyc: 如果是符号链接，则解析符号链接指向的目标，并更新解析器的状态
    // lyc: 这里会检查符号链接是否指向了边界外
    const maybeApplied = resolveAndApplySymlinkHop({
      state,
      rootCanonicalPath: params.rootCanonicalPath,
      boundaryLabel: params.params.boundaryLabel,
      resolveLinkCanonical: (cursor) => resolveSymlinkHopPathSync(cursor),
    });
    if (isPromiseLike<void>(maybeApplied)) {
      throw new Error("Unexpected async symlink resolution");
    }
  }

  // lyc: 获取最终路径的类型（文件、目录等）: 确定最终解析出的路径是文件、目录、符号链接还是不存在。
  const kind = getPathKindSync(params.absolutePath, state.preserveFinalSymlink);
  // 构建并返回最终结果
  return finalizeLexicalResolution({
    ...params,
    state,
    kind,
  });
}

function resolveCanonicalOutsideLexicalPath(params: {
  absolutePath: string;
  outsideLexicalCanonicalPath?: string;
}): string {
  return params.outsideLexicalCanonicalPath ?? params.absolutePath;
}

/* lyc:
  构建解析所需的上下文环境，并在路径明显逃逸时抛出错误。
  创建边界路径上下文, 确保 absolutePath 在 rootPath 内或 rootCanonicalPath 在 canonicalOutsideLexicalPath(可能的值为: absolutePath的规范路径|absolutePath路径) 内部否则报错
  如果skipLexicalRootCheck!=true(不跳过词法根检查) 或 absolutePath 不在 rootPath 内 则进行词法根检查的断言
    如果提供了outsideLexicalCanonicalPath, 则rootCanonicalPath必须在其内部, 否则报错
    如果没有提供outsideLexicalCanonicalPath, 则rootCanonicalPath必须在absolutePath内部, 否则报错
*/
function createBoundaryResolutionContext(params: {
  resolveParams: ResolveBoundaryPathParams;
  rootPath: string;
  absolutePath: string;
  rootCanonicalPath: string;
  outsideLexicalCanonicalPath?: string;
}): BoundaryResolutionContext {
  // lyc: 代表是否是内部词法, 即 absolutePath 在 rootPath 内,是内部文件
  const lexicalInside = isPathInside(params.rootPath, params.absolutePath);
  // lyc: 代表外部词法的规范路径, 即优先使用 outsideLexicalCanonicalPath, 如果没有, 则使用 absolutePath
  // lyc: 一定会有外部词法的规范路径, 如果没提供则使用absolutePath否则使用提供的outsideLexicalCanonicalPath
  const canonicalOutsideLexicalPath = resolveCanonicalOutsideLexicalPath({
    absolutePath: params.absolutePath,
    outsideLexicalCanonicalPath: params.outsideLexicalCanonicalPath,
  });
  // lyc: 断言 rootCanonicalPath 在 canonicalOutsideLexicalPath 内部 或 skipLexicalRootCheck 或 lexicalInside为true 否则代表发生了逃逸则抛异常
  assertLexicalBoundaryOrCanonicalAlias({
    skipLexicalRootCheck: params.resolveParams.skipLexicalRootCheck,
    lexicalInside,
    canonicalOutsideLexicalPath,
    rootCanonicalPath: params.rootCanonicalPath,
    boundaryLabel: params.resolveParams.boundaryLabel,
    rootPath: params.rootPath,
    absolutePath: params.absolutePath,
  });
  return {
    rootPath: params.rootPath,
    absolutePath: params.absolutePath,
    rootCanonicalPath: params.rootCanonicalPath,
    lexicalInside,
    canonicalOutsideLexicalPath,
  };
}

async function resolveOutsideBoundaryPathAsync(params: {
  boundaryLabel: string;
  context: BoundaryResolutionContext;
}): Promise<ResolvedBoundaryPath | null> {
  if (params.context.lexicalInside) {
    return null;
  }
  const kind = await getPathKind(params.context.absolutePath, false);
  return buildOutsideLexicalBoundaryPath({
    boundaryLabel: params.boundaryLabel,
    rootCanonicalPath: params.context.rootCanonicalPath,
    absolutePath: params.context.absolutePath,
    canonicalOutsideLexicalPath: params.context.canonicalOutsideLexicalPath,
    rootPath: params.context.rootPath,
    kind,
  });
}

/* lyc:
  解析外部边界路径, 如果路径在边界内，返回 null, 如果路径在边界外，返回外部边界路径
*/
function resolveOutsideBoundaryPathSync(params: {
  boundaryLabel: string;
  context: BoundaryResolutionContext;
}): ResolvedBoundaryPath | null {
  if (params.context.lexicalInside) {
    return null;
  }
  // lyc: 获得absolutePath的元信息并处理返回: { exists: boolean; kind: "file" | "directory" | "symlink" | "other" }
  const kind = getPathKindSync(params.context.absolutePath, false);
  return buildOutsideLexicalBoundaryPath({
    boundaryLabel: params.boundaryLabel,
    rootCanonicalPath: params.context.rootCanonicalPath,
    absolutePath: params.context.absolutePath,
    canonicalOutsideLexicalPath: params.context.canonicalOutsideLexicalPath,
    rootPath: params.context.rootPath,
    kind,
  });
}

async function resolveOutsideLexicalCanonicalPathAsync(params: {
  rootPath: string;
  absolutePath: string;
}): Promise<string | undefined> {
  if (isPathInside(params.rootPath, params.absolutePath)) {
    return undefined;
  }
  return await resolvePathViaExistingAncestor(params.absolutePath);
}

/* lyc: 
  用于确定如果文件被判定为“外部文件”(absolutePath 不在 rootPath 内)，它应该呈现为什么样的规范路径
  如果 rootPath 在 absolutePath 内，直接返回 undefined 代表不是外部词法,
    否则根据 absolutePath 解析规范的祖先路径来代表外部词法的规范路径
*/
function resolveOutsideLexicalCanonicalPathSync(params: {
  rootPath: string;
  absolutePath: string;
}): string | undefined {
  if (isPathInside(params.rootPath, params.absolutePath)) {
    return undefined;
  }
  return resolvePathViaExistingAncestorSync(params.absolutePath);
}

/* lyc:
  构建外部边界路径
*/
function buildOutsideLexicalBoundaryPath(params: {
  boundaryLabel: string;
  rootCanonicalPath: string;
  absolutePath: string;
  canonicalOutsideLexicalPath: string;
  rootPath: string;
  kind: { exists: boolean; kind: ResolvedBoundaryPathKind };
}): ResolvedBoundaryPath {
  // lyc: 断言rootCanonicalPath在canonicalOutsideLexicalPath内部, 否则抛异常
  assertInsideBoundary({
    boundaryLabel: params.boundaryLabel,
    rootCanonicalPath: params.rootCanonicalPath,
    candidatePath: params.canonicalOutsideLexicalPath,
    absolutePath: params.absolutePath,
  });
  return buildResolvedBoundaryPath({
    absolutePath: params.absolutePath,
    canonicalPath: params.canonicalOutsideLexicalPath,
    rootPath: params.rootPath,
    rootCanonicalPath: params.rootCanonicalPath,
    kind: params.kind,
  });
}

function assertLexicalBoundaryOrCanonicalAlias(params: {
  skipLexicalRootCheck?: boolean;
  lexicalInside: boolean;
  canonicalOutsideLexicalPath: string;
  rootCanonicalPath: string;
  boundaryLabel: string;
  rootPath: string;
  absolutePath: string;
}): void {
  if (params.skipLexicalRootCheck || params.lexicalInside) {
    return;
  }
  if (isPathInside(params.rootCanonicalPath, params.canonicalOutsideLexicalPath)) {
    return;
  }
  throw pathEscapeError({
    boundaryLabel: params.boundaryLabel,
    rootPath: params.rootPath,
    absolutePath: params.absolutePath,
  });
}

// lyc: 将绝对路径(absolutePath)、规范路径(canonicalPath)、相对路径(relativePath)、存在性状态(exists,kind)等信息打包成一个标准对象返回。
function buildResolvedBoundaryPath(params: {
  absolutePath: string;
  canonicalPath: string;
  rootPath: string;
  rootCanonicalPath: string;
  kind: { exists: boolean; kind: ResolvedBoundaryPathKind };
}): ResolvedBoundaryPath {
  return {
    absolutePath: params.absolutePath,
    canonicalPath: params.canonicalPath,
    rootPath: params.rootPath,
    rootCanonicalPath: params.rootCanonicalPath,
    // lyc: 计算相对路径, rootCanonicalPath 到 canonicalPath的相对路径
    relativePath: relativeInsideRoot(params.rootCanonicalPath, params.canonicalPath),
    exists: params.kind.exists,
    kind: params.kind.kind,
  };
}

export async function resolvePathViaExistingAncestor(targetPath: string): Promise<string> {
  const normalized = path.resolve(targetPath);
  let cursor = normalized;
  const missingSuffix: string[] = [];

  while (!isFilesystemRoot(cursor) && !(await pathExists(cursor))) {
    missingSuffix.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  if (!(await pathExists(cursor))) {
    return normalized;
  }

  try {
    const resolvedAncestor = path.resolve(await fsp.realpath(cursor));
    if (missingSuffix.length === 0) {
      return resolvedAncestor;
    }
    return path.resolve(resolvedAncestor, ...missingSuffix);
  } catch {
    return normalized;
  }
}

/* lyc:
  解析规范的祖先路径; 即获取根目录的物理真实路径（解析符号链接）允许不存在的目录层级
  解析路径到最近的现有祖先目录
  在一个可能包含不存在目录层级的路径中，找到“最后一个实际存在的祖先目录”，将其解析为绝对真实路径（解决符号链接），然后重新拼上那些不存在的子路径。
  它解决了 fs.realpathSync 无法处理不存在路径 的问题，同时保留了路径末尾未创建部分的原始结构。
  path.resolve(): 只是把路径变绝对，不检查文件是否存在，也不解析符号链接（Symlink）。
  fs.realpathSync(): 会解析符号链接，返回物理真实路径。但是，如果路径中有任何一部分不存在，它会直接抛出错误。
  需求: 我们有一个路径 /a/b/c/d，其中 /a/b 存在（且 /a 是个符号链接指向 /x），但 c 和 d 还没创建。我们想要得到 /x/b/c/d（即解析了已存在部分的真实路径，保留未存在部分）。
*/
export function resolvePathViaExistingAncestorSync(targetPath: string): string {
  const normalized = path.resolve(targetPath);
  let cursor = normalized;
  const missingSuffix: string[] = [];

  /* lyc: 
    当cursor不是文件根目录("C:\\"或"/"), 且cursor指定位置不存在时
    只有当cursor是根目录 或 cursor指定的目录存在时才会退出循环
    例子:
      目标: /Link/A/B/C (假设 /Link 是符号链接指向 /Real, A 存在, B 和 C 不存在)。
      检查 /Link/A/B/C: 不存在 -> 记录 C, 光标移到 /Link/A/B.
      检查 /Link/A/B: 不存在 -> 记录 B, 光标移到 /Link/A.
      检查 /Link/A: 存在! -> 循环结束。
      此时 cursor = /Link/A, missingSuffix = ['B', 'C'].
  */
  while (!isFilesystemRoot(cursor) && !fs.existsSync(cursor)) {
    // lyc: 将cursor的文件名添加到missingSuffix的开头处
    missingSuffix.unshift(path.basename(cursor));
    // lyc: 移动到父级目录
    const parent = path.dirname(cursor);
    // lyc: 防止根目录死循环
    if (parent === cursor) {
      break;
    }
    // lyc: 移动到父级目录
    cursor = parent;
  }
  
  /* lyc:
    双重检查 (防御性编程):
    如果循环是因为到了文件系统根目录（/ 或 C:\）而退出的，且根目录都不存在（极罕见情况），直接返回原始绝对路径，放弃解析。
  */
  if (!fs.existsSync(cursor)) {
    return normalized;
  }

  /* lyc:
    关键: 因为 cursor 现在是确定存在的，所以 fs.realpathSync(cursor) 不会报错。
    它会解析符号链接。比如 /Link/A 会变成 /Real/A。
    最后，把之前记录的 ['B', 'C'] 拼回去，得到 /Real/A/B/C。
  */
  try {
    // Keep sync behavior aligned with async (`fsp.realpath`) to avoid
    // platform-specific canonical alias drift (notably on Windows).
    const resolvedAncestor = path.resolve(fs.realpathSync(cursor));
    if (missingSuffix.length === 0) {
      return resolvedAncestor;
    }
    return path.resolve(resolvedAncestor, ...missingSuffix);
  } catch {
    return normalized;
  }
}

async function getPathKind(
  absolutePath: string,
  preserveFinalSymlink: boolean,
): Promise<{ exists: boolean; kind: ResolvedBoundaryPathKind }> {
  try {
    const stat = preserveFinalSymlink
      ? await fsp.lstat(absolutePath)
      : await fsp.stat(absolutePath);
    return { exists: true, kind: toResolvedKind(stat) };
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return { exists: false, kind: "missing" };
    }
    throw error;
  }
}

function getPathKindSync(
  absolutePath: string,
  preserveFinalSymlink: boolean,
): { exists: boolean; kind: ResolvedBoundaryPathKind } {
  try {
    /* lyc:
      lstatSync 和 statSync: 同步获取文件或目录的元信息(fs.Stats), 处理‌符号链接（symbolic link）‌ 时有关键区别:
        statSync(path): 如果 path 是符号链接，则‌自动解析链接‌，返回‌目标文件或目录‌的元信息
        lstatSync(path): 如果 path 是符号链接，则‌不‌自动解析链接‌，返回‌符号链接‌的元信息
    */
    const stat = preserveFinalSymlink ? fs.lstatSync(absolutePath) : fs.statSync(absolutePath);
    return { exists: true, kind: toResolvedKind(stat) };
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return { exists: false, kind: "missing" };
    }
    throw error;
  }
}

function toResolvedKind(stat: fs.Stats): ResolvedBoundaryPathKind {
  if (stat.isFile()) {
    return "file";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  if (stat.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
}

// lyc: 计算相对路径, rootPath 到 targetPath的相对路径 
function relativeInsideRoot(rootPath: string, targetPath: string): string {
  // lyc: 计算相对路径, rootPath 到 targetPath的相对路径
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  // lyc: 如果相对路径为空或为".", 则返回空字符串, 代表rootPath == targetPath
  if (!relative || relative === ".") {
    return "";
  }
  // lyc: 如果相对路径以".."开头(代表rootPath在targetPath下一级目录) 或 相对路径为绝对路径, 则返回空字符串
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "";
  }
  return relative;
}

// lyc: 断言 candidatePath 在 rootCanonicalPath 内部, 否则抛异常
function assertInsideBoundary(params: {
  boundaryLabel: string;
  rootCanonicalPath: string;
  candidatePath: string;
  absolutePath: string;
}): void {
  if (isPathInside(params.rootCanonicalPath, params.candidatePath)) {
    return;
  }
  throw new Error(
    `Path resolves outside ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.absolutePath)}`,
  );
}

function pathEscapeError(params: {
  boundaryLabel: string;
  rootPath: string;
  absolutePath: string;
}): Error {
  return new Error(
    `Path escapes ${params.boundaryLabel} (${shortPath(params.rootPath)}): ${shortPath(params.absolutePath)}`,
  );
}

function symlinkEscapeError(params: {
  boundaryLabel: string;
  rootCanonicalPath: string;
  symlinkPath: string;
}): Error {
  return new Error(
    `Symlink escapes ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.symlinkPath)}`,
  );
}

function shortPath(value: string): string {
  const home = os.homedir();
  if (value.startsWith(home)) {
    return `~${value.slice(home.length)}`;
  }
  return value;
}

function isFilesystemRoot(candidate: string): boolean {
  // lyc: path.parse将candidate解析为对象, 其root属性表示路径的根部分(如"/", "c:\\")
  // lyc: 当且仅当 candidate 是一个“仅包含根”的绝对路径时成立‌。
  return path.parse(candidate).root === candidate;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.lstat(targetPath);
    return true;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function resolveSymlinkHopPath(symlinkPath: string): Promise<string> {
  try {
    return path.resolve(await fsp.realpath(symlinkPath));
  } catch (error) {
    if (!isNotFoundPathError(error)) {
      throw error;
    }
    const linkTarget = await fsp.readlink(symlinkPath);
    const linkAbsolute = path.resolve(path.dirname(symlinkPath), linkTarget);
    return resolvePathViaExistingAncestor(linkAbsolute);
  }
}

// lyc: 解析符号链接指向的目标路径
function resolveSymlinkHopPathSync(symlinkPath: string): string {
  try {
    // lyc: 解析符号链接指向的真实绝对路径（解析所有嵌套）
    return path.resolve(fs.realpathSync(symlinkPath));
  } catch (error) {
    // lyc: 如果不是路径未找到错误, 则抛异常
    if (!isNotFoundPathError(error)) {
      throw error;
    }
    // lyc: 到这里代表是路径未找到错误, 则解析符号链接指向的目标路径
    // lyc: 容错处理：如果 realpath 失败（通常是因为符号链接指向的文件不存在），它捕获异常，使用 fs.readlinkSync 读取原始路径，然后手动拼接并调用 resolvePathViaExistingAncestorSync 处理可能存在的祖先路径。
    const linkTarget = fs.readlinkSync(symlinkPath);
    const linkAbsolute = path.resolve(path.dirname(symlinkPath), linkTarget);
    return resolvePathViaExistingAncestorSync(linkAbsolute);
  }
}
