import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";

const DISABLED_BUNDLED_PLUGINS_DIR = path.join(os.tmpdir(), "openclaw-empty-bundled-plugins");

function bundledPluginsDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = normalizeOptionalLowercaseString(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS);
  return raw === "1" || raw === "true";
}

// lyc: 返回禁用捆绑插件时的插件目录路径: 例如: /tmp/openclaw-empty-bundled-plugins
function resolveDisabledBundledPluginsDir(): string {
  fs.mkdirSync(DISABLED_BUNDLED_PLUGINS_DIR, { recursive: true });
  return DISABLED_BUNDLED_PLUGINS_DIR;
}

// lyc: 判断是否是签出的源代码根目录
function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    fs.existsSync(path.join(packageRoot, ".git")) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
  );
}

// lyc: 判断是否有可用的捆绑插件树, pluginsDir目录下全是插件目录, 每个插件目录下有package.json或openclaw.plugin.json
function hasUsableBundledPluginTree(pluginsDir: string): boolean {
  if (!fs.existsSync(pluginsDir)) {
    return false;
  }
  try {
    return fs.readdirSync(pluginsDir, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      const pluginDir = path.join(pluginsDir, entry.name);
      return (
        fs.existsSync(path.join(pluginDir, "package.json")) ||
        fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"))
      );
    });
  } catch {
    return false;
  }
}

// lyc: 判断是否是运行TypeScript进程 .ts, .tsx, .mts, .cts
function runningSourceTypeScriptProcess(): boolean {
  const argv1 = process.argv[1]?.toLowerCase();
  if (
    argv1?.endsWith(".ts") ||
    argv1?.endsWith(".tsx") ||
    argv1?.endsWith(".mts") ||
    argv1?.endsWith(".cts")
  ) {
    return true;
  }

  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index]?.toLowerCase();
    if (!arg) {
      continue;
    }
    if (arg === "tsx" || arg.includes("tsx/register")) {
      return true;
    }
    if ((arg === "--import" || arg === "--loader") && process.execArgv[index + 1]) {
      const next = process.execArgv[index + 1].toLowerCase();
      if (next === "tsx" || next.includes("tsx/")) {
        return true;
      }
    }
  }

  return false;
}

/* lyc: 解析 捆绑|内置 插件目录路径
可能返回的值: 
sourceExtensionsDir = "packageRoot/extensions": preferSourceCheckout & sourceExtensionsDir 存在这个目录
runtimeExtensionsDir = "packageRoot/dist-runtime/extensions": runtimeExtensionsDir 和 builtExtensionsDir 目录都存在
builtExtensionsDir = "packageRoot/dist/extensions": builtExtensionsDir 存在这个目录
sourceExtensionsDir = "packageRoot/extensions": packageRoot是签出的源代码根目录 & sourceExtensionsDir 存在这个目录
undefined: 否则返回undefined
*/
function resolveBundledDirFromPackageRoot(
  packageRoot: string,
  preferSourceCheckout: boolean,
): string | undefined {
  // lyc: 基于 根package.json 所在的目录 下的扩展目录
  const sourceExtensionsDir = path.join(packageRoot, "extensions");
  // lyc: 基于 根package.json 所在的目录 下的dist目录下的扩展目录
  const builtExtensionsDir = path.join(packageRoot, "dist", "extensions");
  // lyc: 基于 根package.json 所在的目录 是否是签出的源代码根目录
  const sourceCheckout = isSourceCheckoutRoot(packageRoot);
  // lyc: 如果优先使用源代码根目录的扩展目录(preferSourceCheckout=true), 且源代码根目录存在扩展目录(存在extensions目录), 则返回源代码根目录的扩展目录地址(extensions目录)
  if (preferSourceCheckout && fs.existsSync(sourceExtensionsDir)) {
    return sourceExtensionsDir;
  }
  // Local source checkouts stage a runtime-complete bundled plugin tree under
  // dist-runtime/. Prefer that over source extensions only when the paired
  // dist/ tree exists; otherwise wrappers can drift ahead of the last build.
  // lyc: 本地源代码签出会在dist-runtime/目录下构建一个运行时完整的打包插件树。只有在配套的dist/目录存在时，才优先使用本地源代码签出；否则，包装器可能会超前于最后一次构建。
  // lyc: 基于 根package.json 所在的目录 下的dist-runtime目录下的扩展目录
  const runtimeExtensionsDir = path.join(packageRoot, "dist-runtime", "extensions");
  // lyc: 是否拥有可用的 运行时完整的打包插件树
  const hasUsableRuntimeTree = sourceCheckout
    ? hasUsableBundledPluginTree(runtimeExtensionsDir)
    : fs.existsSync(runtimeExtensionsDir);
  // lyc: 是否拥有可用的 构建时完整的打包插件树
  const hasUsableBuiltTree = sourceCheckout
    ? hasUsableBundledPluginTree(builtExtensionsDir)
    : fs.existsSync(builtExtensionsDir);
  // lyc: 如果 运行时完整的打包插件树 和 构建时完整的打包插件树 都存在, 则返回 运行时完整的打包插件树 的 扩展目录地址(runtimeExtensionsDir)
  if (hasUsableRuntimeTree && hasUsableBuiltTree) {
    return runtimeExtensionsDir;
  }
  if (hasUsableBuiltTree) {
    return builtExtensionsDir;
  }
  if (sourceCheckout && fs.existsSync(sourceExtensionsDir)) {
    return sourceExtensionsDir;
  }
  return undefined;
}

/* lyc: 解析 捆绑|内置 插件所在目录 
packageRoot: 插件的包清单文件(package.json)所在目录
  以OPENCLAW_BUNDLED_PLUGINS_DIR|argv1|process.cwd|import.meta.url|node.exe所在目录 为基点查找 根package.json(插件的包清单文件) 所在的目录
  packageRoot=根package.json, 它必须满足有name字段, 且name字段的值在 CORE_PACKAGE_NAMES 中即值为openclaw
可能返回的值:
  /tmp/openclaw-empty-bundled-plugins 如果 env.OPENCLAW_DISABLE_BUNDLED_PLUGINS=true 返回该路径
  {packageRoot}/dist-runtime/extensions
  {packageRoot}/dist/extensions
  {packageRoot}/extensions
  {execDir}/dist/extensions
  {execDir}/extensions
  {当前文件所在目录..向上查找6层目录}/extensions
  undefined
执行流程:
如果 env.OPENCLAW_DISABLE_BUNDLED_PLUGINS=true 返回 /tmp/openclaw-empty-bundled-plugins
如果指定了env.OPENCLAW_BUNDLED_PLUGINS_DIR, 
  env.OPENCLAW_BUNDLED_PLUGINS_DIR 路径存在, 则返回该路径的绝对地址
  env.OPENCLAW_BUNDLED_PLUGINS_DIR 路径不存在 & 以argv1为基点找到 根package.json 所在的目录 & 根package.json 所在的目录 不是 签出的源代码根目录 
    根package.json 所在的目录/dist-runtime/extensions 存在返回该路径, 否则
    根package.json 所在的目录/dist/extensions 存在返回该路径
  env.OPENCLAW_BUNDLED_PLUGINS_DIR路径不存在 & 上诉查找失败, 则返回env.OPENCLAW_BUNDLED_PLUGINS_DIR 的绝对地址
分别从 argv1, process.cwd(), import.meta.url 为基点查找 packageRoot=根package.json 所在的目录, 再从packageRoot(3个目录)查找插件目录
  返回sourceExtensionsDir = "packageRoot/extensions": preferSourceCheckout(是否优先使用签出的源代码根目录) & sourceExtensionsDir 存在这个目录
  返回runtimeExtensionsDir = "packageRoot/dist-runtime/extensions": runtimeExtensionsDir 和 builtExtensionsDir 目录都存在
  返回builtExtensionsDir = "packageRoot/dist/extensions": builtExtensionsDir 存在这个目录
  返回sourceExtensionsDir = "packageRoot/extensions": packageRoot是签出的源代码根目录 & sourceExtensionsDir 存在这个目录
从node.exe所在目录(execDir,例如:/usr/bin/node->/usr/bin)查找插件目录:
  execDir/dist/extensions 目录存在则返回该路径
  execDir/extensions 目录存在则返回该路径
从当前模块(当前文件bundled-dir.ts)所在目录开始查找
  向上遍历6层目录, 直到找到 extensions 目录后返回
以上均为找到则返回undefined
*/
export function resolveBundledPluginsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // lyc: 如果禁用捆绑插件: env.OPENCLAW_DISABLE_BUNDLED_PLUGINS=true 
  if (bundledPluginsDisabled(env)) {
    // lyc: 返回禁用捆绑插件时的插件目录路径: 例如: /tmp/openclaw-empty-bundled-plugins
    return resolveDisabledBundledPluginsDir();
  }
  // lyc: 如果指定了捆绑插件目录: env.OPENCLAW_BUNDLED_PLUGINS_DIR=...
  const override = env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  if (override) {
    // lyc: 指定的捆绑插件目录路径如果存在，返回该路径
    const resolvedOverride = resolveUserPath(override, env);
    if (fs.existsSync(resolvedOverride)) {
      return resolvedOverride;
    }

    // lyc: 这里代表: env.OPENCLAW_BUNDLED_PLUGINS_DIR 指定了 捆绑插件目录 但它不存在

    // Installed CLIs can inherit stale bundled-dir overrides from older shells
    // or debug sessions. Prefer the package that owns argv[1] over a broken
    // override so bundled providers keep working in packaged installs.
    // lyc: 已安装的命令行界面（CLI）可能会继承来自旧Shell或调试会话的过时的bundled-dir覆盖。相比于一个已损坏的覆盖，更推荐使用拥有argv[1]的包，这样捆绑式提供程序在打包安装中就能继续正常工作。
    try {
      // lyc: 以argv1为根目录，向上查找 根package.json 所在的目录, 找到返回这个目录, 否则返回null
      const argvPackageRoot = resolveOpenClawPackageRootSync({ argv1: process.argv[1] });
      // lyc: 如果找到 根package.json 所在的目录 并且 不是签出的源代码根目录, 则返回这个目录的捆绑插件目录
      if (argvPackageRoot && !isSourceCheckoutRoot(argvPackageRoot)) {
        // lyc: 解析 捆绑|内置 插件目录路径
        const argvFallback = resolveBundledDirFromPackageRoot(argvPackageRoot, false);
        if (argvFallback) {
          return argvFallback;
        }
      }
    } catch {
      // ignore
    }
    // lyc: 如果以上所有尝试都失败了, 则返回指定的捆绑插件目录路径
    return resolvedOverride;
  }                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             

  // lyc: 是否优先使用签出的源代码根目录: env.VITEST=true | 如果是运行TypeScript进程(.ts, .tsx, .mts, .cts)
  const preferSourceCheckout = Boolean(env.VITEST) || runningSourceTypeScriptProcess();

  try {
    // lyc: 分别从 argv1, process.cwd(), import.meta.url 查找 根package.json 所在的目录
    const argvRoot = resolveOpenClawPackageRootSync({ argv1: process.argv[1] });
    const cwdRoot = resolveOpenClawPackageRootSync({ cwd: process.cwd() });
    const moduleRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
    // lyc: 根据 是否优先使用源代码根目录, 来判断查找顺序
    const packageRoots = (
      preferSourceCheckout ? [cwdRoot, argvRoot, moduleRoot] : [argvRoot, cwdRoot, moduleRoot]
    ).filter(
      (entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index,
    );
    for (const packageRoot of packageRoots) {
      // lyc: 解析 捆绑|内置 插件目录路径
      const bundledDir = resolveBundledDirFromPackageRoot(packageRoot, preferSourceCheckout);
      if (bundledDir) {
        return bundledDir;
      }
    }
  } catch {
    // ignore
  }

  // bun --compile: ship a sibling bundled plugin tree next to the executable.
  // lyc: bun开发环境, bun --compile：将一个与可执行文件捆绑在一起的兄弟插件树打包发布。
  try {
    // lyc: 获取获取当前 Node.js 进程可执行文件所在目录, 例如/usr/bin/node ->> /usr/bin
    const execDir = path.dirname(process.execPath);
    // lyc: 检查是否存在 execDir/dist/extensions 目录
    const siblingBuilt = path.join(execDir, "dist", "extensions");
    if (fs.existsSync(siblingBuilt)) {
      return siblingBuilt;
    }
    // lyc: 检查是否存在 execDir/extensions 目录
    const sibling = path.join(execDir, "extensions");
    if (fs.existsSync(sibling)) {
      return sibling;
    }
  } catch {
    // ignore
  }

  // npm/dev: walk up from this module to find the bundled plugin tree at the package root.
  // lyc: npm开发环境, npm/dev：从该模块向上遍历，在包根目录下找到绑定的插件树。
  try {
    // lyc: cursor = 当前模块(当前文件bundled-dir.ts)所在目录
    let cursor = path.dirname(fileURLToPath(import.meta.url));
    // lyc: 从当前模块所在目录开始, 向上遍历6层目录, 直到找到 extensions 目录
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(cursor, "extensions");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(cursor);
      // lyc: 如果 parent 与 cursor 相同, 则说明已经到达根目录, 则跳出循环
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }

  return undefined;
}
