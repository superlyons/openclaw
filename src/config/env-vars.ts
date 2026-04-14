import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import type { OpenClawConfig } from "./types.js";

// lyc: 判断环境变量是否被阻止
function isBlockedConfigEnvVar(key: string): boolean {
  return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}

/* lyc: 
  收集配置文件中的环境变量(cfg.env)并返回, 包括cfg:OpenClawConfig.env中除了shellEnv以外的所有定义的环境变量, 
  cfg.env.vars定义的环境变量会提取到根部(返回的记录中), 如果cfg.env.*定义的环境变量和cfg.env.vars定义的环境变量key冲突, 则cfg.env.vars会被cfg.env.*覆盖
  */
function collectConfigEnvVarsByTarget(cfg?: OpenClawConfig): Record<string, string> {
  const envConfig = cfg?.env;
  if (!envConfig) {
    return {};
  }

  const entries: Record<string, string> = {};

  if (envConfig.vars) {
    for (const [rawKey, value] of Object.entries(envConfig.vars)) {
      if (!value) {
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

/** @deprecated Use `collectConfigRuntimeEnvVars` or `collectConfigServiceEnvVars`. */
export function collectConfigEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  return collectConfigRuntimeEnvVars(cfg);
}

// lyc: 应用配置文件中的环境变量(cfg.env)到process.env, 如果env已存在不覆盖, 只添加
export function applyConfigEnvVars(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const entries = collectConfigRuntimeEnvVars(cfg);
  for (const [key, value] of Object.entries(entries)) {
    if (env[key]?.trim()) {
      continue;
    }
    env[key] = value;
  }
}
