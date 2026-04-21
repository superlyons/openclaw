import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { resolveDebugProxySettings, type DebugProxySettings } from "./env.js";
import {
  closeDebugProxyCaptureStore,
  getDebugProxyCaptureStore,
  persistEventPayload,
  safeJsonString,
} from "./store.sqlite.js";
import type { CaptureProtocol } from "./types.js";

const DEBUG_PROXY_FETCH_PATCH_KEY = Symbol.for("openclaw.debugProxy.fetchPatch");

type GlobalFetchPatchedState = {
  originalFetch: typeof globalThis.fetch;
};

type GlobalFetchPatchTarget = typeof globalThis & {
  [DEBUG_PROXY_FETCH_PATCH_KEY]?: GlobalFetchPatchedState;
};

function protocolFromUrl(rawUrl: string): CaptureProtocol {
  try {
    const url = new URL(rawUrl);
    switch (url.protocol) {
      case "https:":
        return "https";
      case "wss:":
        return "wss";
      case "ws:":
        return "ws";
      default:
        return "http";
    }
  } catch {
    return "http";
  }
}

function resolveUrlString(input: RequestInfo | URL): string | null {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return null;
}

// lyc: 为全局Fetch函数安装调试代理的补丁, 用于向数据库(调试代理捕获存储(DebugProxyCaptureStore))记录http交流信息
function installDebugProxyGlobalFetchPatch(settings: DebugProxySettings): void {
  // lyc: 全局必须存在fetch函数, 否则直接返回
  if (typeof globalThis.fetch !== "function") {
    return;
  }
  // lyc: 检查是否已经安装了补丁, 是则直接返回
  const patched = globalThis as GlobalFetchPatchTarget;
  if (patched[DEBUG_PROXY_FETCH_PATCH_KEY]) {
    return;
  }
  // lyc: 开始安装补丁
  // lyc: 保存原始fetch函数引用
  const originalFetch = globalThis.fetch.bind(globalThis);
  // lyc: 保存原始fetch函数引用到patched对象中
  patched[DEBUG_PROXY_FETCH_PATCH_KEY] = { originalFetch };
  // lyc: 为全局fetch函数安装调试代理的补丁
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = resolveUrlString(input);
    try {
      const response = await originalFetch(input, init);
      // lyc: 如果是http,https请求, 则记录http交流信息
      if (url && /^https?:/i.test(url)) {
        captureHttpExchange({
          url,
          method:
            (typeof Request !== "undefined" && input instanceof Request
              ? input.method
              : undefined) ??
            init?.method ??
            "GET",
          requestHeaders:
            (typeof Request !== "undefined" && input instanceof Request
              ? input.headers
              : undefined) ?? (init?.headers as Headers | Record<string, string> | undefined),
          requestBody:
            (typeof Request !== "undefined" && input instanceof Request
              ? (input as Request & { body?: BodyInit | null }).body
              : undefined) ??
            (init as (RequestInit & { body?: BodyInit | null }) | undefined)?.body ??
            null,
          response,
          transport: "http",
          meta: {
            captureOrigin: "global-fetch",
            source: settings.sourceProcess,
          },
        });
      }
      return response;
    } catch (error) {
      // lyc: 如果请求发生了错误, 则记录错误事件(capture_events表)
      if (url && /^https?:/i.test(url)) {
        const store = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir);
        const parsed = new URL(url);
        store.recordEvent({
          sessionId: settings.sessionId,
          ts: Date.now(),
          sourceScope: "openclaw",
          sourceProcess: settings.sourceProcess,
          protocol: protocolFromUrl(url),
          direction: "local",
          kind: "error",
          flowId: randomUUID(),
          method:
            (typeof Request !== "undefined" && input instanceof Request
              ? input.method
              : undefined) ??
            init?.method ??
            "GET",
          host: parsed.host,
          path: `${parsed.pathname}${parsed.search}`,
          errorText: error instanceof Error ? error.message : String(error),
          metaJson: safeJsonString({ captureOrigin: "global-fetch" }),
        });
      }
      throw error;
    }
  }) as typeof globalThis.fetch;
}

// lyc: 卸载全局Fetch函数的调试代理补丁
function uninstallDebugProxyGlobalFetchPatch(): void {
  const patched = globalThis as GlobalFetchPatchTarget;
  const state = patched[DEBUG_PROXY_FETCH_PATCH_KEY];
  if (!state) {
    return;
  }
  globalThis.fetch = state.originalFetch;
  delete patched[DEBUG_PROXY_FETCH_PATCH_KEY];
}

export function isDebugProxyGlobalFetchPatchInstalled(): boolean {
  return Boolean((globalThis as GlobalFetchPatchTarget)[DEBUG_PROXY_FETCH_PATCH_KEY]);
}
// lyc: 初始化调试代理捕获, 用于记录http交流信息, 记录在调试代理捕获存储(DebugProxyCaptureStore)中
export function initializeDebugProxyCapture(mode: string, resolved?: DebugProxySettings): void {
  // lyc: 解析调试代理设置
  const settings = resolved ?? resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  // lyc: 初始化调试代理捕获存储(DebugProxyCaptureStore)并插入或更新会话记录(capture_sessions表)
  getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).upsertSession({
    id: settings.sessionId,
    startedAt: Date.now(),
    mode,
    sourceScope: "openclaw",
    sourceProcess: settings.sourceProcess,
    proxyUrl: settings.proxyUrl,
    dbPath: settings.dbPath,
    blobDir: settings.blobDir,
  });
  // lyc: 安装调试代理补丁, 用于向数据库(调试代理捕获存储(DebugProxyCaptureStore))记录http交流信息
  installDebugProxyGlobalFetchPatch(settings);
}

// lyc: 结束调试代理捕获
export function finalizeDebugProxyCapture(resolved?: DebugProxySettings): void {
  const settings = resolved ?? resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  // lyc: 结束会话记录(capture_sessions表)
  getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).endSession(settings.sessionId);
  // lyc: 卸载全局Fetch函数的调试代理补丁
  uninstallDebugProxyGlobalFetchPatch();
  // lyc: 关闭调试代理捕获存储(DebugProxyCaptureStore)
  closeDebugProxyCaptureStore();
}

// lyc: 记录http交流信息
export function captureHttpExchange(params: {
  url: string;
  method: string;
  requestHeaders?: Headers | Record<string, string> | undefined;
  requestBody?: BodyInit | Buffer | string | null;
  response: Response;
  transport?: "http" | "sse";
  flowId?: string;
  meta?: Record<string, unknown>;
}): void {
  // lyc: 解析调试代理设置
  const settings = resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  // lyc: 获取调试代理捕获存储(DebugProxyCaptureStore)
  const store = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir);
  const flowId = params.flowId ?? randomUUID();
  const url = new URL(params.url);
  const requestBody =
    typeof params.requestBody === "string" || Buffer.isBuffer(params.requestBody)
      ? params.requestBody
      : null;
  // lyc: 持久化请求体, 并返回持久化后的记录
  const requestPayload = persistEventPayload(store, {
    data: requestBody,
    contentType:
      params.requestHeaders instanceof Headers
        ? (params.requestHeaders.get("content-type") ?? undefined)
        : params.requestHeaders?.["content-type"],
  });
  // lyc: 记录请求事件(capture_events表)
  store.recordEvent({
    sessionId: settings.sessionId,
    ts: Date.now(),
    sourceScope: "openclaw",
    sourceProcess: settings.sourceProcess,
    protocol: params.transport ?? protocolFromUrl(params.url),
    direction: "outbound",
    kind: "request",
    flowId,
    method: params.method,
    host: url.host,
    path: `${url.pathname}${url.search}`,
    contentType:
      params.requestHeaders instanceof Headers
        ? (params.requestHeaders.get("content-type") ?? undefined)
        : params.requestHeaders?.["content-type"],
    headersJson: safeJsonString(
      params.requestHeaders instanceof Headers
        ? Object.fromEntries(params.requestHeaders.entries())
        : params.requestHeaders,
    ),
    metaJson: safeJsonString(params.meta),
    ...requestPayload,
  });
  // lyc: 检查是否可以克隆响应体
  const cloneable =
    params.response &&
    typeof params.response.clone === "function" &&
    typeof params.response.arrayBuffer === "function";
  // lyc: 如果不能克隆响应体, 则记录响应事件(capture_events表)不存储响应体, 之后退出本函数
  if (!cloneable) {
    // lyc: 记录响应事件(capture_events表)
    store.recordEvent({
      sessionId: settings.sessionId,
      ts: Date.now(),
      sourceScope: "openclaw",
      sourceProcess: settings.sourceProcess,
      protocol: params.transport ?? protocolFromUrl(params.url),
      direction: "inbound",
      kind: "response",
      flowId,
      method: params.method,
      host: url.host,
      path: `${url.pathname}${url.search}`,
      status: params.response.status,
      contentType:
        typeof params.response.headers?.get === "function"
          ? (params.response.headers.get("content-type") ?? undefined)
          : undefined,
      headersJson:
        params.response.headers && typeof params.response.headers.entries === "function"
          ? safeJsonString(Object.fromEntries(params.response.headers.entries()))
          : undefined,
      metaJson: safeJsonString({ ...params.meta, bodyCapture: "unavailable" }),
    });
    return;
  }
  // lyc: 如果可以克隆响应体, 则记录响应事件(capture_events表)并存储响应体
  void params.response
    .clone()
    .arrayBuffer()
    .then((buffer) => {
      // lyc: 持久化响应体, 并返回持久化后的记录
      const responsePayload = persistEventPayload(store, {
        data: Buffer.from(buffer),
        contentType: params.response.headers.get("content-type") ?? undefined,
      });
      // lyc: 记录响应事件(capture_events表)
      store.recordEvent({
        sessionId: settings.sessionId,
        ts: Date.now(),
        sourceScope: "openclaw",
        sourceProcess: settings.sourceProcess,
        protocol: params.transport ?? protocolFromUrl(params.url),
        direction: "inbound",
        kind: "response",
        flowId,
        method: params.method,
        host: url.host,
        path: `${url.pathname}${url.search}`,
        status: params.response.status,
        contentType: params.response.headers.get("content-type") ?? undefined,
        headersJson: safeJsonString(Object.fromEntries(params.response.headers.entries())),
        metaJson: safeJsonString(params.meta),
        ...responsePayload,
      });
    })
    .catch((error) => {
      // lyc: 如果克隆响应体失败, 则记录错误事件(capture_events表)
      store.recordEvent({
        sessionId: settings.sessionId,
        ts: Date.now(),
        sourceScope: "openclaw",
        sourceProcess: settings.sourceProcess,
        protocol: params.transport ?? protocolFromUrl(params.url),
        direction: "local",
        kind: "error",
        flowId,
        method: params.method,
        host: url.host,
        path: `${url.pathname}${url.search}`,
        errorText: error instanceof Error ? error.message : String(error),
      });
    });
}

export function captureWsEvent(params: {
  url: string;
  direction: "outbound" | "inbound" | "local";
  kind: "ws-open" | "ws-frame" | "ws-close" | "error";
  flowId: string;
  payload?: string | Buffer;
  closeCode?: number;
  errorText?: string;
  meta?: Record<string, unknown>;
}): void {
  const settings = resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  const store = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir);
  const url = new URL(params.url);
  const payload = persistEventPayload(store, {
    data: params.payload,
    contentType: "application/json",
  });
  store.recordEvent({
    sessionId: settings.sessionId,
    ts: Date.now(),
    sourceScope: "openclaw",
    sourceProcess: settings.sourceProcess,
    protocol: protocolFromUrl(params.url),
    direction: params.direction,
    kind: params.kind,
    flowId: params.flowId,
    host: url.host,
    path: `${url.pathname}${url.search}`,
    closeCode: params.closeCode,
    errorText: params.errorText,
    metaJson: safeJsonString(params.meta),
    ...payload,
  });
}
