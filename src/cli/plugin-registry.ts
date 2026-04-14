import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginLogger } from "../plugins/types.js";

const log = createSubsystemLogger("plugins");
let pluginRegistryLoaded = false;

// lyc: 确保插件注册表已加载
export function ensurePluginRegistryLoaded(): void {
  if (pluginRegistryLoaded) {
    return;
  }
  // lyc: 获得当前活动的插件注册表
  const active = getActivePluginRegistry();
  // Tests (and callers) can pre-seed a registry (e.g. `test/setup.ts`); avoid
  // doing an expensive load when we already have plugins/channels/tools.
  // lyc: 测试（还有调用者）可以预先填充注册表（例如通过`test/setup.ts`填充）；当我们已经有插件/通道/工具时，避免进行昂贵的加载操作。
  if (
    active &&
    (active.plugins.length > 0 || active.channels.length > 0 || active.tools.length > 0)
  ) {
    pluginRegistryLoaded = true;
    return;
  }

  // lyc: 这里开始进行昂贵的加载操作，加载插件注册表

  const config = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const logger: PluginLogger = {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    debug: (msg) => log.debug(msg),
  };
  // lyc: 加载插件注册表
  loadOpenClawPlugins({
    config,
    workspaceDir,
    logger,
  });
  pluginRegistryLoaded = true;
}
