import { normalizeChatChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginRecord } from "./registry.js";
import { defaultSlotIdForKey } from "./slots.js";

export type NormalizedPluginsConfig = {
  enabled: boolean;
  allow: string[];
  deny: string[];
  loadPaths: string[];
  slots: {
    memory?: string | null;
  };
  entries: Record<string, { enabled?: boolean; config?: unknown }>;
};

export const BUNDLED_ENABLED_BY_DEFAULT = new Set<string>([
  "device-pair",
  "phone-control",
  "talk-voice",
]);

const normalizeList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
};

const normalizeSlotValue = (value: unknown): string | null | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase() === "none") {
    return null;
  }
  return trimmed;
};

const normalizePluginEntries = (entries: unknown): NormalizedPluginsConfig["entries"] => {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return {};
  }
  const normalized: NormalizedPluginsConfig["entries"] = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!key.trim()) {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      normalized[key] = {};
      continue;
    }
    const entry = value as Record<string, unknown>;
    normalized[key] = {
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
      config: "config" in entry ? entry.config : undefined,
    };
  }
  return normalized;
};

/* lyc: 
  归一化plugins配置
  enabled(PluginsConfig.enabled): 是否启用plugins, 
  allow(PluginsConfig.allow[]): 允许的plugins, 
  deny(PluginsConfig.deny[]): 拒绝的plugins, 
  loadPaths(PluginsConfig.load.paths[]): 加载plugins的路径,
  slots(PluginsConfig.slots.memory): 插槽配置,
  entries(PluginsConfig.entries[]): plugins配置,
*/
export const normalizePluginsConfig = (
  config?: OpenClawConfig["plugins"],
): NormalizedPluginsConfig => {
  const memorySlot = normalizeSlotValue(config?.slots?.memory);
  return {
    enabled: config?.enabled !== false,
    allow: normalizeList(config?.allow),
    deny: normalizeList(config?.deny),
    loadPaths: normalizeList(config?.load?.paths),
    slots: {
      memory: memorySlot === undefined ? defaultSlotIdForKey("memory") : memorySlot,
    },
    entries: normalizePluginEntries(config?.entries),
  };
};

const hasExplicitMemorySlot = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.slots && Object.prototype.hasOwnProperty.call(plugins.slots, "memory"));

const hasExplicitMemoryEntry = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.entries && Object.prototype.hasOwnProperty.call(plugins.entries, "memory-core"));

// lyc: 是否有明确配置的plugins
const hasExplicitPluginConfig = (plugins?: OpenClawConfig["plugins"]) => {
  if (!plugins) {
    return false;
  }
  if (typeof plugins.enabled === "boolean") {
    return true;
  }
  if (Array.isArray(plugins.allow) && plugins.allow.length > 0) {
    return true;
  }
  if (Array.isArray(plugins.deny) && plugins.deny.length > 0) {
    return true;
  }
  if (plugins.load?.paths && Array.isArray(plugins.load.paths) && plugins.load.paths.length > 0) {
    return true;
  }
  if (plugins.slots && Object.keys(plugins.slots).length > 0) {
    return true;
  }
  if (plugins.entries && Object.keys(plugins.entries).length > 0) {
    return true;
  }
  return false;
};

export function applyTestPluginDefaults(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  if (!env.VITEST) {
    return cfg;
  }
  const plugins = cfg.plugins;
  const explicitConfig = hasExplicitPluginConfig(plugins);
  // lyc: 如果有明确配置的plugins
  if (explicitConfig) {
    // lyc: plugins.slots.memory || plugins.entries["memory-core"]
    if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
      return cfg;
    }
    return {
      ...cfg,
      plugins: {
        ...plugins,
        slots: {
          ...plugins?.slots,
          memory: "none",
        },
      },
    };
  }

  return {
    ...cfg,
    plugins: {
      ...plugins,
      enabled: false,
      slots: {
        ...plugins?.slots,
        memory: "none",
      },
    },
  };
}

export function isTestDefaultMemorySlotDisabled(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!env.VITEST) {
    return false;
  }
  const plugins = cfg.plugins;
  if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
    return false;
  }
  return true;
}

// lyc: 解决plugins的启用状态
export function resolveEnableState(
  id: string,
  origin: PluginRecord["origin"],
  config: NormalizedPluginsConfig,
): { enabled: boolean; reason?: string } {
  if (!config.enabled) {
    return { enabled: false, reason: "plugins disabled" };
  }
  if (config.deny.includes(id)) {
    return { enabled: false, reason: "blocked by denylist" };
  }
  if (config.allow.length > 0 && !config.allow.includes(id)) {
    return { enabled: false, reason: "not in allowlist" };
  }
  // lyc: plugins是开启的 & 没被deny & 是allow的 & 是内存槽
  if (config.slots.memory === id) {
    return { enabled: true };
  }
  const entry = config.entries[id];
  // lyc: plugins是开启的 & 没被deny & 是allow的 & 不是内存槽 & config.plugins.entries中明确开启
  if (entry?.enabled === true) {
    return { enabled: true };
  }
  // lyc: 明确关闭
  if (entry?.enabled === false) {
    return { enabled: false, reason: "disabled in config" };
  }
  // lyc: plugins是开启的 & 没被deny & 是allow的 & 不是内存槽 & config.plugins.entries中没有明确开启 & origin为bundled & 是BUNDLED默认开启的
  if (origin === "bundled" && BUNDLED_ENABLED_BY_DEFAULT.has(id)) {
    return { enabled: true };
  }
  // lyc: plugins是开启的 & 没被deny & 是allow的 & 不是内存槽 & config.plugins.entries中没有明确开启 & origin为bundled & 不是BUNDLED默认开启的
  if (origin === "bundled") {
    return { enabled: false, reason: "bundled (disabled by default)" };
  }

  // lyc: plugins是开启的 & 没被deny & 是allow的 & 不是内存槽 & config.plugins.entries中没有明确开启 & origin不为bundled
  return { enabled: true };
}

export function isBundledChannelEnabledByChannelConfig(
  cfg: OpenClawConfig | undefined,
  pluginId: string,
): boolean {
  if (!cfg) {
    return false;
  }
  const channelId = normalizeChatChannelId(pluginId);
  if (!channelId) {
    return false;
  }
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  return (entry as Record<string, unknown>).enabled === true;
}

// lyc: 解决plugins的有效启用状态
export function resolveEffectiveEnableState(params: {
  id: string;
  origin: PluginRecord["origin"];
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
}): { enabled: boolean; reason?: string } {
  // lyc: 检查config.plugins中是否开启
  const base = resolveEnableState(params.id, params.origin, params.config);
  // lyc: 如果是origin为bundled的原因, 则从config.channels中检查是否启用
  if (
    !base.enabled &&
    base.reason === "bundled (disabled by default)" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return { enabled: true };
  }
  return base;
}

/* lyc: 解决plugins的内存槽决策
  {enabled: true}: 插件的manifest.kind配置不是memory
  {enabled: true, selected: true}: 
    插件的manifest.kind配置是memory &
    (
      config.plugins.slots.memory=params.id: slot配置明确指定了插件的id
      或 (没有slot配置 && (未指定selectedId || (指定了selectedId & selectedId是插件的id))
    )
*/
export function resolveMemorySlotDecision(params: {
  id: string;
  kind?: string;
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  // lyc: 如果插件的manifest.kind配置不是memory
  if (params.kind !== "memory") {
    return { enabled: true };
  }
  // lyc: 以下代表插件的manifest.kind配置是memory 

  // lyc: config.plugins.slots.memory明确赋值为null
  if (params.slot === null) {
    return { enabled: false, reason: "memory slot disabled" };
  }
  // lyc: config.plugins.slots.memory明确指定了一个字符串的值
  if (typeof params.slot === "string") {
    // lyc: config.plugins.slots.memory指定的值是插件的id
    if (params.slot === params.id) {
      return { enabled: true, selected: true };
    }
    // lyc: config.plugins.slots.memory指定的值不是插件的id
    return {
      enabled: false,
      reason: `memory slot set to "${params.slot}"`,
    };
  }

  // lyc: 以下代表config.plugins.slots.memory没有定义

  // lyc: 指定了selectedId & selectedId不是插件的id
  if (params.selectedId && params.selectedId !== params.id) {
    return {
      enabled: false,
      reason: `memory slot already filled by "${params.selectedId}"`,
    };
  }
  // lyc: 没有指定selectedId || (指定了selectedId & selectedId是插件的id)
  return { enabled: true, selected: true };
}
