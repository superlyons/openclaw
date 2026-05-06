/**
 * Environment variable substitution for config values.
 *
 * Supports `${VAR_NAME}` syntax in string values, substituted at config load time.
 * - Only uppercase env vars are matched: `[A-Z_][A-Z0-9_]*`
 * - Escape with `$${}` to output literal `${}`
 * - Missing env vars throw `MissingEnvVarError` with context
 *
 * @example
 * ```json5
 * {
 *   models: {
 *     providers: {
 *       "vercel-gateway": {
 *         apiKey: "${VERCEL_GATEWAY_API_KEY}"
 *       }
 *     }
 *   }
 * }
 * ```
 */

// Pattern for valid uppercase env var names: starts with letter or underscore,
// followed by letters, numbers, or underscores (all uppercase)
import { isPlainObject } from "../utils.js";

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export class MissingEnvVarError extends Error {
  constructor(
    public readonly varName: string,
    public readonly configPath: string,
  ) {
    super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
    this.name = "MissingEnvVarError";
  }
}

type EnvToken =
  | { kind: "escaped"; name: string; end: number }
  | { kind: "substitution"; name: string; end: number };

// lyc: 解析环境变量令牌
function parseEnvTokenAt(value: string, index: number): EnvToken | null {
  if (value[index] !== "$") {
    return null;
  }

  const next = value[index + 1];
  const afterNext = value[index + 2];

  // Escaped: $${VAR} -> ${VAR}
  // lyc: 逃脱: 如果是$${VAR}这种情况, value[index]="$", next="$", afterNext="{"
  if (next === "$" && afterNext === "{") {
    // lyc: start指向$${VAR}中的V
    const start = index + 3;
    // lyc: end指向$${VAR}中的}
    const end = value.indexOf("}", start);
    // lyc: 如果end不是-1, 则说明$${VAR}中的}是匹配的
    if (end !== -1) {
      // lyc: 提取$${VAR}中的VAR
      const name = value.slice(start, end);
      // lyc: 如果VAR符合环境变量名的规范, 则返回一个EnvToken对象
      if (ENV_VAR_NAME_PATTERN.test(name)) {
        return { kind: "escaped", name, end };
      }
    }
  }

  // Substitution: ${VAR} -> value
  // lyc: 替换: 如果是${VAR}这种情况, value[index]="$", next="{", afterNext="V"
  if (next === "{") {
    const start = index + 2;
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const name = value.slice(start, end);
      if (ENV_VAR_NAME_PATTERN.test(name)) {
        return { kind: "substitution", name, end };
      }
    }
  }

  return null;
}

export type EnvSubstitutionWarning = {
  varName: string;
  configPath: string;
};

export type SubstituteOptions = {
  /** When set, missing vars call this instead of throwing and the original placeholder is preserved. */
  onMissing?: (warning: EnvSubstitutionWarning) => void;
};

// lyc: 替换字符串中的环境变量引用
function substituteString(
  value: string,
  env: NodeJS.ProcessEnv,
  configPath: string,
  opts?: SubstituteOptions,
): string {
  if (!value.includes("$")) {
    return value;
  }

  const chunks: string[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== "$") {
      chunks.push(char);
      continue;
    }

    const token = parseEnvTokenAt(value, i);
    if (token?.kind === "escaped") {
      chunks.push(`\${${token.name}}`);
      i = token.end;
      continue;
    }
    if (token?.kind === "substitution") {
      const envValue = env[token.name];
      if (envValue === undefined || envValue === "") {
        if (opts?.onMissing) {
          opts.onMissing({ varName: token.name, configPath });
          // Preserve the original placeholder so the value is visibly unresolved.
          chunks.push(`\${${token.name}}`);
          i = token.end;
          continue;
        }
        throw new MissingEnvVarError(token.name, configPath);
      }
      chunks.push(envValue);
      i = token.end;
      continue;
    }

    // Leave untouched if not a recognized pattern
    chunks.push(char);
  }

  return chunks.join("");
}

// lyc: 检查字符串是否包含环境变量引用
export function containsEnvVarReference(value: string): boolean {
  if (!value.includes("$")) {
    return false;
  }

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== "$") {
      continue;
    }

    // lyc: 解析环境变量令牌, 逃脱$${VAR}, 替换${VAR}
    const token = parseEnvTokenAt(value, i);
    if (token?.kind === "escaped") {
      i = token.end;
      continue;
    }
    if (token?.kind === "substitution") {
      return true;
    }
  }

  return false;
}

function substituteAny(
  value: unknown,
  env: NodeJS.ProcessEnv,
  path: string,
  opts?: SubstituteOptions,
): unknown {
  if (typeof value === "string") {
    return substituteString(value, env, path, opts);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => substituteAny(item, env, `${path}[${index}]`, opts));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = substituteAny(val, env, childPath, opts);
    }
    return result;
  }

  // Primitives (number, boolean, null) pass through unchanged
  return value;
}

/**
 * Resolves `${VAR_NAME}` environment variable references in config values.
 *
 * @param obj - The parsed config object (after JSON5 parse and $include resolution)
 * @param env - Environment variables to use for substitution (defaults to process.env)
 * @param opts - Options: `onMissing` callback to collect warnings instead of throwing.
 * @returns The config object with env vars substituted
 * @throws {MissingEnvVarError} If a referenced env var is not set or empty (unless `onMissing` is set)
 */
/* lyc: 在配置值中解析`${VAR_NAME}`环境变量引用。
@param obj - 解析后的配置对象（经过JSON5解析和$include解析后）
@param env - 用于替换的环境变量（默认为process.env）
@param opts - 选项：`onMissing`回调函数，用于收集警告而不是抛出错误
@returns 替换环境变量后的配置对象
@throws {MissingEnvVarError} 如果引用的环境变量未设置或为空（除非设置了`onMissing`）
*/
export function resolveConfigEnvVars(
  obj: unknown,
  env: NodeJS.ProcessEnv = process.env,
  opts?: SubstituteOptions,
): unknown {
  return substituteAny(obj, env, "", opts);
}
