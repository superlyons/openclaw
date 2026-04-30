import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveManifestCommandAliasOwnerInRegistry,
  type PluginManifestCommandAliasRecord,
  type PluginManifestCommandAliasRegistry,
} from "../plugins/manifest-command-aliases.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";

// lyc: 将 --update 标志转换为 update 命令 例如: openclaw agent --message "hello" --update -> openclaw agent --message "hello" update
export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

// lyc: 检查当前命令(commandPath)是否需要确保CLI路径
export function shouldEnsureCliPath(argv: string[]): boolean {
  // lyc: 解析调用信息, 获得命令路径, 主命令, 是否有帮助或版本选项, 是否为根帮助调用
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion || shouldStartCrestodianForBareRoot(argv)) {
    return false;
  }
  // lyc: 检查命令的策略配置是否需要确保CLI路径, 
  return resolveCliCommandPathPolicy(invocation.commandPath).ensureCliPath;
}

// lyc:ai 检查是否应该使用根帮助快速路径. 当用户请求根级别的帮助信息时返回true，可以跳过完整的命令注册流程
export function shouldUseRootHelpFastPath(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return (
    env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH !== "1" &&
    (invocation.isRootHelpInvocation ||
      (invocation.commandPath.length === 1 &&
        invocation.commandPath[0] === "help" &&
        invocation.hasHelpOrVersion))
  );
}

export function shouldUseBrowserHelpFastPath(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.commandPath.length === 1 &&
    invocation.commandPath[0] === "browser" &&
    invocation.hasHelpOrVersion
  );
}

// lyc: 检查是否应该启动Crestodian(克雷斯托迪安), 当用户请求根命令(openclaw)时返回true
export function shouldStartCrestodianForBareRoot(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return invocation.commandPath.length === 0 && !invocation.hasHelpOrVersion;
}

// lyc: 检查是否应该启动Crestodian(克雷斯托迪安), 当用户请求onboard命令并添加--modern标志时返回true
export function shouldStartCrestodianForModernOnboard(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.commandPath[0] === "onboard" &&
    argv.includes("--modern") &&
    !invocation.hasHelpOrVersion
  );
}

export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
  options?: {
    registry?: PluginManifestCommandAliasRegistry;
    resolveCommandAliasOwner?: (params: {
      command: string | undefined;
      config?: OpenClawConfig;
      registry?: PluginManifestCommandAliasRegistry;
    }) => PluginManifestCommandAliasRecord | undefined;
  },
): string | null {
  const normalizedPluginId = normalizeLowercaseStringOrEmpty(pluginId);
  if (!normalizedPluginId) {
    return null;
  }
  const allow =
    Array.isArray(config?.plugins?.allow) && config.plugins.allow.length > 0
      ? config.plugins.allow
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => normalizeOptionalLowercaseString(entry))
          .filter(Boolean)
      : [];
  const commandAlias = options?.registry
    ? resolveManifestCommandAliasOwnerInRegistry({
        command: normalizedPluginId,
        registry: options.registry,
      })
    : options?.resolveCommandAliasOwner?.({
        command: normalizedPluginId,
        config,
        ...(options?.registry ? { registry: options.registry } : {}),
      });
  const parentPluginId = commandAlias?.pluginId;
  if (parentPluginId) {
    if (allow.length > 0 && !allow.includes(parentPluginId)) {
      return (
        `"${normalizedPluginId}" is not a plugin; it is a command provided by the ` +
        `"${parentPluginId}" plugin. Add "${parentPluginId}" to \`plugins.allow\` ` +
        `instead of "${normalizedPluginId}".`
      );
    }
    if (config?.plugins?.entries?.[parentPluginId]?.enabled === false) {
      return (
        `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
        `\`plugins.entries.${parentPluginId}.enabled=false\`. Re-enable that entry if you want ` +
        "the bundled plugin command surface."
      );
    }
    if (commandAlias.kind === "runtime-slash") {
      const cliHint = commandAlias.cliCommand
        ? `Use \`openclaw ${commandAlias.cliCommand}\` for related CLI operations, or `
        : "Use ";
      return (
        `"${normalizedPluginId}" is a runtime slash command (/${normalizedPluginId}), not a CLI command. ` +
        `It is provided by the "${parentPluginId}" plugin. ` +
        `${cliHint}\`/${normalizedPluginId}\` in a chat session.`
      );
    }
  }

  if (allow.length > 0 && !allow.includes(normalizedPluginId)) {
    if (parentPluginId && allow.includes(parentPluginId)) {
      return null;
    }
    return (
      `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
      `\`plugins.allow\` excludes "${normalizedPluginId}". Add "${normalizedPluginId}" to ` +
      `\`plugins.allow\` if you want that bundled plugin CLI surface.`
    );
  }
  if (config?.plugins?.entries?.[normalizedPluginId]?.enabled === false) {
    return (
      `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
      `\`plugins.entries.${normalizedPluginId}.enabled=false\`. Re-enable that entry if you want ` +
      "the bundled plugin CLI surface."
    );
  }
  return null;
}
