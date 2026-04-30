import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import { resolveStateDir } from "./paths.js";
import type { OpenClawConfig } from "./types.js";

export type DuplicateAgentDir = {
  agentDir: string;
  agentIds: string[];
};

export class DuplicateAgentDirError extends Error {
  readonly duplicates: DuplicateAgentDir[];

  constructor(duplicates: DuplicateAgentDir[]) {
    super(formatDuplicateAgentDirError(duplicates));
    this.name = "DuplicateAgentDirError";
    this.duplicates = duplicates;
  }
}

function canonicalizeAgentDir(agentDir: string): string {
  const resolved = path.resolve(agentDir);
  if (process.platform === "darwin" || process.platform === "win32") {
    return normalizeLowercaseStringOrEmpty(resolved);
  }
  return resolved;
}

// lyc: 收集cfg.agents.list[]和cfg.bindings[]中所有agentId
function collectReferencedAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  // lyc: 返回cfg.agents.list[]中第一个default为true的agentId || 第一个agentId || DEFAULT_AGENT_ID(main)
  const defaultAgentId =
    agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? DEFAULT_AGENT_ID;
  ids.add(normalizeAgentId(defaultAgentId));

  // lyc: 收集cfg.agents.list[]中所有agentId
  for (const entry of agents) {
    if (entry?.id) {
      ids.add(normalizeAgentId(entry.id));
    }
  }

  // lyc: 收集cfg.bindings[]中所有agentId
  const bindings = cfg.bindings;
  if (Array.isArray(bindings)) {
    for (const binding of bindings) {
      const id = binding?.agentId;
      if (typeof id === "string" && id.trim()) {
        ids.add(normalizeAgentId(id));
      }
    }
  }

  return [...ids];
}

// lyc: 解析angenId对应的有效的Agent目录地址, 来自(cfg.agents.list[] == agentId).agentDir 或 home路径+/.openclaw/agents/${agentId}/agent
function resolveEffectiveAgentDir(
  cfg: OpenClawConfig,
  agentId: string,
  deps?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): string {
  const id = normalizeAgentId(agentId);
  // lyc: 返回cfg.agents.list[]中第一个agent.id===id的agentDir || undefined
  const configured = Array.isArray(cfg.agents?.list)
    ? cfg.agents?.list.find((agent) => normalizeAgentId(agent.id) === id)?.agentDir
    : undefined;
  const trimmed = configured?.trim();
  if (trimmed) {
    return resolveUserPath(trimmed);
  }
  // lyc: 到此代表configured为undefined
  const env = deps?.env ?? process.env;
  const root = resolveStateDir(
    env,
    deps?.homedir ?? (() => resolveRequiredHomeDir(env, os.homedir)),
  );
  // lyc: home路径+/.openclaw/agents/${id}/agent
  return path.join(root, "agents", id, "agent");
}

// lyc: 查找重复的agentDir
export function findDuplicateAgentDirs(
  cfg: OpenClawConfig,
  deps?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): DuplicateAgentDir[] {
  const byDir = new Map<string, { agentDir: string; agentIds: string[] }>();

  // lyc: 收集cfg.agents.list[]和cfg.bindings[]中所有agentId并遍历它们
  for (const agentId of collectReferencedAgentIds(cfg)) {
    // lyc: 解析angenId对应的有效的Agent目录地址
    const agentDir = resolveEffectiveAgentDir(cfg, agentId, deps);
    // lyc: key为规范化的agentDir
    const key = canonicalizeAgentDir(agentDir);
    const entry = byDir.get(key);
    if (entry) {
      entry.agentIds.push(agentId);
    } else {
      // lyc: { key(规范化后的agentDir): { agentDir, agentIds: [agentId] } }
      byDir.set(key, { agentDir, agentIds: [agentId] });
    }
  }
  // lyc: 返回agentIds长度大于1的agentDir; [{ agentDir, agentIds: [...] }, ...]
  return [...byDir.values()].filter((v) => v.agentIds.length > 1);
}

export function formatDuplicateAgentDirError(dups: DuplicateAgentDir[]): string {
  const lines: string[] = [
    "Duplicate agentDir detected (multi-agent config).",
    "Each agent must have a unique agentDir; sharing it causes auth/session state collisions and token invalidation.",
    "",
    "Conflicts:",
    ...dups.map((d) => `- ${d.agentDir}: ${d.agentIds.map((id) => `"${id}"`).join(", ")}`),
    "",
    "Fix: remove the shared agents.list[].agentDir override (or give each agent its own directory).",
    "If you want to share credentials, copy auth-profiles.json instead of sharing the entire agentDir.",
  ];
  return lines.join("\n");
}
