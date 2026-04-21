import { createRequire } from "node:module";
import type { ConnectionOptions } from "node:tls";
import { pathToFileURL } from "node:url";
import type { Dispatcher } from "undici";
import { asNullableObjectRecord } from "../shared/record-coerce.js";

/* lyc:ai
这个文件提供了一个 gaxios fetch 兼容层 ，主要作用是：
1. 桥接 gaxios 和现代 fetch API ：让 Google 的 gaxios HTTP 客户端库能够与标准的 fetch API 一起工作
2. 支持高级网络功能 ：处理代理配置、TLS 证书、私钥等高级网络选项
3. 使用 Undici 作为底层实现 ：利用 Node.js 高性能 HTTP 客户端来处理复杂的网络需求

Undici 是 Node.js 官方团队开发的高性能 HTTP/1.1 客户端，相比 Node.js 内置的 http 模块更好
Undici 被用作底层 HTTP 客户端来处理 gaxios 的高级网络配置（如代理、TLS 证书等），并将这些配置转换为标准 fetch API 可以理解的格式。

## 主要工作流程
1. 安装阶段 ：检查 gaxios 是否可用
   - 如果可用：修补 gaxios 的 _defaultAdapter 方法
   - 如果不可用：安装简单的 window.fetch 填充（shim）
2. 请求处理 ：当 gaxios 发起请求时
   - 解析代理配置（来自请求参数或环境变量）
   - 解析 TLS 证书和私钥配置
   - 创建相应的 Undici Dispatcher（ProxyAgent 或 Agent）
   - 将配置转换为标准 fetch 格式并执行请求
## 原型链共享(prototype) (installGaxiosFetchCompat函数中实现)
js中有实例共享同一个原型对象. 修改原型上的方法会影响所有实例（包括未来创建的）
installGaxiosFetchCompat函数中修补了gaxios.prototype._defaultAdapter方法
内存中的结构：
installGaxiosFetchCompat() 执行前：
┌─────────────────────────────────────┐
│ Gaxios (类/构造函数)                 │
│   prototype ──────────────────┐     │
└───────────────────────────────┼─────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │ _defaultAdapter       │ ← 原始方法
                    │ (使用 http/https 模块) │
                    └───────────────────────┘
installGaxiosFetchCompat() 执行后：
┌─────────────────────────────────────┐
│ Gaxios (类/构造函数)                 │
│   prototype ──────────────────┐     │
└───────────────────────────────┼─────┘
                                │
                                ▼
                    ┌───────────────────────────┐
                    │ _defaultAdapter           │ ← 被替换！
                    │ (patchedDefaultAdapter)    │
                    │   ├─→ 注入 compatFetch     │
                    │   └─→ 调用原始方法         │
                    └───────────────────────────┘
后续任何地方 import { Gaxios } from "gaxios"：
    ↓
拿到的都是同一个 Gaxios 类
    ↓
new Gaxios() 创建的实例都共享同一个 prototype
    ↓
所以 _defaultAdapter 都是被拦截的版本
*/


// lyc:ai 代理规则类型：可以是正则表达式、URL 或字符串
type ProxyRule = RegExp | URL | string;
// lyc:ai TLS 证书类型
type TlsCert = ConnectionOptions["cert"];
// lyc:ai TLS 私钥类型  
type TlsKey = ConnectionOptions["key"];
// lyc:ai Fetch 函数类型定义
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// lyc:ai Gaxios 请求初始化配置，扩展了标准的 RequestInit
// lyc:ai 支持代理、TLS 证书、自定义 dispatcher 等高级配置
type GaxiosFetchRequestInit = RequestInit & {
  agent?: unknown;
  cert?: TlsCert;
  dispatcher?: Dispatcher;
  fetchImplementation?: FetchLike;
  key?: TlsKey;
  noProxy?: ProxyRule[];
  proxy?: string | URL;
};

// lyc:ai 代理代理对象的形状，包含代理 URL 和 TLS 连接选项
type ProxyAgentLike = {
  connectOpts?: { cert?: TlsCert; key?: TlsKey };
  proxy: URL;
};

// lyc:ai TLS 代理对象的形状，包含 TLS 选项
type TlsAgentLike = {
  options?: { cert?: TlsCert; key?: TlsKey };
};

// lyc:ai Gaxios 原型定义，包含默认适配器方法
type GaxiosPrototype = {
  _defaultAdapter: (this: unknown, config: GaxiosFetchRequestInit) => Promise<unknown>;
};

// lyc:ai Gaxios 构造函数类型
type GaxiosConstructor = {
  prototype: GaxiosPrototype;
};

const TEST_GAXIOS_CONSTRUCTOR_OVERRIDE = "__OPENCLAW_TEST_GAXIOS_CONSTRUCTOR__";

// lyc:ai 安装状态跟踪，用于确保只安装一次
let installState: "not-installed" | "installing" | "shimmed" | "installed" = "not-installed";

// lyc:ai Undici 运行时依赖类型定义
// lyc:ai Undici 是 Node.js 的高性能 HTTP/1.1 客户端，提供现代 API 和更好的性能
type UndiciRuntimeDeps = {
  UndiciAgent: typeof import("undici").Agent;
  ProxyAgent: typeof import("undici").ProxyAgent;
};

// lyc:ai 检查值是否具有 Dispatcher 接口（来自 undici）
function hasDispatcher(value: unknown): value is Dispatcher {
  const record = asNullableObjectRecord(value);
  return record !== null && typeof record.dispatch === "function";
}

// lyc:ai 检查值是否具有代理代理对象的形状
function hasProxyAgentShape(value: unknown): value is ProxyAgentLike {
  const record = asNullableObjectRecord(value);
  return record !== null && record.proxy instanceof URL;
}

// lyc:ai 检查值是否具有 TLS 代理对象的形状
function hasTlsAgentShape(value: unknown): value is TlsAgentLike {
  const record = asNullableObjectRecord(value);
  return record !== null && asNullableObjectRecord(record.options) !== null;
}

// lyc:ai 解析 TLS 选项，从请求配置中提取证书和私钥
// lyc:ai 优先使用显式配置的 cert/key，然后尝试从 agent 中提取
function resolveTlsOptions(
  init: GaxiosFetchRequestInit,
  url: URL,
): { cert?: TlsCert; key?: TlsKey } {
  const explicit = {
    cert: init.cert,
    key: init.key,
  };
  if (explicit.cert !== undefined || explicit.key !== undefined) {
    return explicit;
  }

  const agent = typeof init.agent === "function" ? init.agent(url) : init.agent;
  if (hasProxyAgentShape(agent)) {
    return {
      cert: agent.connectOpts?.cert,
      key: agent.connectOpts?.key,
    };
  }
  if (hasTlsAgentShape(agent)) {
    return {
      cert: agent.options?.cert,
      key: agent.options?.key,
    };
  }
  return {};
}

// lyc:ai 检查 URL 是否应该使用代理
// lyc:ai 考虑 noProxy 配置和环境变量 NO_PROXY/no_proxy
function urlMayUseProxy(url: URL, noProxy: ProxyRule[] = []): boolean {
  const rules = [...noProxy];
  const envRules = (process.env.NO_PROXY ?? process.env.no_proxy)?.split(",") ?? [];
  for (const rule of envRules) {
    const trimmed = rule.trim();
    if (trimmed.length > 0) {
      rules.push(trimmed);
    }
  }

  for (const rule of rules) {
    if (rule instanceof RegExp) {
      if (rule.test(url.toString())) {
        return false;
      }
      continue;
    }
    if (rule instanceof URL) {
      if (rule.origin === url.origin) {
        return false;
      }
      continue;
    }
    if (rule.startsWith("*.") || rule.startsWith(".")) {
      const cleanedRule = rule.replace(/^\*\./, ".");
      if (url.hostname.endsWith(cleanedRule)) {
        return false;
      }
      continue;
    }
    if (rule === url.origin || rule === url.hostname || rule === url.href) {
      return false;
    }
  }

  return true;
}

// lyc:ai 解析代理 URI，优先使用请求配置中的 proxy，然后回退到环境变量
function resolveProxyUri(init: GaxiosFetchRequestInit, url: URL): string | undefined {
  if (init.proxy) {
    const proxyUri = String(init.proxy);
    return urlMayUseProxy(url, init.noProxy) ? proxyUri : undefined;
  }

  const envProxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (!envProxy) {
    return undefined;
  }

  return urlMayUseProxy(url, init.noProxy) ? envProxy : undefined;
}

// lyc:ai 动态加载 Undici 运行时依赖
// lyc:ai 使用 createRequire 来在 ES 模块环境中加载 CommonJS 模块
function loadUndiciRuntimeDeps(): UndiciRuntimeDeps {
  const require = createRequire(import.meta.url);
  const undici = require("undici") as typeof import("undici");
  return {
    ProxyAgent: undici.ProxyAgent,
    UndiciAgent: undici.Agent,
  };
}

// lyc:ai 构建 Undici Dispatcher，用于处理代理和 TLS 配置
// lyc:ai 将 gaxios 的 agent 配置转换为 undici 的 dispatcher
function buildDispatcher(init: GaxiosFetchRequestInit, url: URL): Dispatcher | undefined {
  if (init.dispatcher) {
    return init.dispatcher;
  }

  const agent = typeof init.agent === "function" ? init.agent(url) : init.agent;
  if (hasDispatcher(agent)) {
    return agent;
  }

  const { cert, key } = resolveTlsOptions(init, url);
  const proxyUri =
    resolveProxyUri(init, url) ?? (hasProxyAgentShape(agent) ? String(agent.proxy) : undefined);
  if (proxyUri) {
    const { ProxyAgent } = loadUndiciRuntimeDeps();
    return new ProxyAgent({
      requestTls: cert !== undefined || key !== undefined ? { cert, key } : undefined,
      uri: proxyUri,
    });
  }

  if (cert !== undefined || key !== undefined) {
    const { UndiciAgent } = loadUndiciRuntimeDeps();
    return new UndiciAgent({
      connect: { cert, key },
    });
  }

  return undefined;
}

// lyc:ai 检查错误是否为模块未找到错误
function isModuleNotFoundError(err: unknown): err is NodeJS.ErrnoException {
  const record = asNullableObjectRecord(err);
  return (
    record !== null &&
    (record.code === "ERR_MODULE_NOT_FOUND" || record.code === "MODULE_NOT_FOUND")
  );
}

// lyc:ai 检查值是否具有 Gaxios 构造函数的形状
function hasGaxiosConstructorShape(value: unknown): value is GaxiosConstructor {
  return (
    typeof value === "function" &&
    "prototype" in value &&
    asNullableObjectRecord(value.prototype) !== null &&
    typeof value.prototype._defaultAdapter === "function"
  );
}

// lyc:ai 获取测试用的 Gaxios 构造函数覆盖（用于单元测试）
function getTestGaxiosConstructorOverride(): GaxiosConstructor | null | undefined {
  const testGlobal = globalThis as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(testGlobal, TEST_GAXIOS_CONSTRUCTOR_OVERRIDE)) {
    return undefined;
  }
  const override = testGlobal[TEST_GAXIOS_CONSTRUCTOR_OVERRIDE];
  if (override === null) {
    return null;
  }
  if (hasGaxiosConstructorShape(override)) {
    return override;
  }
  throw new Error("invalid gaxios test constructor override");
}

// lyc:ai 是否为 gaxios 模块缺失错误
function isDirectGaxiosImportMiss(err: unknown): boolean {
  if (!isModuleNotFoundError(err)) {
    return false;
  }
  return (
    typeof err.message === "string" &&
    (err.message.includes("Cannot find package 'gaxios'") ||
      err.message.includes("Cannot find module 'gaxios'"))
  );
}

// lyc:ai 加载 Gaxios 构造函数，支持测试覆盖和错误处理
async function loadGaxiosConstructor(): Promise<GaxiosConstructor | null> {
  const testOverride = getTestGaxiosConstructorOverride();
  if (testOverride !== undefined) {
    return testOverride;
  }

  try {
    // lyc: 在ES模块（ESM）环境中创建了一个require函数以import.meta.url作为基础路径, 因为ES没有require函数, 为了后面可以使用require.resolve函数(这是CommonJS的功能)
    const require = createRequire(import.meta.url);
    /* lyc: 解析gaxios模块的实际入口文件的完整路径
    1.是否是内置模块(fs,path等), 
    2.路径形式的模块(未以/,./,../开头), 
    3.在 node_modules 中查找 从当前模块的路径开始解析(基准路径), 一直到系统根目录
      如果当前模块在 /project/src/module.js，查找顺序为：/project/src/node_modules/gaxios, /project/node_modules/gaxios, /node_modules/gaxios
    4.解析 package.json 的 main 字段来确定入口文件（通常是 index.js）
    最终 require.resolve() 返回 gaxios 模块入口文件的完整绝对路径，而不是加载模块本身。
    */
    const resolvedPath = require.resolve("gaxios");
    const mod = await import(pathToFileURL(resolvedPath).href);
    const candidate = asNullableObjectRecord(mod)?.Gaxios;
    if (!hasGaxiosConstructorShape(candidate)) {
      throw new Error("gaxios: missing Gaxios export");
    }
    return candidate;
  } catch (err) {
    if (isDirectGaxiosImportMiss(err)) {
      return null;
    }
    throw err;
  }
}

// lyc:ai 安装传统的 window.fetch 填充（shim）
// lyc:ai 当 gaxios 不可用时，确保 window 对象存在 fetch 方法
function installLegacyWindowFetchShim(): void {
  if (
    typeof globalThis.fetch !== "function" ||
    typeof (globalThis as Record<string, unknown>).window !== "undefined"
  ) {
    return;
  }
  (globalThis as Record<string, unknown>).window = { fetch: globalThis.fetch };
}

// lyc:ai 创建兼容 gaxios 的 fetch 函数
// lyc:ai 将 gaxios 特定的配置（如代理、TLS 证书）转换为标准 fetch 配置
// lyc:ai 使用 undici 的 dispatcher 来处理高级网络功能
export function createGaxiosCompatFetch(
  baseFetch: FetchLike = globalThis.fetch.bind(globalThis),
): FetchLike {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const gaxiosInit = (init ?? {}) as GaxiosFetchRequestInit;
    const requestUrl =
      input instanceof Request
        ? new URL(input.url)
        : new URL(typeof input === "string" ? input : input.toString());
    const dispatcher = buildDispatcher(gaxiosInit, requestUrl);

    const nextInit: RequestInit = { ...gaxiosInit };
    delete (nextInit as GaxiosFetchRequestInit).agent;
    delete (nextInit as GaxiosFetchRequestInit).cert;
    delete (nextInit as GaxiosFetchRequestInit).fetchImplementation;
    delete (nextInit as GaxiosFetchRequestInit).key;
    delete (nextInit as GaxiosFetchRequestInit).noProxy;
    delete (nextInit as GaxiosFetchRequestInit).proxy;

    if (dispatcher) {
      (nextInit as RequestInit & { dispatcher: Dispatcher }).dispatcher = dispatcher;
    }

    return baseFetch(input, nextInit);
  };
}

// lyc:ai 安装 gaxios fetch 兼容层
// lyc:ai 如果 gaxios 可用，则修补其 _defaultAdapter 方法以使用兼容的 fetch
// lyc:ai 如果 gaxios 不可用，则安装 window.fetch 填充（shim）
export async function installGaxiosFetchCompat(): Promise<void> {
  if (installState !== "not-installed" || typeof globalThis.fetch !== "function") {
    return;
  }

  installState = "installing";

  try {
    const Gaxios = await loadGaxiosConstructor();
    if (!Gaxios) {
      installLegacyWindowFetchShim();
      installState = "shimmed";
      return;
    }

    const prototype = Gaxios.prototype;
    const originalDefaultAdapter = prototype._defaultAdapter;
    const compatFetch = createGaxiosCompatFetch();

    prototype._defaultAdapter = function patchedDefaultAdapter(
      this: unknown,
      config: GaxiosFetchRequestInit,
    ): Promise<unknown> {
      if (config.fetchImplementation) {
        return originalDefaultAdapter.call(this, config);
      }
      return originalDefaultAdapter.call(this, {
        ...config,
        fetchImplementation: compatFetch,
      });
    };

    installState = "installed";
  } catch (err) {
    installState = "not-installed";
    throw err;
  }
}

// lyc:ai 测试专用的内部 API
export const __testing = {
  resetGaxiosFetchCompatForTests(): void {
    installState = "not-installed";
  },
};
