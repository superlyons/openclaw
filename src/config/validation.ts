import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { CHANNEL_IDS, normalizeChatChannelId } from "../channels/registry.js";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveMemorySlotDecision,
} from "../plugins/config-state.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import {
  hasAvatarUriScheme,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isPathWithinRoot,
  isWindowsAbsolutePath,
} from "../shared/avatar-policy.js";
import { isCanonicalDottedDecimalIPv4, isLoopbackIpAddress } from "../shared/net/ip.js";
import { isRecord } from "../utils.js";
import { findDuplicateAgentDirs, formatDuplicateAgentDirError } from "./agent-dirs.js";
import { appendAllowedValuesHint, summarizeAllowedValues } from "./allowed-values.js";
import { applyAgentDefaults, applyModelDefaults, applySessionDefaults } from "./defaults.js";
import { findLegacyConfigIssues } from "./legacy.js";
import type { OpenClawConfig, ConfigValidationIssue } from "./types.js";
import { OpenClawSchema } from "./zod-schema.js";

const LEGACY_REMOVED_PLUGIN_IDS = new Set(["google-antigravity-auth"]);

type UnknownIssueRecord = Record<string, unknown>;
type AllowedValuesCollection = {
  values: unknown[];
  incomplete: boolean;
  hasValues: boolean;
};

function toIssueRecord(value: unknown): UnknownIssueRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as UnknownIssueRecord;
}

function collectAllowedValuesFromIssue(issue: unknown): AllowedValuesCollection {
  const record = toIssueRecord(issue);
  if (!record) {
    return { values: [], incomplete: false, hasValues: false };
  }
  const code = typeof record.code === "string" ? record.code : "";

  if (code === "invalid_value") {
    const values = record.values;
    if (!Array.isArray(values)) {
      return { values: [], incomplete: true, hasValues: false };
    }
    return { values, incomplete: false, hasValues: values.length > 0 };
  }

  if (code === "invalid_type") {
    const expected = typeof record.expected === "string" ? record.expected : "";
    if (expected === "boolean") {
      return { values: [true, false], incomplete: false, hasValues: true };
    }
    return { values: [], incomplete: true, hasValues: false };
  }

  if (code !== "invalid_union") {
    return { values: [], incomplete: false, hasValues: false };
  }

  const nested = record.errors;
  if (!Array.isArray(nested) || nested.length === 0) {
    return { values: [], incomplete: true, hasValues: false };
  }

  const collected: unknown[] = [];
  for (const branch of nested) {
    if (!Array.isArray(branch) || branch.length === 0) {
      return { values: [], incomplete: true, hasValues: false };
    }
    const branchCollected = collectAllowedValuesFromIssueList(branch);
    if (branchCollected.incomplete || !branchCollected.hasValues) {
      return { values: [], incomplete: true, hasValues: false };
    }
    collected.push(...branchCollected.values);
  }

  return { values: collected, incomplete: false, hasValues: collected.length > 0 };
}

function collectAllowedValuesFromIssueList(
  issues: ReadonlyArray<unknown>,
): AllowedValuesCollection {
  const collected: unknown[] = [];
  let hasValues = false;
  for (const issue of issues) {
    const branch = collectAllowedValuesFromIssue(issue);
    if (branch.incomplete) {
      return { values: [], incomplete: true, hasValues: false };
    }
    if (!branch.hasValues) {
      continue;
    }
    hasValues = true;
    collected.push(...branch.values);
  }
  return { values: collected, incomplete: false, hasValues };
}

function collectAllowedValuesFromUnknownIssue(issue: unknown): unknown[] {
  const collection = collectAllowedValuesFromIssue(issue);
  if (collection.incomplete || !collection.hasValues) {
    return [];
  }
  return collection.values;
}

function mapZodIssueToConfigIssue(issue: unknown): ConfigValidationIssue {
  const record = toIssueRecord(issue);
  const path = Array.isArray(record?.path)
    ? record.path
        .filter((segment): segment is string | number => {
          const segmentType = typeof segment;
          return segmentType === "string" || segmentType === "number";
        })
        .join(".")
    : "";
  const message = typeof record?.message === "string" ? record.message : "Invalid input";
  const allowedValuesSummary = summarizeAllowedValues(collectAllowedValuesFromUnknownIssue(issue));

  if (!allowedValuesSummary) {
    return { path, message };
  }

  return {
    path,
    message: appendAllowedValuesHint(message, allowedValuesSummary),
    allowedValues: allowedValuesSummary.values,
    allowedValuesHiddenCount: allowedValuesSummary.hiddenCount,
  };
}

function isWorkspaceAvatarPath(value: string, workspaceDir: string): boolean {
  const workspaceRoot = path.resolve(workspaceDir);
  const resolved = path.resolve(workspaceRoot, value);
  return isPathWithinRoot(workspaceRoot, resolved);
}

// lyc: 验证config.agents.list[].identity.avatar是否符合要求
function validateIdentityAvatar(config: OpenClawConfig): ConfigValidationIssue[] {
  const agents = config.agents?.list;
  if (!Array.isArray(agents) || agents.length === 0) {
    return [];
  }
  const issues: ConfigValidationIssue[] = [];
  for (const [index, entry] of agents.entries()) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const avatarRaw = entry.identity?.avatar;
    if (typeof avatarRaw !== "string") {
      continue;
    }
    const avatar = avatarRaw.trim();
    if (!avatar) {
      continue;
    }
    if (isAvatarDataUrl(avatar) || isAvatarHttpUrl(avatar)) {
      continue;
    }
    if (avatar.startsWith("~")) {
      issues.push({
        path: `agents.list.${index}.identity.avatar`,
        message: "identity.avatar must be a workspace-relative path, http(s) URL, or data URI.",
      });
      continue;
    }
    const hasScheme = hasAvatarUriScheme(avatar);
    if (hasScheme && !isWindowsAbsolutePath(avatar)) {
      issues.push({
        path: `agents.list.${index}.identity.avatar`,
        message: "identity.avatar must be a workspace-relative path, http(s) URL, or data URI.",
      });
      continue;
    }
    const workspaceDir = resolveAgentWorkspaceDir(
      config,
      entry.id ?? resolveDefaultAgentId(config),
    );
    if (!isWorkspaceAvatarPath(avatar, workspaceDir)) {
      issues.push({
        path: `agents.list.${index}.identity.avatar`,
        message: "identity.avatar must stay within the agent workspace.",
      });
    }
  }
  return issues;
}

function validateGatewayTailscaleBind(config: OpenClawConfig): ConfigValidationIssue[] {
  const tailscaleMode = config.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode !== "serve" && tailscaleMode !== "funnel") {
    return [];
  }
  const bindMode = config.gateway?.bind ?? "loopback";
  if (bindMode === "loopback") {
    return [];
  }
  // lyc: 到这里可能得值: config.gateway.tailscale.mode=serve或funnel, config.gateway.bind=auto或lan或custom或tailnet
  const customBindHost = config.gateway?.customBindHost;
  if (
    bindMode === "custom" &&
    isCanonicalDottedDecimalIPv4(customBindHost) &&
    isLoopbackIpAddress(customBindHost)
  ) {
    return [];
  }
  return [
    {
      path: "gateway.bind",
      message:
        `gateway.bind must resolve to loopback when gateway.tailscale.mode=${tailscaleMode} ` +
        '(use gateway.bind="loopback" or gateway.bind="custom" with gateway.customBindHost="127.0.0.1")',
        // lyc: 当gateway.tailscale.mode=serve或funnel时，gateway.bind必须解析为loopback(使用gateway.bind="loopback"或gateway.bind="custom"，同时设置gateway.customBindHost="127.0.0.1")
    },
  ];
}

/**
 * Validates config without applying runtime defaults.
 * Use this when you need the raw validated config (e.g., for writing back to file).
 */
/* lyc:
  验证配置，而不应用运行时默认值(validateConfigObject函数会应用运行时默认值)
  当您需要原始的已验证配置时（例如，为了写回文件），请使用此方法
  - 验证遗留问题, 基于LEGACY_CONFIG_RULES的配置
  - 验证配置是否符合OpenClawConfig类型的Schema定义
  - 验证是否存在重复的agentDir
  - identity.avatar是否符合要求
  - 验证网关中Tailscale设置是否正确
*/
export function validateConfigObjectRaw(
  raw: unknown,
): { ok: true; config: OpenClawConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  // lyc: 查找遗留配置问题
  const legacyIssues = findLegacyConfigIssues(raw);
  if (legacyIssues.length > 0) {
    return {
      ok: false,
      issues: legacyIssues.map((iss) => ({
        path: iss.path,
        message: iss.message,
      })),
    };
  }
  /* lyc: 
    对配置(raw)进行验证(验证的类型定义基于OpenClawConfig, OpenClawSchema代表验证规则的定义), 
    safeParse不会抛出异常，而是返回一个包含结果或错误信息的对象
    返回的格式: {
      success: boolean,
      data?: parsedData,     // 成功时包含解析后的数据
      error?: ZodError       // 失败时包含错误信息
    }
    */
  const validated = OpenClawSchema.safeParse(raw);
  if (!validated.success) {
    return {
      ok: false,
      issues: validated.error.issues.map((issue) => mapZodIssueToConfigIssue(issue)),
    };
  }
  // lyc: 查找重复的agentDir
  const duplicates = findDuplicateAgentDirs(validated.data as OpenClawConfig);
  if (duplicates.length > 0) {
    return {
      ok: false,
      issues: [
        {
          path: "agents.list",
          message: formatDuplicateAgentDirError(duplicates),
        },
      ],
    };
  }
  // lyc: 验证config.agents.list[].identity.avatar是否符合要求
  const avatarIssues = validateIdentityAvatar(validated.data as OpenClawConfig);
  if (avatarIssues.length > 0) {
    return { ok: false, issues: avatarIssues };
  }
  // lyc: 验证网关中Tailscale设置是否正确
  const gatewayTailscaleBindIssues = validateGatewayTailscaleBind(validated.data as OpenClawConfig);
  if (gatewayTailscaleBindIssues.length > 0) {
    return { ok: false, issues: gatewayTailscaleBindIssues };
  }
  return {
    ok: true,
    config: validated.data as OpenClawConfig,
  };
}

export function validateConfigObject(
  raw: unknown,
): { ok: true; config: OpenClawConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const result = validateConfigObjectRaw(raw);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    config: applyModelDefaults(applyAgentDefaults(applySessionDefaults(result.config))),
  };
}

export function validateConfigObjectWithPlugins(raw: unknown):
  | {
      ok: true;
      config: OpenClawConfig;
      warnings: ConfigValidationIssue[];
    }
  | {
      ok: false;
      issues: ConfigValidationIssue[];
      warnings: ConfigValidationIssue[];
    } {
  return validateConfigObjectWithPluginsBase(raw, { applyDefaults: true });
}

export function validateConfigObjectRawWithPlugins(raw: unknown):
  | {
      ok: true;
      config: OpenClawConfig;
      warnings: ConfigValidationIssue[];
    }
  | {
      ok: false;
      issues: ConfigValidationIssue[];
      warnings: ConfigValidationIssue[];
    } {
  return validateConfigObjectWithPluginsBase(raw, { applyDefaults: false });
}

/* lyc:
  验证config, 入参opts.applyDefaults=true则验证后填充默认值, 否则只是验证config
  加载plugins的manifest(openclaw.plugin.json), 从workspaceDir和config.plugins.load.paths[]中搜索
  验证config.channels是否允许(通过allowedChannels, 如果没有allowedChannels会通过openclaw.plugin.json.channels扩容后再判断是否允许)
  验证config.agents.defaults.heartbeat.target是否允许(通过heartbeatChannelIds)
  验证config.agents.list[].heartbeat.target是否允许(通过heartbeatChannelIds)
  检查config.plugins.entries是否允许(通过knownIds)
  检查config.plugins.allow是否允许(通过knownIds)
  检查config.plugins.deny是否允许(通过knownIds)
  检查config.plugins.slots.memory是否允许(通过knownIds)
  验证每一个plugins是否应该启用(config.plugins中的相关配置或config.channels中相关配置是否开启, 并且检查内存槽决策是否真正开启)
  验证每一个启用(启用则代表必须提供了配置)或提供了配置(config.plugins.entries[pluginId].config)的plugins, 检查它的配置是否正确(manifest(openclaw.plugin.json).configSchema验证配置是否正确)
*/
function validateConfigObjectWithPluginsBase(
  raw: unknown,
  opts: { applyDefaults: boolean },
):
  | {
      ok: true;
      config: OpenClawConfig;
      warnings: ConfigValidationIssue[];
    }
  | {
      ok: false;
      issues: ConfigValidationIssue[];
      warnings: ConfigValidationIssue[];
    } {
  // lyc: opts.applyDefaults=true时，验证配置并对配置应用运行时默认值(session,agent,model部分), 否则只验证配置
  const base = opts.applyDefaults ? validateConfigObject(raw) : validateConfigObjectRaw(raw);
  if (!base.ok) {
    return { ok: false, issues: base.issues, warnings: [] };
  }
  // lyc: 验证后的config
  const config = base.config;
  const issues: ConfigValidationIssue[] = [];
  const warnings: ConfigValidationIssue[] = [];
  // lyc: 是否有明确的plugins配置
  const hasExplicitPluginsConfig =
    isRecord(raw) && Object.prototype.hasOwnProperty.call(raw, "plugins");

  // lyc: 解析plugin配置问题路径, 如果没有提供errorPath或errorPath===<root>则返回base路径, 否则返回base路径+errorPath
  const resolvePluginConfigIssuePath = (pluginId: string, errorPath: string): string => {
    const base = `plugins.entries.${pluginId}.config`;
    if (!errorPath || errorPath === "<root>") {
      return base;
    }
    return `${base}.${errorPath}`;
  };

  type RegistryInfo = {
    registry: ReturnType<typeof loadPluginManifestRegistry>;
    knownIds?: Set<string>;
    normalizedPlugins?: ReturnType<typeof normalizePluginsConfig>;
  };

  let registryInfo: RegistryInfo | null = null;

  // lyc: 加载plugins的manifest
  const ensureRegistry = (): RegistryInfo => {
    if (registryInfo) {
      return registryInfo;
    }

    // lyc: 解析默认agent的workspace
    const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
    // lyc: 加载plugins的manifest, 从workspaceDir和config.plugins.load.paths[]中搜索
    const registry = loadPluginManifestRegistry({
      config,
      workspaceDir: workspaceDir ?? undefined,
    });

    // lyc: 向上级的全局变量(issues, warnings)记录plugins的manifest诊断信息
    for (const diag of registry.diagnostics) {
      let path = diag.pluginId ? `plugins.entries.${diag.pluginId}` : "plugins";
      if (!diag.pluginId && diag.message.includes("plugin path not found")) {
        path = "plugins.load.paths";
      }
      const pluginLabel = diag.pluginId ? `plugin ${diag.pluginId}` : "plugin";
      const message = `${pluginLabel}: ${diag.message}`;
      if (diag.level === "error") {
        issues.push({ path, message });
      } else {
        warnings.push({ path, message });
      }
    }

    registryInfo = { registry };
    return registryInfo;
  };

  // lyc: 加载plugins的manifest中的id
  const ensureKnownIds = (): Set<string> => {
    const info = ensureRegistry();
    if (!info.knownIds) {
      info.knownIds = new Set(info.registry.plugins.map((record) => record.id));
    }
    return info.knownIds;
  };

  // lyc: 加载config.plugins并将其规范化
  const ensureNormalizedPlugins = (): ReturnType<typeof normalizePluginsConfig> => {
    const info = ensureRegistry();
    if (!info.normalizedPlugins) {
      info.normalizedPlugins = normalizePluginsConfig(config.plugins);
    }
    return info.normalizedPlugins;
  };

  // lyc: 允许的channel: {defaults,modelByChannel,telegram,whatsapp,discord,irc,googlechat,slack,signal,imessage}
  const allowedChannels = new Set<string>(["defaults", "modelByChannel", ...CHANNEL_IDS]);

  // lyc: 验证config.channels是否符合allowedChannels的要求, 如果不符合确保将其注册到allowedChannels, 如果注册后仍不符合, 则报告错误(issues)
  if (config.channels && isRecord(config.channels)) {
    for (const key of Object.keys(config.channels)) {
      const trimmed = key.trim();
      if (!trimmed) {
        continue;
      }
      if (!allowedChannels.has(trimmed)) {
        const { registry } = ensureRegistry();
        for (const record of registry.plugins) {
          // lyc: 将plugins的manifest中的channels添加到allowedChannels
          for (const channelId of record.channels) {
            allowedChannels.add(channelId);
          }
        }
      }
      if (!allowedChannels.has(trimmed)) {
        issues.push({
          path: `channels.${trimmed}`,
          message: `unknown channel id: ${trimmed}`,
        });
      }
    }
  }

  const heartbeatChannelIds = new Set<string>();
  for (const channelId of CHANNEL_IDS) {
    heartbeatChannelIds.add(channelId.toLowerCase());
  }

  // lyc: 验证heartbeatChannelIds中是否存在target, 如果没有heartbeatChannelIds会先从插件中扩容, 如果仍然没有则报告错误(issues)
  const validateHeartbeatTarget = (target: string | undefined, path: string) => {
    if (typeof target !== "string") {
      return;
    }
    const trimmed = target.trim();
    if (!trimmed) {
      issues.push({ path, message: "heartbeat target must not be empty" });
      return;
    }
    const normalized = trimmed.toLowerCase();
    if (normalized === "last" || normalized === "none") {
      return;
    }
    if (normalizeChatChannelId(trimmed)) {
      return;
    }
    if (!heartbeatChannelIds.has(normalized)) {
      const { registry } = ensureRegistry();
      for (const record of registry.plugins) {
        for (const channelId of record.channels) {
          const pluginChannel = channelId.trim();
          if (pluginChannel) {
            heartbeatChannelIds.add(pluginChannel.toLowerCase());
          }
        }
      }
    }
    if (heartbeatChannelIds.has(normalized)) {
      return;
    }
    issues.push({ path, message: `unknown heartbeat target: ${target}` });
  };

  // 验证config.agents.defaults.heartbeat.target是否是heartbeatChannelIds中的一个,如果没有则尝试注册, 如果仍然没有则报告错误(issues)
  validateHeartbeatTarget(
    config.agents?.defaults?.heartbeat?.target,
    "agents.defaults.heartbeat.target",
  );
  // 验证config.agents.list[].heartbeat.target是否是heartbeatChannelIds中的一个,如果没有则尝试注册, 如果仍然没有则报告错误(issues)
  if (Array.isArray(config.agents?.list)) {
    for (const [index, entry] of config.agents.list.entries()) {
      validateHeartbeatTarget(entry?.heartbeat?.target, `agents.list.${index}.heartbeat.target`);
    }
  }

  // 如果没有明确的plugins配置
  if (!hasExplicitPluginsConfig) {
    if (issues.length > 0) {
      return { ok: false, issues, warnings };
    }
    return { ok: true, config, warnings };
  }

  const { registry } = ensureRegistry();
  const knownIds = ensureKnownIds();
  const normalizedPlugins = ensureNormalizedPlugins();
  const pushMissingPluginIssue = (
    path: string,
    pluginId: string,
    opts?: { warnOnly?: boolean },
  ) => {
    if (LEGACY_REMOVED_PLUGIN_IDS.has(pluginId)) {
      warnings.push({
        path,
        message: `plugin removed: ${pluginId} (stale config entry ignored; remove it from plugins config)`,
      });
      return;
    }
    if (opts?.warnOnly) {
      warnings.push({
        path,
        message: `plugin not found: ${pluginId} (stale config entry ignored; remove it from plugins config)`,
      });
      return;
    }
    issues.push({
      path,
      message: `plugin not found: ${pluginId}`,
    });
  };

  const pluginsConfig = config.plugins;

  const entries = pluginsConfig?.entries;
  // lyc: 检查config.plugins.entries在knownIds中是否存在, 如果没有则报告错误(warnings)
  if (entries && isRecord(entries)) {
    for (const pluginId of Object.keys(entries)) {
      if (!knownIds.has(pluginId)) {
        // Keep gateway startup resilient when plugins are removed/renamed across upgrades.
        pushMissingPluginIssue(`plugins.entries.${pluginId}`, pluginId, { warnOnly: true });
      }
    }
  }

  const allow = pluginsConfig?.allow ?? [];
  // lyc: 检查config.plugins.allow在knownIds中是否存在, 如果没有则报告错误(issues)
  for (const pluginId of allow) {
    if (typeof pluginId !== "string" || !pluginId.trim()) {
      continue;
    }
    if (!knownIds.has(pluginId)) {
      pushMissingPluginIssue("plugins.allow", pluginId);
    }
  }

  const deny = pluginsConfig?.deny ?? [];
  // lyc: 检查config.plugins.deny在knownIds中是否存在, 如果没有则报告错误(issues)
  for (const pluginId of deny) {
    if (typeof pluginId !== "string" || !pluginId.trim()) {
      continue;
    }
    if (!knownIds.has(pluginId)) {
      pushMissingPluginIssue("plugins.deny", pluginId);
    }
  }

  const memorySlot = normalizedPlugins.slots.memory;
  // lyc: 检查config.plugins.slots.memory在knownIds中是否存在, 如果没有则报告错误(issues)
  if (typeof memorySlot === "string" && memorySlot.trim() && !knownIds.has(memorySlot)) {
    pushMissingPluginIssue("plugins.slots.memory", memorySlot);
  }

  const seenPlugins = new Set<string>();
  let selectedMemoryPluginId: string | null = null;
  // lyc: 遍历config.plugins的manifest(openclaw.plugin.json)
  for (const record of registry.plugins) {
    const pluginId = record.id;
    if (seenPlugins.has(pluginId)) {
      continue;
    }
    seenPlugins.add(pluginId);
    // lyc: 检查config.plugins.entries是否存在当前manifest.id的配置(PluginEntryConfig)
    const entry = normalizedPlugins.entries[pluginId];
    // lyc: 检查config.plugins.entries是否配置了当前manifest
    const entryHasConfig = Boolean(entry?.config);
    // lyc: 检查当前manifest是否启用
    const enableState = resolveEffectiveEnableState({
      id: pluginId,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: config,
    });
    let enabled = enableState.enabled;
    let reason = enableState.reason;

    /* lyc: 如果当前manifest启用则进一步检查内存槽决策来决定是否启用当前manifest*/
    if (enabled) {
      const memoryDecision = resolveMemorySlotDecision({
        id: pluginId,
        kind: record.kind,
        slot: memorySlot,
        selectedId: selectedMemoryPluginId,
      });
      if (!memoryDecision.enabled) {
        enabled = false;
        reason = memoryDecision.reason;
      }
      if (memoryDecision.selected && record.kind === "memory") {
        selectedMemoryPluginId = pluginId;
      }
    }
    // lyc: 当前插件manifest可以启用 || config.plugins.entries中对当前插件进行了配置
    const shouldValidate = enabled || entryHasConfig;
    // 对当前插件的配置进行验证
    if (shouldValidate) {
      if (record.configSchema) {
        // lyc: 验证当前插件的配置是否符合要求, 即用manifest.configSchema验证config.plugins.entries[pluginId].config是否正确
        const res = validateJsonSchemaValue({
          schema: record.configSchema,
          cacheKey: record.schemaCacheKey ?? record.manifestPath ?? pluginId,
          value: entry?.config ?? {},
        });
        if (!res.ok) {
          for (const error of res.errors) {
            issues.push({
              path: resolvePluginConfigIssuePath(pluginId, error.path),
              message: `invalid config: ${error.message}`,
              allowedValues: error.allowedValues,
              allowedValuesHiddenCount: error.allowedValuesHiddenCount,
            });
          }
        }
      } else {
        issues.push({
          path: `plugins.entries.${pluginId}`,
          message: `plugin schema missing for ${pluginId}`,
        });
      }
    }

    if (!enabled && entryHasConfig) {
      warnings.push({
        path: `plugins.entries.${pluginId}`,
        message: `plugin disabled (${reason ?? "disabled"}) but config is present`,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, warnings };
  }

  return { ok: true, config, warnings };
}
