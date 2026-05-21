/**
 * Config includes: $include directive for modular configs
 *
 * @example
 * ```json5
 * {
 *   "$include": "./base.json5",           // single file
 *   "$include": ["./a.json5", "./b.json5"] // merge multiple
 * }
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { canUseRootFileOpen, openRootFileSync } from "../infra/boundary-file-read.js";
import { isPathInside } from "../security/scan-paths.js";
import { isPlainObject } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

export const INCLUDE_KEY = "$include";
export const MAX_INCLUDE_DEPTH = 10;
export const MAX_INCLUDE_FILE_BYTES = 2 * 1024 * 1024;

// ============================================================================
// Types
// ============================================================================

export type IncludeResolver = {
  readFile: (path: string) => string;
  readFileWithGuards?: (params: IncludeFileReadParams) => string;
  parseJson: (raw: string) => unknown;
};

type IncludeFileReadParams = {
  includePath: string;
  resolvedPath: string;
  rootRealDir: string;
  ioFs?: typeof fs;
  maxBytes?: number;
};

type ResolveConfigIncludesOptions = {
  /**
   * Additional directories outside the config directory that `$include` paths
   * may resolve into. Typically populated from `OPENCLAW_INCLUDE_ROOTS`.
   * Each entry must be an absolute path; symlinks are resolved before the
   * containment check, consistent with the config-directory boundary check.
   */
  allowedRoots?: ReadonlyArray<string>;
};

type IncludeRoot = {
  rootDir: string;
  rootRealDir: string;
};

// ============================================================================
// Errors
// ============================================================================

export class ConfigIncludeError extends Error {
  constructor(
    message: string,
    public readonly includePath: string,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = "ConfigIncludeError";
  }
}

export class CircularIncludeError extends ConfigIncludeError {
  constructor(public readonly chain: string[]) {
    super(`Circular include detected: ${chain.join(" -> ")}`, chain[chain.length - 1]);
    this.name = "CircularIncludeError";
  }
}

// ============================================================================
// Utilities
// ============================================================================

/** Deep merge: arrays concatenate, objects merge recursively, primitives: source wins */
// lyc: 深度合并两个值返回: 数组拼接 或 对象递归合并 或 原始数据: 取source值
export function deepMerge(target: unknown, source: unknown): unknown {
  // lyc: 如果两个都是数组则直接拼接返回
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  // lyc: 如果两个都是纯对象则递归合并
  if (isPlainObject(target) && isPlainObject(source)) {
    // lyc: 解构赋值, 复制target到result
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      if (isBlockedObjectKey(key)) {
        continue;
      }
      /* lyc: 
      */
      result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
    }
    return result;
  }
  // lyc: 如果target或source不是纯对象则直接返回source
  return source;
}

// ============================================================================
// Include Resolver Class
// ============================================================================

class IncludeProcessor {
  private visited = new Set<string>();
  private depth = 0;
  private readonly configRoot: IncludeRoot;
  private readonly allowedRoots: ReadonlyArray<IncludeRoot>;

  constructor(
    private basePath: string,
    private resolver: IncludeResolver,
    rootDir?: string,
    allowedRoots?: ReadonlyArray<IncludeRoot>,
  ) {
    this.visited.add(path.normalize(basePath));
    const configRootDir = path.normalize(rootDir ?? path.dirname(basePath));
    this.configRoot = {
      rootDir: configRootDir,
      rootRealDir: path.normalize(safeRealpath(configRootDir)),
    };
    this.allowedRoots = allowedRoots ?? [];
  }

  private get rootDir(): string {
    return this.configRoot.rootDir;
  }

  process(obj: unknown): unknown {
    // lyc: 递归处理数组中的每个元素
    if (Array.isArray(obj)) {
      return obj.map((item) => this.process(item));
    }
    // lyc: 不是数组 && 如果不是纯对象返回

    if (!isPlainObject(obj)) {
      return obj;
    }

    // lyc: 不是数组 && 是纯对象 && 如果obj中不存在$include指令
    if (!(INCLUDE_KEY in obj)) {
      return this.processObject(obj);
    }
    // lyc: 不是数组 && 是纯对象 && obj中存在$include指令

    return this.processInclude(obj);
  }

  private processObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.process(value);
    }
    return result;
  }

  private processInclude(obj: Record<string, unknown>): unknown {
    // lyc: 返回obj的$include指令对应的值
    const includeValue = obj[INCLUDE_KEY];
    // lyc: 返回obj中除了$include指令以外的所有键
    const otherKeys = Object.keys(obj).filter((k) => k !== INCLUDE_KEY);
    // lyc: 解析$include指令对应的值
    const included = this.resolveInclude(includeValue);

    // lyc: 代表obj只有一个属性且这个属性是$include指令, 直接返回解析后的内容(代表整个obj将被$include指令的内容替换)
    if (otherKeys.length === 0) {
      return included;
    }

    // lyc: 如果解析后的内容不是纯对象: 兄弟键要求included后的内容是纯对象
    if (!isPlainObject(included)) {
      throw new ConfigIncludeError(
        "Sibling keys require included content to be an object",
        typeof includeValue === "string" ? includeValue : INCLUDE_KEY,
      );
    }

    // Merge included content with sibling keys
    // lyc: 合并included后的内容与其他兄弟键对应的内容
    const rest: Record<string, unknown> = {};
    // lyc: 递归处理其他兄弟键对应的内容
    for (const key of otherKeys) {
      rest[key] = this.process(obj[key]);
    }
    // lyc: 合并included后的内容与其他兄弟键对应的内容
    return deepMerge(included, rest);
  }

  // lyc: 解析$include指令对应的值
  private resolveInclude(value: unknown): unknown {
    // lyc: 如果是字符串则直接加载文件并返回
    if (typeof value === "string") {
      return this.loadFile(value);
    }
    // lyc: 如果是数组则递归处理数组中的每个元素并合并返回
    // lyc: 这代表数组中每个include的文件都会得到解析最后把他们合并返回, 如果有相同的键则后面的键会覆盖前面的键

    if (Array.isArray(value)) {
      return value.reduce<unknown>((merged, item) => {
        if (typeof item !== "string") {
          throw new ConfigIncludeError(
            `Invalid $include array item: expected string, got ${typeof item}`,
            String(item),
          );
        }
        return deepMerge(merged, this.loadFile(item));
      }, {});
    }

    throw new ConfigIncludeError(
      `Invalid $include value: expected string or array of strings, got ${typeof value}`,
      String(value),
    );
  }

  private loadFile(includePath: string): unknown {
    const { resolvedPath, root } = this.resolvePath(includePath);

    // lyc: 检查是否循环引用
    this.checkCircular(resolvedPath);
    // lyc: 检查是否超过最大深度
    this.checkDepth(includePath);

    // lyc: raw = 读取文件内容
    // lyc:aic v2026.5：多传一个 root 参数（来自 resolvePath 新返回的 IncludeRoot），用于权限/审计
    const raw = this.readFile(includePath, resolvedPath, root);
    // lyc: parsed = 解析文件内容为 JSON 对象
    const parsed = this.parseFile(includePath, resolvedPath, raw);

    return this.processNested(resolvedPath, parsed);
  }

  // lyc: 解析路径
  // lyc:aic v2026.5：返回类型从 string 改为 { resolvedPath, root: IncludeRoot }——支持多个允许的 include root（OPENCLAW_INCLUDE_ROOTS）
  private resolvePath(includePath: string): { resolvedPath: string; root: IncludeRoot } {
    // lyc: 获得配置文件的目录地址
    const configDir = path.dirname(this.basePath);
    // lyc: resolved = 如果includePath是绝对路径则直接返回, 否则认为includePath是相对路径返回configDir + includePath的路径地址
    const resolved = path.isAbsolute(includePath)
      ? includePath
      : path.resolve(configDir, includePath);
    const normalized = path.normalize(resolved);

    // SECURITY: Reject paths outside the config directory and any caller-allowed
    // roots (CWE-22: Path Traversal). Allowed roots come from
    // OPENCLAW_INCLUDE_ROOTS and let operators opt into shared include trees
    // without weakening the default lock-down.
    // lyc: 安全检查路径(normalized)是否在配置文件目录(rootDir)下
    // lyc:aic v2026.5：从单一 rootDir 检查升级为多 root 检查（findContainingRoot 会扫 configRoot + allowedRoots）
    const lexicalMatch = this.findContainingRoot(normalized, "rootDir");
    if (!lexicalMatch) {
      throw new ConfigIncludeError(
        `Include path escapes config directory: ${includePath} (root: ${this.rootDir})`,
        includePath,
      );
    }

    // SECURITY: Resolve symlinks and re-validate to prevent symlink bypass.
    // The realpath may legitimately land in a different allowed root than the
    // lexical path (e.g. config dir contains a symlink into an allowed root),
    // so we recheck across all roots rather than pinning to the lexical match.
    // lyc: 安全检查路径(normalized)是否在配置文件目录(rootRealDir)下
    // lyc:aic v2026.5：升级为跨多个 allowed root 重新检查（realpath 可能落到与 lexical 不同的 root）
    try {
      const real = fs.realpathSync(normalized);
      const realMatch = this.findContainingRoot(real, "rootRealDir");
      if (!realMatch) {
        throw new ConfigIncludeError(
          `Include path resolves outside config directory (symlink): ${includePath} (root: ${this.rootDir})`,
          includePath,
        );
      }
      return { resolvedPath: normalized, root: realMatch };
    } catch (err) {
      if (err instanceof ConfigIncludeError) {
        throw err;
      }
      // lyc: 如果文件不存在, 则直接返回 normalized 路径（lexical 检查已经足够）
      // lyc:aic v2026.5：除了 ENOENT 之外的 realpath 错误现在会抛 ConfigIncludeError（不再被静默吞）
      if (isNotFoundError(err)) {
        // File doesn't exist yet - lexical containment check above is sufficient.
        return { resolvedPath: normalized, root: lexicalMatch };
      }
      throw new ConfigIncludeError(
        `Failed to resolve include file realpath: ${includePath} (resolved: ${normalized})`,
        includePath,
        err instanceof Error ? err : undefined,
      );
    }
  }

  private findContainingRoot(
    candidate: string,
    field: "rootDir" | "rootRealDir",
  ): IncludeRoot | null {
    if (isPathInside(this.configRoot[field], candidate)) {
      return this.configRoot;
    }
    for (const root of this.allowedRoots) {
      if (isPathInside(root[field], candidate)) {
        return root;
      }
    }
    return null;
  }

  private checkCircular(resolvedPath: string): void {
    if (this.visited.has(resolvedPath)) {
      throw new CircularIncludeError([...this.visited, resolvedPath]);
    }
  }

  private checkDepth(includePath: string): void {
    if (this.depth >= MAX_INCLUDE_DEPTH) {
      throw new ConfigIncludeError(
        `Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded at: ${includePath}`,
        includePath,
      );
    }
  }

  private readFile(includePath: string, resolvedPath: string, root: IncludeRoot): string {
    try {
      if (this.resolver.readFileWithGuards) {
        // This guard revalidates the opened file against root.rootRealDir, so
        // symlink swaps between resolvePath() and read are rejected at open time.
        return this.resolver.readFileWithGuards({
          includePath,
          resolvedPath,
          rootRealDir: root.rootRealDir,
        });
      }
      return this.resolver.readFile(resolvedPath);
    } catch (err) {
      if (err instanceof ConfigIncludeError) {
        throw err;
      }
      throw new ConfigIncludeError(
        `Failed to read include file: ${includePath} (resolved: ${resolvedPath})`,
        includePath,
        err instanceof Error ? err : undefined,
      );
    }
  }

  private parseFile(includePath: string, resolvedPath: string, raw: string): unknown {
    try {
      return this.resolver.parseJson(raw);
    } catch (err) {
      throw new ConfigIncludeError(
        `Failed to parse include file: ${includePath} (resolved: ${resolvedPath})`,
        includePath,
        err instanceof Error ? err : undefined,
      );
    }
  }

  // lyc: 解析嵌套的include键对应的值
  private processNested(resolvedPath: string, parsed: unknown): unknown {
    const nested = new IncludeProcessor(
      resolvedPath,
      this.resolver,
      this.rootDir,
      this.allowedRoots,
    );
    nested.visited = new Set([...this.visited, resolvedPath]);
    nested.depth = this.depth + 1;
    return nested.process(parsed);
  }
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

// lyc:aic v2026.5 新增：判断错误是不是 ENOENT（用于上面 resolvePath 区分"文件不存在"与其他 realpath 错误）
function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

// lyc: 以带保护机制(防止逃离配置目录)的方式读取配置中的 include 文件
export function readConfigIncludeFileWithGuards(params: IncludeFileReadParams): string {
  const ioFs = params.ioFs ?? fs;
  const maxBytes = params.maxBytes ?? MAX_INCLUDE_FILE_BYTES;
  if (!canUseRootFileOpen(ioFs)) {
    return ioFs.readFileSync(params.resolvedPath, "utf-8");
  }

  const opened = openRootFileSync({
    absolutePath: params.resolvedPath,
    rootPath: params.rootRealDir,
    rootRealPath: params.rootRealDir,
    boundaryLabel: "config directory",
    skipLexicalRootCheck: true,
    maxBytes,
    ioFs,
  });
  if (!opened.ok) {
    if (opened.reason === "validation") {
      throw new ConfigIncludeError(
        `Include file failed security checks (regular file, max ${maxBytes} bytes, no hardlinks): ${params.includePath}`,
        params.includePath,
      );
    }
    throw new ConfigIncludeError(
      `Failed to read include file: ${params.includePath} (resolved: ${params.resolvedPath})`,
      params.includePath,
      opened.error instanceof Error ? opened.error : undefined,
    );
  }

  try {
    return ioFs.readFileSync(opened.fd, "utf-8");
  } finally {
    ioFs.closeSync(opened.fd);
  }
}

// ============================================================================
// Public API
// ============================================================================

const defaultResolver: IncludeResolver = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
    readConfigIncludeFileWithGuards({ includePath, resolvedPath, rootRealDir }),
  parseJson: (raw) => JSON5.parse(raw),
};

/**
 * Resolves all $include directives in a parsed config object.
 */
// lyc: 解析已解析配置对象中的所有$include指令(directives)。
export function resolveConfigIncludes(
  obj: unknown,
  configPath: string,
  resolver: IncludeResolver = defaultResolver,
  options: ResolveConfigIncludesOptions = {},
): unknown {
  const allowedRoots = (options.allowedRoots ?? [])
    .filter((entry) => typeof entry === "string" && entry.length > 0 && path.isAbsolute(entry))
    .map<IncludeRoot>((entry) => {
      const rootDir = path.normalize(entry);
      return { rootDir, rootRealDir: path.normalize(safeRealpath(rootDir)) };
    });
  return new IncludeProcessor(configPath, resolver, undefined, allowedRoots).process(obj);
}
