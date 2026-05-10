export type PluginEntryConfig = {
  enabled?: boolean;
  hooks?: {
    /** Controls prompt mutation via before_prompt_build and prompt fields from legacy before_agent_start. */
    allowPromptInjection?: boolean;
    /**
     * Controls access to raw conversation content from llm_input/llm_output/agent_end hooks.
     * Non-bundled plugins must opt in explicitly; bundled plugins stay allowed unless disabled.
     */
    allowConversationAccess?: boolean;
  };
  subagent?: {
    /** Explicitly allow this plugin to request per-run provider/model overrides for subagent runs. */
    allowModelOverride?: boolean;
    /**
     * Allowed override targets as canonical provider/model refs.
     * Use "*" to explicitly allow any model for this plugin.
     */
    allowedModels?: string[];
  };
  config?: Record<string, unknown>;
};

export type PluginSlotsConfig = {
  /** Select which plugin owns the memory slot ("none" disables memory plugins). */
  // lyc: 选择哪个插件拥有该内存槽（“none”表示禁用内存插件）。
  memory?: string;
  /** Select which plugin owns the context-engine slot. */
  // lyc: 选择哪个插件拥有该上下文引擎槽。
  contextEngine?: string;
};

export type PluginsLoadConfig = {
  /** Additional plugin/extension paths to load. */
  paths?: string[];
};

/* lyc: PluginInstallRecord 类型 是基于InstallRecordBase修改后的类型
1.移除InstallRecordBase中的source属性, 保留其它属性 (Omit<InstallRecordBase, "source">)
2.从新定义了InstallRecordBase.source属性, "npm" | "archive" | "path" | "clawhub" | "marketplace"
3.添加了marketplaceName, marketplaceSource, marketplacePlugin 三个可选属性
*/
export type PluginInstallRecord = Omit<InstallRecordBase, "source"> & {
  source: InstallRecordBase["source"] | "marketplace";
  marketplaceName?: string;
  marketplaceSource?: string;
  marketplacePlugin?: string;
};

export type PluginsConfig = {
  /** Enable or disable plugin loading. */
  enabled?: boolean;
  /** Optional plugin allowlist (plugin ids). */
  allow?: string[];
  /** Optional plugin denylist (plugin ids). */
  deny?: string[];
  load?: PluginsLoadConfig;
  slots?: PluginSlotsConfig;
  entries?: Record<string, PluginEntryConfig>;
  /**
   * Internal transient carrier for plugin install records during command flows.
   * This is intentionally omitted from the config schema and must not be
   * persisted to openclaw.json.
   */
  installs?: Record<string, PluginInstallRecord>;
};
import type { InstallRecordBase } from "./types.installs.js";
