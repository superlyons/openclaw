import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHomePrefix, resolveRequiredHomeDir } from "../infra/home-dir.js";
import type { OpenClawConfig } from "./types.js";

/**
 * Nix mode detection: When OPENCLAW_NIX_MODE=1, the gateway is running under Nix.
 * In this mode:
 * - No auto-install flows should be attempted
 * - Missing dependencies should produce actionable Nix-specific error messages
 * - Config is managed externally (read-only from Nix perspective)
 */
export function resolveIsNixMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_NIX_MODE === "1";
}

export const isNixMode = resolveIsNixMode();

// Support historical (and occasionally misspelled) legacy state dirs.
const LEGACY_STATE_DIRNAMES = [".clawdbot", ".moldbot", ".moltbot"] as const;
const NEW_STATE_DIRNAME = ".openclaw";
const CONFIG_FILENAME = "openclaw.json";
const LEGACY_CONFIG_FILENAMES = ["clawdbot.json", "moldbot.json", "moltbot.json"] as const;

function resolveDefaultHomeDir(): string {
  return resolveRequiredHomeDir(process.env, os.homedir);
}

/** Build a homedir thunk that respects OPENCLAW_HOME for the given env. */
// lyc: 返回一个函数, 该函数返回当前环境的 home 目录路径, 尊重 OPENCLAW_HOME 环境变量
function envHomedir(env: NodeJS.ProcessEnv): () => string {
  return () => resolveRequiredHomeDir(env, os.homedir);
}

function legacyStateDirs(homedir: () => string = resolveDefaultHomeDir): string[] {
  return LEGACY_STATE_DIRNAMES.map((dir) => path.join(homedir(), dir));
}

function newStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return path.join(homedir(), NEW_STATE_DIRNAME);
}

export function resolveLegacyStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return legacyStateDirs(homedir)[0] ?? newStateDir(homedir);
}

export function resolveLegacyStateDirs(homedir: () => string = resolveDefaultHomeDir): string[] {
  return legacyStateDirs(homedir);
}

export function resolveNewStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return newStateDir(homedir);
}

/**
 * State directory for mutable data (sessions, logs, caches).
 * Can be overridden via OPENCLAW_STATE_DIR.
 * Default: ~/.openclaw
 */
/* lyc:
  如果环境变量 OPENCLAW_STATE_DIR或CLAWDBOT_STATE_DIR 存在, 则返回该路径, ~开头会替换为用户home目录或cwd目录
  不存在:
    newDir = 用户目录或cwd目录+"/.openclaw"的目录地址
    - OPENCLAW_TEST_FAST = 1 则返回 newDir
    - 如果newDir在文件系统中存在, 则返回 newDir
    - 如果不存在, 则检查旧版本遗产目录在文件系统中是否存在, 如果存在, 则返回旧版本遗产目录
    - 如果旧版本遗产目录不存在, 则返回 newDir 作为默认状态目录(注意这里未验证是否真实存在)
*/
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, effectiveHomedir);
  }
  // lyc: effectiveHomedir函数返回的路径+"/.openclaw"目录地址
  const newDir = newStateDir(effectiveHomedir);
  if (env.OPENCLAW_TEST_FAST === "1") {
    // lyc:如果配置OPENCLAW_TEST_FAST=1, 则直接返回
    return newDir;
  }
  // lyc: 旧版本遗产目录数组, effectiveHomedir函数返回的路径+".clawdbot", ".moldbot", ".moltbot"目录地址
  const legacyDirs = legacyStateDirs(effectiveHomedir);
  const hasNew = fs.existsSync(newDir);
  if (hasNew) {
    return newDir;
  }
  const existingLegacy = legacyDirs.find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
  if (existingLegacy) {
    return existingLegacy;
  }
  return newDir;
}

/* lyc:
  解析用户路径(注意不确保路径是否存在)
  如果路径以 ~ 开头, 则展开 ~ 为用户目录
  如果路径以 / 开头, 则返回路径
  如果路径以 . 开头, 则返回当前目录
*/
function resolveUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredHomeDir(env, homedir),
      env,
      homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

export const STATE_DIR = resolveStateDir();

/**
 * Config file path (JSON5).
 * Can be overridden via OPENCLAW_CONFIG_PATH.
 * Default: ~/.openclaw/openclaw.json (or $OPENCLAW_STATE_DIR/openclaw.json)
 */
export function resolveCanonicalConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(stateDir, CONFIG_FILENAME);
}

/**
 * Resolve the active config path by preferring existing config candidates
 * before falling back to the canonical path.
 */
/* lyc:
  解析默认配置路径:
  家目录, cwd目录 + env.OPENCLAW_STATE_DIR, CLAWDBOT_STATE_DIR 配置
  或
  家目录, cwd目录 + .openclaw, .clawdbot, .moldbot, .moltbot 目录
  + 
  OPENCLAW_CONFIG_PATH, CLAWDBOT_CONFIG_PATH, openclaw.json, OPENCLAW_STATE_DIR, CLAWDBOT_STATE_DIR, clawdbot.json, moldbot.json, moltbot.json json文件路径
*/
export function resolveConfigPathCandidate(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  if (env.OPENCLAW_TEST_FAST === "1") {
    return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
  }
  const candidates = resolveDefaultConfigCandidates(env, homedir);
  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    return existing;
  }
  return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
}

/**
 * Active config path (prefers existing config files).
 */
/* lyc:
  解析活动配置路径
  如果环境变量 OPENCLAW_CONFIG_PATH 存在, 则返回该路径, ~开头会替换为用户目录
  如果环境变量 OPENCLAW_TEST_FAST === 1, 则返回默认配置路径stateDir/openclaw.json
  依次在[stateDir/openclaw.json, 旧版本遗产目录数组]中查找, 如果存在, 则返回第一个找到的配置文件地址
  如果不存在&&OPENCLAW_STATE_DIR===1, 则返回默认配置路径stateDir/openclaw.json
  如果stateDir !== defaultStateDir, 则返回默认配置路径stateDir/openclaw.json
  否则解析默认配置路径
*/
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
  homedir: () => string = envHomedir(env),
): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, homedir);
  }
  if (env.OPENCLAW_TEST_FAST === "1") {
    // lyc:如果配置OPENCLAW_TEST_FAST=1, 则直接返回
    // lyc: stateDir函数返回的路径+"/openclaw.json"文件地址
    return path.join(stateDir, CONFIG_FILENAME);
  }
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  const candidates = [
    path.join(stateDir, CONFIG_FILENAME),
    ...LEGACY_CONFIG_FILENAMES.map((name) => path.join(stateDir, name)),
  ];
  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    return existing;
  }
  if (stateOverride) {
    return path.join(stateDir, CONFIG_FILENAME);
  }
  const defaultStateDir = resolveStateDir(env, homedir);
  // lyc: 如果 stateDir === defaultStateDir, 
  if (path.resolve(stateDir) === path.resolve(defaultStateDir)) {
    return resolveConfigPathCandidate(env, homedir);
  }
  return path.join(stateDir, CONFIG_FILENAME);
}

export const CONFIG_PATH = resolveConfigPathCandidate();

/**
 * Resolve default config path candidates across default locations.
 * Order: explicit config path → state-dir-derived paths → new default.
 */
/** lyc:
解析默认位置中的默认配置路径候选项.
顺序：显式配置路径(OPENCLAW_CONFIG_PATH) → 状态目录派生路径(OPENCLAW_STATE_DIR) → 新默认路径(defaultDirs)。
*/
export function resolveDefaultConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string[] {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  // lyc: openclaw.json的显式配置路径(OPENCLAW_CONFIG_PATH|CLAWDBOT_CONFIG_PATH)
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (explicit) {
    return [resolveUserPath(explicit, env, effectiveHomedir)];
  }

  // lyc: openclaw.json的OPENCLAW_STATE_DIR路径: [OPENCLAW_STATE_DIR|CLAWDBOT_STATE_DIR/openclaw.json|clawdbot.json|moldbot.json|moltbot.json ]
  const candidates: string[] = [];
  const openclawStateDir = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (openclawStateDir) {
    const resolved = resolveUserPath(openclawStateDir, env, effectiveHomedir);
    candidates.push(path.join(resolved, CONFIG_FILENAME));
    candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(resolved, name)));
  }
  // lyc: openclaw.json的默认路径: [~/.openclaw|.clawdbot|.moldbot|.moltbot/openclaw.json|clawdbot.json|moldbot.json|moltbot.json]
  const defaultDirs = [newStateDir(effectiveHomedir), ...legacyStateDirs(effectiveHomedir)];
  for (const dir of defaultDirs) {
    candidates.push(path.join(dir, CONFIG_FILENAME));
    candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(dir, name)));
  }
  return candidates;
}

export const DEFAULT_GATEWAY_PORT = 18789;

/**
 * Gateway lock directory (ephemeral).
 * Default: os.tmpdir()/openclaw-<uid> (uid suffix when available).
 */
export function resolveGatewayLockDir(tmpdir: () => string = os.tmpdir): string {
  const base = tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const suffix = uid != null ? `openclaw-${uid}` : "openclaw";
  return path.join(base, suffix);
}

const OAUTH_FILENAME = "oauth.json";

/**
 * OAuth credentials storage directory.
 *
 * Precedence:
 * - `OPENCLAW_OAUTH_DIR` (explicit override)
 * - `$*_STATE_DIR/credentials` (canonical server/default)
 */
export function resolveOAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  const override = env.OPENCLAW_OAUTH_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(stateDir, "credentials");
}

export function resolveOAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  return path.join(resolveOAuthDir(env, stateDir), OAUTH_FILENAME);
}

export function resolveGatewayPort(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envRaw = env.OPENCLAW_GATEWAY_PORT?.trim() || env.CLAWDBOT_GATEWAY_PORT?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort)) {
    if (configPort > 0) {
      return configPort;
    }
  }
  return DEFAULT_GATEWAY_PORT;
}
