import { normalizePluginsConfig } from "./config-state.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "./discovery.js";
import type { LoadInstalledPluginIndexParams } from "./installed-plugin-index-types.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";

// lyc: 解析已安装插件索引注册表 {candidates: 所有插件候选记录, registry: 所有后选记录的插件清单注册表(registry)}
export function resolveInstalledPluginIndexRegistry(params: LoadInstalledPluginIndexParams): {
  registry: PluginManifestRegistry;
  candidates: readonly PluginCandidate[];
} {
  if (params.candidates) {
    return {
      candidates: params.candidates,
      registry: loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        cache: false,
        env: params.env,
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        installRecords: params.installRecords,
      }),
    };
  }

  const normalized = normalizePluginsConfig(params.config?.plugins);
  const discovery = discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    extraPaths: normalized.loadPaths,
    cache: params.cache,
    env: params.env,
  });
  return {
    candidates: discovery.candidates,
    registry: loadPluginManifestRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      cache: false,
      env: params.env,
      candidates: discovery.candidates,
      diagnostics: discovery.diagnostics,
      installRecords: params.installRecords,
    }),
  };
}
