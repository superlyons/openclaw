# 孤儿注释存档

> 当 upstream 删除了某段代码、而你的注释附着在它上面时，注释会变成"孤儿"。
> 简单删除会丢失你的学习成果——这里存档下来，未来如需要可以恢复或迁移。

---

## 1. `scripts/stage-bundled-plugin-runtime-deps.mjs` → `stageBundledPluginRuntimeDeps()`

**孤立时间**：v2026.5.18 merge 时（2026-05-20）
**孤立原因**：upstream 整个删除了 `scripts/stage-bundled-plugin-runtime-deps.mjs` 文件，
            `stageBundledPluginRuntimeDeps` 函数在 v2026.5.18 全代码库**完全不存在**了。
**可能的替代**：`scripts/stage-bundled-plugin-runtime.mjs`（名字相近但**不是同一函数**）。

### 原注释（你写的 `lyc` JSDoc 块）

```js
/** lyc
 * 分阶段处理捆绑插件的运行时依赖
 *
 * 此函数为标记了 bundle.stageRuntimeDependencies=true 的插件
 * 安装或复制其运行时依赖到 dist/extensions/{plugin}/node_modules/ 目录。
 *
 * 处理流程：
 * 1. 扫描 dist/extensions/ 目录下的所有插件
 * 2. 检查插件是否需要运行时依赖（package.json.dependencies 或 optionalDependencies 存在）
 * 3. 检查插件是否标记为需要分阶段处理运行时依赖（package.json.openclaw.bundle.stageRuntimeDependencies=true）
 * 4. 计算依赖指纹，避免重复安装相同的依赖
 * 5. 尝试从根目录 node_modules 复用已安装的依赖（如果版本兼容）
 * 6. 如果无法复用，则独立安装依赖到插件的 node_modules 目录
 * 7. 对安装的依赖进行清理，移除不需要的文件（如 .d.ts、测试文件等）
 *
 * 这种设计确保每个插件都有其完整的运行时依赖，避免依赖冲突，
 * 同时通过指纹机制优化构建性能，避免不必要的重复安装。
 *
 * @param {Object} params - 配置参数对象
 * @param {string} [params.cwd] - 当前工作目录
 * @param {string} [params.repoRoot] - 仓库根目录，默认使用 cwd 或 process.cwd()
 * @param {Function} [params.installPluginRuntimeDepsImpl] - 依赖安装实现函数，默认使用内部实现
 * @param {number} [params.installAttempts] - 安装重试次数，默认为 3
 * @param {Map} [params.stagedRuntimeDepPruneRules] - 依赖清理规则，默认使用内置规则
 * @param {string[]} [params.stagedRuntimeDepGlobalPruneSuffixes] - 全局清理后缀，默认移除 .d.ts 和 .map 文件
 */
export function stageBundledPluginRuntimeDeps(params = {}) { ... }
```

### 备注

这段注释总结了**捆绑插件运行时依赖的整套设计思路**——即使函数没了，这个**机制层面的理解仍有学习价值**。
如果未来你想理解 OpenClaw 是如何处理插件依赖隔离的，这段笔记仍是一个好的起点。
看 `scripts/stage-bundled-plugin-runtime.mjs` 是否做了类似事情。

---

## 2. `src/config/io.ts` → `resolveLegacyConfigForRead()`

**孤立时间**：v2026.5.18 merge 时（2026-05-20）
**孤立原因**：upstream 删除了 `resolveLegacyConfigForRead` 函数，全代码库都没有它了。
**等效替代**：未知。legacy migration 逻辑可能内联到了 `applyRuntimeLegacyConfigMigrations` 的调用方。

### 原注释（你写的 `// lyc:` 行）

```ts
// lyc: 解析配置文件中的插件兼容性问题, 并返回解析后的配置对象。
function resolveLegacyConfigForRead(
  // lyc: configPath配置文件解析后的配置对象, 已处理$include指令和环境变量引用
  resolvedConfigRaw: unknown,
  // lyc: 原始配置文件解析后的配置对象, 未处理$include指令和环境变量引用
  sourceRaw: unknown,
): LegacyMigrationResolution {
  // lyc: 计算所有可能的插件ID，从 resolvedConfigRaw 配置的channels, plugins.entries 和 talk中提取
  const pluginIds = collectRelevantDoctorPluginIds(resolvedConfigRaw);
  ...
}
```

### 备注

理解要点：**两层配置对象**（解析后的 + 原始的）+ **从配置中扫描所有可能的插件 ID** 这两个概念仍然有效，
只是承载它们的函数名变了。日后阅读 v2026.5 的 legacy migration 调用链时可以回看这段。

---

## 3. `src/plugins/plugin-registry-snapshot.ts` → `resolveDerivedSnapshotCacheKey()`

**孤立时间**：v2026.5.18 merge 时
**孤立原因**：upstream 删了整个"派生快照缓存"机制（`resolveDerivedSnapshotCacheKey` + `derivedSnapshotCache`），改用别的 staleness 检测（hashExistingFile/hasStalePersistedPluginDiagnostics/hasStalePersistedPluginMetadata 等）。
**等效替代**：没有 1:1 替代，但缓存命中的"信号"现在分散在多个 has-stale-* helper 里。

### 原注释（你的 `lyc:` 注释 + 函数本体）

```ts
/* lyc: 解析派生快照缓存键, 组成成分:
持久化插件注册表存储路径, 插件源根目录, 加载路径, openclaw 版本, 环境变量(禁用持久化插件注册表,禁用捆绑插件,VITEST)组成
入参 params 只有提供: cache=非false值, preferPersisted=非false值, env, index 属性时才会执行逻辑, 否则返回 null
*/
function resolveDerivedSnapshotCacheKey(params, env): string | null {
  ...
  const { roots, loadPaths } = resolvePluginCacheInputs({ env });
  return JSON.stringify({
    persistedStore: resolveInstalledPluginIndexStorePath({ env }),   // ~/.openclaw/plugins/installs.json
    roots,                                                            // { stock, global, workspace }
    loadPaths,                                                        // []
    hostContractVersion: resolveCompatibilityHostVersion(env),        // openclaw 版本，默认 "unknown"
    disablePersisted: env[DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV],     // 禁用持久化注册表的开关
    disableBundled: env.OPENCLAW_DISABLE_BUNDLED_PLUGINS,
    vitest: env.VITEST,
  });
}
```

### 备注

这套机制理解的核心是"什么改了缓存就该失效"——v2026.5 改用更直接的"读文件 hash 对比"方式，但**"哪些输入决定快照"** 这个清单（持久化路径 / roots / loadPaths / 版本 / 几个环境变量）仍然是有效的认知。
