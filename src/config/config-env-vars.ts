import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { containsEnvVarReference } from "./env-substitution.js";
import type { OpenClawConfig } from "./types.js";

// lyc: 检查环境变量是否被阻止。
function isBlockedConfigEnvVar(key: string): boolean {
  return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}

// lyc: 从配置文件中收集环境变量(会过滤不符合规范的和被阻止的环境变量), 并返回一个键值对对象。cfg.env.除shellEnv以外的, cfg.env.vars, 所有键值对对象
function collectConfigEnvVarsByTarget(cfg?: OpenClawConfig): Record<string, string> {
  const envConfig = cfg?.env;
  if (!envConfig) {
    return {};
  }

  const entries: Record<string, string> = {};

  if (envConfig.vars) {
    for (const [rawKey, value] of Object.entries(envConfig.vars)) {
      if (typeof value !== "string" || !value.trim()) {
        continue;
      }
      const key = normalizeEnvVarKey(rawKey, { portable: true });
      if (!key) {
        continue;
      }
      // lyc: 检查环境变量是否被阻止。
      if (isBlockedConfigEnvVar(key)) {
        continue;
      }
      // lyc: 收集环境变量。
      entries[key] = value;
    }
  }

  for (const [rawKey, value] of Object.entries(envConfig)) {
    if (rawKey === "shellEnv" || rawKey === "vars") {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    if (isBlockedConfigEnvVar(key)) {
      continue;
    }
    entries[key] = value;
  }

  return entries;
}

export function collectConfigRuntimeEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  return collectConfigEnvVarsByTarget(cfg);
}

export function collectConfigServiceEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  return collectConfigEnvVarsByTarget(cfg);
}

export function createConfigRuntimeEnv(
  cfg: OpenClawConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  applyConfigEnvVars(cfg, env);
  return env;
}

// lyc: 应用配置环境变量到指定环境对象
export function applyConfigEnvVars(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // lyc: 从配置文件中收集环境变量(会过滤不符合规范的和被阻止的环境变量), 并返回一个键值对对象。cfg.env.除shellEnv以外的, cfg.env.vars, 所有键值对对象
  const entries = collectConfigRuntimeEnvVars(cfg);
  for (const [key, value] of Object.entries(entries)) {
    // lyc: 如果环境变量已存在, 则跳过。
    if (env[key]?.trim()) {
      continue;
    }
    // Skip values containing unresolved ${VAR} references — applyConfigEnvVars runs
    // before env substitution, so these would pollute process.env with literal placeholders
    // (e.g. process.env.OPENCLAW_GATEWAY_TOKEN = "${VAULT_TOKEN}") which downstream auth
    // resolution would accept as valid credentials.
    // lyc: 跳过包含未解析${VAR}引用的值 — 本函数(applyConfigEnvVars)在环境变量替换之前运行，因此这些值会用字面占位符（例如process.env.OPENCLAW_GATEWAY_TOKEN = "${VAULT_TOKEN}"）污染process.env，而下游的身份验证解析会将这些占位符视为有效凭据。
    if (containsEnvVarReference(value)) {
      continue;
    }
    env[key] = value;
  }
}
