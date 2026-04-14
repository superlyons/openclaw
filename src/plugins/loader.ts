import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { clearPluginCommands } from "./commands.js";
import {
  applyTestPluginDefaults,
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveMemorySlotDecision,
  type NormalizedPluginsConfig,
} from "./config-state.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { initializeGlobalHookRunner } from "./hook-runner-global.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { isPathInside, safeStatSync } from "./path-safety.js";
import { createPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import type {
  OpenClawPluginDefinition,
  OpenClawPluginModule,
  PluginDiagnostic,
  PluginLogger,
} from "./types.js";

export type PluginLoadResult = PluginRegistry;

export type PluginLoadOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  cache?: boolean;
  mode?: "full" | "validate";
};

const registryCache = new Map<string, PluginRegistry>();

const defaultLogger = () => createSubsystemLogger("plugins");

// lyc: 已当前文件地址(import.meta.url)为基准进行查找(src|dist)+/plugin-sdk/+(srcFile|distFile)的真实存在路径, 会向上查找6层目录
const resolvePluginSdkAliasFile = (params: {
  srcFile: string;
  distFile: string;
  modulePath?: string;
}): string | null => {
  try {
    const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
    const isProduction = process.env.NODE_ENV === "production";
    const isTest = process.env.VITEST || process.env.NODE_ENV === "test";
    const normalizedModulePath = modulePath.replace(/\\/g, "/");
    const isDistRuntime = normalizedModulePath.includes("/dist/");
    let cursor = path.dirname(modulePath);
    for (let i = 0; i < 6; i += 1) {
      const srcCandidate = path.join(cursor, "src", "plugin-sdk", params.srcFile);
      const distCandidate = path.join(cursor, "dist", "plugin-sdk", params.distFile);
      const orderedCandidates = isDistRuntime
        ? [distCandidate, srcCandidate]
        : isProduction
          ? isTest
            ? [distCandidate, srcCandidate]
            : [distCandidate]
          : [srcCandidate, distCandidate];
      for (const candidate of orderedCandidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }
  return null;
};

const resolvePluginSdkAlias = (): string | null =>
  resolvePluginSdkAliasFile({ srcFile: "index.ts", distFile: "index.js" });

const resolvePluginSdkAccountIdAlias = (): string | null => {
  return resolvePluginSdkAliasFile({ srcFile: "account-id.ts", distFile: "account-id.js" });
};

export const __testing = {
  resolvePluginSdkAliasFile,
};

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
}): string {
  const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
  return `${workspaceKey}::${JSON.stringify(params.plugins)}`;
}

function validatePluginConfig(params: {
  schema?: Record<string, unknown>;
  cacheKey?: string;
  value?: unknown;
}): { ok: boolean; value?: Record<string, unknown>; errors?: string[] } {
  const schema = params.schema;
  if (!schema) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  const cacheKey = params.cacheKey ?? JSON.stringify(schema);
  const result = validateJsonSchemaValue({
    schema,
    cacheKey,
    value: params.value ?? {},
  });
  if (result.ok) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  return { ok: false, errors: result.errors.map((error) => error.text) };
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (typeof resolved === "function") {
    return {
      register: resolved as OpenClawPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const def = resolved as OpenClawPluginDefinition;
    const register = def.register ?? def.activate;
    return { definition: def, register };
  }
  return {};
}

function createPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  source: string;
  origin: PluginRecord["origin"];
  workspaceDir?: string;
  enabled: boolean;
  configSchema: boolean;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    description: params.description,
    version: params.version,
    source: params.source,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    enabled: params.enabled,
    status: params.enabled ? "loaded" : "disabled",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: params.configSchema,
    configUiHints: undefined,
    configJsonSchema: undefined,
  };
}

function recordPluginError(params: {
  logger: PluginLogger;
  registry: PluginRegistry;
  record: PluginRecord;
  seenIds: Map<string, PluginRecord["origin"]>;
  pluginId: string;
  origin: PluginRecord["origin"];
  error: unknown;
  logPrefix: string;
  diagnosticMessagePrefix: string;
}) {
  const errorText = String(params.error);
  params.logger.error(`${params.logPrefix}${errorText}`);
  params.record.status = "error";
  params.record.error = errorText;
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.pluginId, params.origin);
  params.registry.diagnostics.push({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    message: `${params.diagnosticMessagePrefix}${errorText}`,
  });
}

function pushDiagnostics(diagnostics: PluginDiagnostic[], append: PluginDiagnostic[]) {
  diagnostics.push(...append);
}

type PathMatcher = {
  exact: Set<string>;
  dirs: string[];
};

type InstallTrackingRule = {
  trackedWithoutPaths: boolean;
  matcher: PathMatcher;
};

type PluginProvenanceIndex = {
  loadPathMatcher: PathMatcher;
  installRules: Map<string, InstallTrackingRule>;
};

function createPathMatcher(): PathMatcher {
  return { exact: new Set<string>(), dirs: [] };
}

function addPathToMatcher(matcher: PathMatcher, rawPath: string): void {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return;
  }
  const resolved = resolveUserPath(trimmed);
  if (!resolved) {
    return;
  }
  if (matcher.exact.has(resolved) || matcher.dirs.includes(resolved)) {
    return;
  }
  const stat = safeStatSync(resolved);
  if (stat?.isDirectory()) {
    matcher.dirs.push(resolved);
    return;
  }
  matcher.exact.add(resolved);
}

function matchesPathMatcher(matcher: PathMatcher, sourcePath: string): boolean {
  if (matcher.exact.has(sourcePath)) {
    return true;
  }
  return matcher.dirs.some((dirPath) => isPathInside(dirPath, sourcePath));
}

// lyc: 构建插件跟踪索引, 一个是config.plugins.load.paths,一个是config.plugins.installs
function buildProvenanceIndex(params: {
  config: OpenClawConfig;
  normalizedLoadPaths: string[];
}): PluginProvenanceIndex {
  // lyc: 创建路径匹配器, exact{}存储文件路径, dir[]存储目录路径
  const loadPathMatcher = createPathMatcher();
  // lyc: 将loadPath添加到loadPathMatcher中(区分文件路径和目录路径)
  for (const loadPath of params.normalizedLoadPaths) {
    addPathToMatcher(loadPathMatcher, loadPath);
  }

  const installRules = new Map<string, InstallTrackingRule>();
  const installs = params.config.plugins?.installs ?? {};
  for (const [pluginId, install] of Object.entries(installs)) {
    const rule: InstallTrackingRule = {
      // lyc: 是否没有跟踪路径, 
      // lyc: false代表有跟踪路径matcher属性中有params.config.plugins.installs{installPath,sourcePath},否则true代表matcher属性的内容为空
      trackedWithoutPaths: false,
      matcher: createPathMatcher(),
    };
    const trackedPaths = [install.installPath, install.sourcePath]
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    // lyc: params.config.plugins.installs{}没有配置installPath和sourcePath则代表没有跟踪路径
    if (trackedPaths.length === 0) {
      rule.trackedWithoutPaths = true;
    } else {
      // lyc: 有跟踪路径
      for (const trackedPath of trackedPaths) {
        addPathToMatcher(rule.matcher, trackedPath);
      }
    }
    // lyc: params.config.plugins.installs{}中指定的插件及installPath,sourcePath添加到installRules中
    installRules.set(pluginId, rule);
  }

  return { loadPathMatcher, installRules };
}

function isTrackedByProvenance(params: {
  pluginId: string;
  source: string;
  index: PluginProvenanceIndex;
}): boolean {
  const sourcePath = resolveUserPath(params.source);
  const installRule = params.index.installRules.get(params.pluginId);
  if (installRule) {
    if (installRule.trackedWithoutPaths) {
      return true;
    }
    if (matchesPathMatcher(installRule.matcher, sourcePath)) {
      return true;
    }
  }
  return matchesPathMatcher(params.index.loadPathMatcher, sourcePath);
}

function warnWhenAllowlistIsOpen(params: {
  logger: PluginLogger;
  pluginsEnabled: boolean;
  allow: string[];
  discoverablePlugins: Array<{ id: string; source: string; origin: PluginRecord["origin"] }>;
}) {
  if (!params.pluginsEnabled) {
    return;
  }
  if (params.allow.length > 0) {
    return;
  }
  const nonBundled = params.discoverablePlugins.filter((entry) => entry.origin !== "bundled");
  if (nonBundled.length === 0) {
    return;
  }
  const preview = nonBundled
    .slice(0, 6)
    .map((entry) => `${entry.id} (${entry.source})`)
    .join(", ");
  const extra = nonBundled.length > 6 ? ` (+${nonBundled.length - 6} more)` : "";
  params.logger.warn(
    `[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load: ${preview}${extra}. Set plugins.allow to explicit trusted ids.`,
  );
}

function warnAboutUntrackedLoadedPlugins(params: {
  registry: PluginRegistry;
  provenance: PluginProvenanceIndex;
  logger: PluginLogger;
}) {
  for (const plugin of params.registry.plugins) {
    if (plugin.status !== "loaded" || plugin.origin === "bundled") {
      continue;
    }
    if (
      isTrackedByProvenance({
        pluginId: plugin.id,
        source: plugin.source,
        index: params.provenance,
      })
    ) {
      continue;
    }
    const message =
      "loaded without install/load-path provenance; treat as untracked local code and pin trust via plugins.allow or install records";
    params.registry.diagnostics.push({
      level: "warn",
      pluginId: plugin.id,
      source: plugin.source,
      message,
    });
    params.logger.warn(`[plugins] ${plugin.id}: ${message} (${plugin.source})`);
  }
}

function activatePluginRegistry(registry: PluginRegistry, cacheKey: string): void {
  setActivePluginRegistry(registry, cacheKey);
  initializeGlobalHookRunner(registry);
}

// lyc: 加载插件
export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  // Test env: default-disable plugins unless explicitly configured.
  // This keeps unit/gateway suites fast and avoids loading heavyweight plugin deps by accident.
  // lyc: 测试环境：除非明确配置，否则默认禁用插件。
  // lyc: 这使得单元/网关套件保持快速，并避免意外加载重量级的插件依赖。
  const cfg = applyTestPluginDefaults(options.config ?? {}, process.env);
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const normalized = normalizePluginsConfig(cfg.plugins);
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: normalized,
  });
  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached) {
      activatePluginRegistry(cached, cacheKey);
      return cached;
    }
  }

  // Clear previously registered plugin commands before reloading
  // lyc: 在重新加载之前，清除之前注册的插件命令
  clearPluginCommands();

  // lyc: 创建插件运行时
  const runtime = createPluginRuntime();
  // lyc: 创建插件注册对象但只获得registry属性和createApi方法
  const { registry, createApi } = createPluginRegistry({
    logger,
    runtime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
  });
  // lyc: 发现插件
  const discovery = discoverOpenClawPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
  });
  // lyc: 加载discovery.candidates中的插件的manifest
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    cache: options.cache,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  // lyc: 将发现插件及加载插件manifest时的诊断信息添加到registry.diagnostics中
  pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
  warnWhenAllowlistIsOpen({
    logger,
    pluginsEnabled: normalized.enabled,
    allow: normalized.allow,
    discoverablePlugins: manifestRegistry.plugins.map((plugin) => ({
      id: plugin.id,
      source: plugin.source,
      origin: plugin.origin,
    })),
  });
  const provenance = buildProvenanceIndex({
    config: cfg,
    normalizedLoadPaths: normalized.loadPaths,
  });

  // Lazy: avoid creating the Jiti loader when all plugins are disabled (common in unit tests)
  // lyc: 懒惰模式：当所有插件都禁用时（这在单元测试中很常见），避免创建Jiti加载器。
  let jitiLoader: ReturnType<typeof createJiti> | null = null;
  /* lyc:
    /home/run.ts
      import "openclaw/plugin-sdk"
      export const version = "1.0"
      export default function register() {
          console.log("run.register()")
      }
      console.log("run-command")
    mod = getJiti()("/home/run.ts")
    运行情况:
      import "openclaw/plugin-sdk"会执行pluginSdkAlias指定的路径
      输出run-command
    mod会包含两个导出version和default
    mod.version === "1.0"
    mod.default() 会输出run.register()
  */
  const getJiti = () => {
    if (jitiLoader) {
      return jitiLoader;
    }
    const pluginSdkAlias = resolvePluginSdkAlias();
    const pluginSdkAccountIdAlias = resolvePluginSdkAccountIdAlias();
    /* lyc:
    import.meta.url: 指定当前模块的 URL，作为解析相对路径的基准
    interopDefault: 直接获取default导出; 这是一个非常重要的兼容性选项。它允许你以 const mod = jiti('./some-esm-module.ts') 的方式直接获取 ESM 模块的 default 导出，而不需要写成 jiti('./some-esm-module.ts').default，使得加载 CommonJS(require) 和 ESM(import) 模块的体验更加一致。
    extensions: 明确告诉 jiti 需要处理哪些文件扩展名
    alias: 插件sdk的别名, 即当jiti执行目标程序时, 如果目标程序中引用了openclaw/plugin-sdk, 则会定向到pluginSdkAlias指定的路径
    */
    jitiLoader = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
      ...(pluginSdkAlias || pluginSdkAccountIdAlias
        ? {
            alias: {
              ...(pluginSdkAlias ? { "openclaw/plugin-sdk": pluginSdkAlias } : {}),
              ...(pluginSdkAccountIdAlias
                ? { "openclaw/plugin-sdk/account-id": pluginSdkAccountIdAlias }
                : {}),
            },
          }
        : {}),
    });
    return jitiLoader;
  };
  // lyc: 插件manifest的rootDir映射
  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );

  const seenIds = new Map<string, PluginRecord["origin"]>();
  const memorySlot = normalized.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  let memorySlotMatched = false;

  for (const candidate of discovery.candidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }
    const pluginId = manifestRecord.id;
    const existingOrigin = seenIds.get(pluginId);
    if (existingOrigin) {
      const record = createPluginRecord({
        id: pluginId,
        name: manifestRecord.name ?? pluginId,
        description: manifestRecord.description,
        version: manifestRecord.version,
        source: candidate.source,
        origin: candidate.origin,
        workspaceDir: candidate.workspaceDir,
        enabled: false,
        configSchema: Boolean(manifestRecord.configSchema),
      });
      record.status = "disabled";
      record.error = `overridden by ${existingOrigin} plugin`;
      registry.plugins.push(record);
      continue;
    }
    // lyc: 当前插件是否启用
    const enableState = resolveEffectiveEnableState({
      id: pluginId,
      origin: candidate.origin,
      config: normalized,
      rootConfig: cfg,
    });
    // lyc: 当前插件在cfg.plugins.entries[pluginId]的配置
    const entry = normalized.entries[pluginId];
    // lyc: 构造插件记录(PluginRecord), 根据discovery.candidates[i], manifest构建
    const record = createPluginRecord({
      id: pluginId,
      name: manifestRecord.name ?? pluginId,
      description: manifestRecord.description,
      version: manifestRecord.version,
      source: candidate.source,
      origin: candidate.origin,
      workspaceDir: candidate.workspaceDir,
      enabled: enableState.enabled,
      configSchema: Boolean(manifestRecord.configSchema),
    });
    record.kind = manifestRecord.kind;
    record.configUiHints = manifestRecord.configUiHints;
    record.configJsonSchema = manifestRecord.configSchema;
    // lyc: 向插件记录添加错误信息, 并添加到registry.plugins, registry.diagnostics和seenIds中
    const pushPluginLoadError = (message: string) => {
      record.status = "error";
      record.error = message;
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
    };
    // lyc: 当前插件没有启用, 设置插件记录并添加到registry.plugins和seenIds中, 执行下一个插件(continue)
    if (!enableState.enabled) {
      record.status = "disabled";
      record.error = enableState.reason;
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    if (!manifestRecord.configSchema) {
      pushPluginLoadError("missing config schema");
      continue;
    }

    // lyc: 获得插件的根目录地址
    const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
    // lyc: 打开插件的入口文件
    const opened = openBoundaryFileSync({
      absolutePath: candidate.source,
      rootPath: pluginRoot,
      boundaryLabel: "plugin root",
      rejectHardlinks: candidate.origin !== "bundled",
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
      continue;
    }
    // lyc: 插件的入口文件路径
    const safeSource = opened.path;
    fs.closeSync(opened.fd);

    let mod: OpenClawPluginModule | null = null;
    try {
      /* lyc: 加载插件的入口文件, 如果加载失败, 则记录错误信息, 并执行下一个插件(continue)\
      这里定义mod=入口文件会导出OpenClawPluginModule联合类型(OpenClawPluginDefinition或Function)
        这个定义只是在编译期的检查类型, 实际运行时mod可能不符合这个类型, 例如:
          safeSource的文件内容: export default function register() {...}
          此时mod={default: safeSource.register}, 这个类型显然不符合OpenClawPluginModule类型要求, 但不会报错因为运行期是js代码,没有类型检查
        因此后续需要resolvePluginModuleExport(mod)来统一处理这个问题
      */
      mod = getJiti()(safeSource) as OpenClawPluginModule;
    } catch (err) {
      recordPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        error: err,
        logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
        diagnosticMessagePrefix: "failed to load plugin: ",
      });
      continue;
    }

    // lyc: 统一化mod, {register:mod.default|mod.register|mod.activate, definition:mod as OpenClawPluginDefinition|undefined}
    const resolved = resolvePluginModuleExport(mod);
    // lyc: definition = mod as OpenClawPluginDefinition | undefined
    const definition = resolved.definition;
    // lyc: register = mod.default | mod.register | mod.activate
    const register = resolved.register;

    // lyc: 插件代码中的id是否与manifest的id一致
    if (definition?.id && definition.id !== record.id) {
      registry.diagnostics.push({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
      });
    }

    record.name = definition?.name ?? record.name;
    record.description = definition?.description ?? record.description;
    record.version = definition?.version ?? record.version;
    const manifestKind = record.kind as string | undefined;
    const exportKind = definition?.kind as string | undefined;
    // lyc: 插件代码中的kind是否与manifest的kind一致
    if (manifestKind && exportKind && exportKind !== manifestKind) {
      registry.diagnostics.push({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `plugin kind mismatch (manifest uses "${manifestKind}", export uses "${exportKind}")`,
      });
    }
    record.kind = definition?.kind ?? record.kind;

    if (record.kind === "memory" && memorySlot === record.id) {
      memorySlotMatched = true;
    }

    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      slot: memorySlot,
      selectedId: selectedMemoryPluginId,
    });

    // lyc: 没有启用内存slot, 则插件记录的启用为false, 添加到registry.plugins和seenIds中, 执行下一个插件(continue)
    if (!memoryDecision.enabled) {
      record.enabled = false;
      record.status = "disabled";
      record.error = memoryDecision.reason;
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    if (memoryDecision.selected && record.kind === "memory") {
      selectedMemoryPluginId = record.id;
    }

    // lyc: 验证插件的配置, 使用插件的manifest配置中的schemaSchema验证cfg.plugins.entries[pluginId]的配置是否正确
    const validatedConfig = validatePluginConfig({
      schema: manifestRecord.configSchema,
      cacheKey: manifestRecord.schemaCacheKey,
      value: entry?.config,
    });

    // lyc: 插件的配置不正确, 记录错误信息, 并执行下一个插件(continue)
    if (!validatedConfig.ok) {
      logger.error(`[plugins] ${record.id} invalid config: ${validatedConfig.errors?.join(", ")}`);
      pushPluginLoadError(`invalid config: ${validatedConfig.errors?.join(", ")}`);
      continue;
    }

    // lyc: 如果只是验证插件的配置, 则直接添加到registry.plugins和seenIds中, 执行下一个插件(continue)
    if (validateOnly) {
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    // lyc: 插件的入口文件没有导出register/activate函数, 记录错误信息, 并执行下一个插件(continue)
    if (typeof register !== "function") {
      logger.error(`[plugins] ${record.id} missing register/activate export`);
      pushPluginLoadError("plugin export missing register/activate");
      continue;
    }

    // lyc: 创建插件的api
    const api = createApi(record, {
      config: cfg,
      pluginConfig: validatedConfig.value,
    });

    try {
      // lyc: 注册插件, 注意注册的插件执行文件会向registry的channels,tools等属性注册channel,tool等等
      const result = register(api);
      // lyc: register返回值是否为promise, 代表插件的注册是异步的, 异步注册的执行结果会被忽略, 但仍会注册插件
      if (result && typeof result.then === "function") {
        registry.diagnostics.push({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: "plugin register returned a promise; async registration is ignored",
        });
      }
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
    } catch (err) {
      recordPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        error: err,
        logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
        diagnosticMessagePrefix: "plugin failed during register: ",
      });
    }
  }

  if (typeof memorySlot === "string" && !memorySlotMatched) {
    registry.diagnostics.push({
      level: "warn",
      message: `memory slot plugin not found or not marked as memory: ${memorySlot}`,
    });
  }

  warnAboutUntrackedLoadedPlugins({
    registry,
    provenance,
    logger,
  });

  if (cacheEnabled) {
    registryCache.set(cacheKey, registry);
  }
  activatePluginRegistry(registry, cacheKey);
  return registry;
}

function safeRealpathOrResolve(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
