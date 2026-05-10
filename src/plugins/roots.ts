import path from "node:path";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

export type PluginSourceRoots = {
  stock?: string;
  global: string;
  workspace?: string;
};

export type PluginCacheInputs = {
  roots: PluginSourceRoots;
  loadPaths: string[];
};

/* lyc: 解析插件源根目录 { stock: packageRoot/.../extensions, global: openclaw的配置目录/extensions, workspace: workspaceRoot/.openclaw/extensions }
stock: 捆绑|内置 插件所在目录 | OpenClaw插件的捆绑根目录, 一般在 packageRoot/dist-runtime|dist|""/extensions
global: OpenClaw全局插件目录， 一般在 openclaw的配置目录/extensions
workspace: OpenClaw工作空间插件目录， 一般在 工作空间目录/.openclaw/extensions
*/
export function resolvePluginSourceRoots(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginSourceRoots {
  const env = params.env ?? process.env;
  const workspaceRoot = params.workspaceDir ? resolveUserPath(params.workspaceDir, env) : undefined;
  // lyc: 解析 捆绑|内置 插件所在目录 | OpenClaw插件的捆绑根目录
  const stock = resolveBundledPluginsDir(env);
  // lyc: openclaw的配置目录/extensions
  const global = path.join(resolveConfigDir(env), "extensions");
  // lyc: 工作空间目录/.openclaw/extensions
  const workspace = workspaceRoot ? path.join(workspaceRoot, ".openclaw", "extensions") : undefined;
  return { stock, global, workspace };
}

// Shared env-aware cache inputs for discovery, manifest, and loader caches.
// lyc: 用于发现、清单和加载器缓存的共享环境感知缓存输入
/* lyc: 解析插件缓存输入: 由插件源根目录(roots|SourceRoots) 和 加载路径(loadPaths) 组成
{ roots(插件源根目录): { stock: packageRoot/.../extensions, global: openclaw的配置目录/extensions, workspace: workspaceRoot/.openclaw/extensions } , 
 loadPaths(加载路径): [...]}
 */
export function resolvePluginCacheInputs(params: {
  workspaceDir?: string;
  loadPaths?: string[];
  env?: NodeJS.ProcessEnv;
}): PluginCacheInputs {
  const env = params.env ?? process.env;
  // lyc: 解析插件源根目录 { stock: packageRoot/.../extensions, global: openclaw的配置目录/extensions, workspace: workspaceRoot/.openclaw/extensions }
  const roots = resolvePluginSourceRoots({
    workspaceDir: params.workspaceDir,
    env,
  });
  // Preserve caller order because load-path precedence follows input order.
  // lyc: 保持调用者顺序，因为加载路径优先级遵循输入顺序。
  const loadPaths = (params.loadPaths ?? [])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolveUserPath(entry, env));
  return { roots, loadPaths };
}
