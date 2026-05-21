import { isProxylineDispatcher } from "@openclaw/proxyline/dispatcher-brand";
import { hasEnvHttpProxyAgentConfigured, resolveEnvHttpProxyAgentOptions } from "./proxy-env.js";
import { addActiveManagedProxyTlsOptions } from "./proxy/managed-proxy-undici.js";
import {
  createUndiciAutoSelectFamilyConnectOptions,
  resolveUndiciAutoSelectFamily,
  withTemporaryUndiciAutoSelectFamily,
} from "./undici-family-policy.js";
import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  loadUndiciGlobalDispatcherDeps,
  type UndiciGlobalDispatcherDeps,
} from "./undici-runtime.js";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;
const HTTP1_ONLY_DISPATCHER_OPTIONS = Object.freeze({
  allowH2: false as const,
});

/**
 * Module-level bridge so `resolveDispatcherTimeoutMs` in fetch-guard.ts
 * can read the global dispatcher timeout without relying on Undici's
 * non-public `.options` field.
 */
export let _globalUndiciStreamTimeoutMs: number | undefined;

let lastAppliedTimeoutKey: string | null = null;
let lastAppliedProxyBootstrapKey: string | null = null;

type DispatcherKind = "agent" | "env-proxy" | "proxyline-managed" | "unsupported";
type SupportedDispatcherKind = Exclude<DispatcherKind, "unsupported">;
type UndiciDispatcher = Parameters<UndiciGlobalDispatcherDeps["setGlobalDispatcher"]>[0];
type UndiciDispatchOptions = Parameters<UndiciDispatcher["dispatch"]>[0];
type UndiciDispatchHandler = Parameters<UndiciDispatcher["dispatch"]>[1];
type CurrentDispatcherInfo = {
  kind: SupportedDispatcherKind;
  dispatcher: UndiciDispatcher;
};
type TimedProxylineManagedDispatcherState = {
  autoSelectFamily: boolean | undefined;
  timeoutMs: number;
  dispatch: UndiciDispatcher["dispatch"];
};

const UNDICI_DISPATCH_HELPER_METHODS = new Set<PropertyKey>([
  "compose",
  "connect",
  "pipeline",
  "request",
  "stream",
  "upgrade",
]);
const UNDICI_DISPATCHER_LIFECYCLE_METHODS = new Set<PropertyKey>(["close", "destroy"]);

const timedProxylineManagedDispatchers = new WeakMap<
  object,
  TimedProxylineManagedDispatcherState
>();

function isTimedProxylineManagedDispatcher(dispatcher: unknown): dispatcher is UndiciDispatcher {
  return typeof dispatcher === "object" && dispatcher !== null
    ? timedProxylineManagedDispatchers.has(dispatcher)
    : false;
}

function withDefaultDispatchTimeout(
  timeout: UndiciDispatchOptions["bodyTimeout"],
  timeoutMs: number,
): UndiciDispatchOptions["bodyTimeout"] {
  return timeout == null ? timeoutMs : timeout;
}

function createTimedProxylineManagedDispatcher(
  dispatcher: UndiciDispatcher,
  timeoutMs: number,
  autoSelectFamily: boolean | undefined,
): UndiciDispatcher {
  const existingState = timedProxylineManagedDispatchers.get(dispatcher);
  if (existingState) {
    existingState.autoSelectFamily = autoSelectFamily;
    existingState.timeoutMs = timeoutMs;
    return dispatcher;
  }

  const state: TimedProxylineManagedDispatcherState = {
    autoSelectFamily,
    timeoutMs,
    dispatch(options: UndiciDispatchOptions, handler: UndiciDispatchHandler): boolean {
      return withTemporaryUndiciAutoSelectFamily(state.autoSelectFamily, () =>
        dispatcher.dispatch(
          {
            ...options,
            bodyTimeout: withDefaultDispatchTimeout(options.bodyTimeout, state.timeoutMs),
            headersTimeout: withDefaultDispatchTimeout(options.headersTimeout, state.timeoutMs),
            ...HTTP1_ONLY_DISPATCHER_OPTIONS,
          },
          handler,
        ),
      );
    },
  };
  const proxy = new Proxy(dispatcher, {
    get(target, property, receiver) {
      if (property === "dispatch") {
        return state.dispatch;
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      if (UNDICI_DISPATCHER_LIFECYCLE_METHODS.has(property)) {
        return value.bind(target);
      }
      if (UNDICI_DISPATCH_HELPER_METHODS.has(property)) {
        return (...args: unknown[]) => Reflect.apply(value, receiver, args);
      }
      return value;
    },
  });
  timedProxylineManagedDispatchers.set(proxy, state);
  return proxy;
}

function resolveDispatcherKind(dispatcher: unknown): DispatcherKind {
  const ctorName = (dispatcher as { constructor?: { name?: string } })?.constructor?.name;
  if (typeof ctorName !== "string" || ctorName.length === 0) {
    return "unsupported";
  }
  if (ctorName.includes("EnvHttpProxyAgent")) {
    return "env-proxy";
  }
  if (isTimedProxylineManagedDispatcher(dispatcher) || isProxylineDispatcher(dispatcher)) {
    return "proxyline-managed";
  }
  if (ctorName.includes("ProxyAgent")) {
    return "unsupported";
  }
  if (ctorName.includes("Agent")) {
    return "agent";
  }
  return "unsupported";
}

function resolveDispatcherKey(params: {
  kind: DispatcherKind;
  timeoutMs: number;
  autoSelectFamily: boolean | undefined;
}): string {
  const autoSelectToken =
    params.autoSelectFamily === undefined ? "na" : params.autoSelectFamily ? "on" : "off";
  return `${params.kind}:${params.timeoutMs}:${autoSelectToken}`;
}

// lyc:aic v2026.5 新增 3 个 helper：
//   resolveEnvProxyDispatcherOptions   — 合并 env 代理 + HTTP1-only 选项
//   resolveEnvProxyBootstrapKey        — 把 options 序列化成稳定的指纹 key，用于幂等创建
//   resolveStreamTimeoutMs             — 把 opts.timeoutMs 卡到 DEFAULT_UNDICI_STREAM_TIMEOUT_MS 以下
function resolveEnvProxyDispatcherOptions(): ConstructorParameters<
  UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]
>[0] {
  return {
    ...addActiveManagedProxyTlsOptions(resolveEnvHttpProxyAgentOptions()),
    ...HTTP1_ONLY_DISPATCHER_OPTIONS,
  } as ConstructorParameters<UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]>[0];
}

function resolveEnvProxyBootstrapKey(
  options: ConstructorParameters<UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]>[0],
): string {
  const entries = Object.entries((options ?? {}) as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .toSorted(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function resolveStreamTimeoutMs(opts?: { timeoutMs?: number }): number | null {
  const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMsRaw)) {
    return null;
  }
  return Math.max(DEFAULT_UNDICI_STREAM_TIMEOUT_MS, Math.floor(timeoutMsRaw));
}

// lyc: 获取当前 undici 的全局 dispatcher 分发器 的 kind
// lyc:aic v2026.5 拆分：现在 resolveCurrentDispatcherKind 只是从下面的 resolveCurrentDispatcherInfo 里取 kind 字段，
//                  实际逻辑搬到 resolveCurrentDispatcherInfo（返回完整 info 对象）
function resolveCurrentDispatcherKind(
  runtime: Pick<UndiciGlobalDispatcherDeps, "getGlobalDispatcher">,
): SupportedDispatcherKind | null {
  return resolveCurrentDispatcherInfo(runtime)?.kind ?? null;
}

function resolveCurrentDispatcherInfo(
  runtime: Pick<UndiciGlobalDispatcherDeps, "getGlobalDispatcher">,
): CurrentDispatcherInfo | null {
  let dispatcher: unknown;
  try {
    dispatcher = runtime.getGlobalDispatcher();
  } catch {
    return null;
  }

  const currentKind = resolveDispatcherKind(dispatcher);
  if (currentKind === "unsupported") {
    return null;
  }
  return {
    kind: currentKind,
    dispatcher: dispatcher as UndiciDispatcher,
  };
}

/* lyc: 确保全局undici dispatcher 分发器是基于环境变量配置的代理
#  分发器(Dispatcher): 是undici库中的核心概念，它是一个负责处理HTTP请求的组件
## 分发器类型:
## EnvHttpProxyAgent
  // 这时开始检查环境变量,存在HTTPS_PROXY则使用setGlobalDispatcher(new EnvHttpProxyAgent())设置全局 dispatcher 分发器
  // 这些请求不会走代理
  // 这个会走代理, 请求通过代理服务器转发：client → proxy(http://corporate-proxy:8080) → https://external-service.com
*/
export function ensureGlobalUndiciEnvProxyDispatcher(): void {
  // lyc: 检查环境变量中是否配置了HTTP/S代理
  const shouldUseEnvProxy = hasEnvHttpProxyAgentConfigured();
  if (!shouldUseEnvProxy) {
    return;
  }
  // lyc:aic v2026.5 大改：
  //   1. lastAppliedProxyBootstrap (bool) 改为 lastAppliedProxyBootstrapKey (string|null) —— 支持指纹比对，proxy 选项变了能识别
  //   2. 新增 "proxyline-managed" kind 处理（如果分发器已被 proxyline 管理则不动）
  //   3. setGlobalDispatcher 改为 createHttp1EnvHttpProxyAgent 工厂（封装了 HTTP1-only + TLS 选项）
  const runtime = loadUndiciGlobalDispatcherDeps();
  const { setGlobalDispatcher } = runtime;
  const proxyOptions = resolveEnvProxyDispatcherOptions();
  const nextBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
  // lyc: 检查当前 undici 的全局 dispatcher 分发器的 kind
  const currentKind = resolveCurrentDispatcherKind(runtime);
  // lyc: 代表不支持, 直接返回
  if (currentKind === null) {
    return;
  }
  // lyc:aic v2026.5 新增：如果分发器已被 proxyline 管理，记录 key 并返回
  if (currentKind === "proxyline-managed") {
    lastAppliedProxyBootstrapKey = nextBootstrapKey;
    return;
  }
  // lyc: 如果分发器 kind 是 env-proxy 且本次还没有 bootstrap key，记录并返回
  if (currentKind === "env-proxy" && lastAppliedProxyBootstrapKey === null) {
    lastAppliedProxyBootstrapKey = nextBootstrapKey;
    return;
  }
  // lyc:aic v2026.5：如果分发器已是 env-proxy 且 proxy 选项指纹相同，则什么都不用做
  if (currentKind === "env-proxy" && lastAppliedProxyBootstrapKey === nextBootstrapKey) {
    return;
  }
  try {
    /* lyc: 设置 undici 的全局 dispatcher 分发器为 EnvHttpProxyAgent (基于 env-proxy) 实例
    */
    // lyc:aic v2026.5：用 createHttp1EnvHttpProxyAgent 工厂（强制 HTTP1-only + TLS 选项）替代原 new EnvHttpProxyAgent
    setGlobalDispatcher(createHttp1EnvHttpProxyAgent(proxyOptions));
    // lyc: 标记为已应用代理引导
    lastAppliedProxyBootstrapKey = nextBootstrapKey;
  } catch {
    // Best-effort bootstrap only.
  }
}

function applyGlobalDispatcherStreamTimeouts(params: {
  runtime: UndiciGlobalDispatcherDeps;
  dispatcher: UndiciDispatcher;
  kind: SupportedDispatcherKind;
  timeoutMs: number;
}): void {
  const { runtime, dispatcher, kind, timeoutMs } = params;
  const autoSelectFamily = resolveUndiciAutoSelectFamily();
  const nextKey = resolveDispatcherKey({
    kind,
    timeoutMs,
    autoSelectFamily,
  });
  const needsProxylineWrapper =
    kind === "proxyline-managed" && !isTimedProxylineManagedDispatcher(dispatcher);
  if (lastAppliedTimeoutKey === nextKey && !needsProxylineWrapper) {
    return;
  }

  const connect = createUndiciAutoSelectFamilyConnectOptions(autoSelectFamily);
  try {
    if (kind === "proxyline-managed") {
      runtime.setGlobalDispatcher(
        createTimedProxylineManagedDispatcher(dispatcher, timeoutMs, autoSelectFamily),
      );
    } else if (kind === "env-proxy") {
      const proxyOptions = {
        ...addActiveManagedProxyTlsOptions(resolveEnvHttpProxyAgentOptions()),
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        ...(connect ? { connect } : {}),
        ...HTTP1_ONLY_DISPATCHER_OPTIONS,
      } as ConstructorParameters<UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]>[0];
      runtime.setGlobalDispatcher(createHttp1EnvHttpProxyAgent(proxyOptions, timeoutMs));
    } else {
      runtime.setGlobalDispatcher(createHttp1Agent(connect ? { connect } : undefined, timeoutMs));
    }
    lastAppliedTimeoutKey = nextKey;
  } catch {
    // Best-effort hardening only.
  }
}

export function ensureGlobalUndiciStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMs = resolveStreamTimeoutMs(opts);
  if (timeoutMs === null) {
    return;
  }
  _globalUndiciStreamTimeoutMs = timeoutMs;
  if (!hasEnvHttpProxyAgentConfigured()) {
    lastAppliedTimeoutKey = null;
    return;
  }
  const runtime = loadUndiciGlobalDispatcherDeps();
  const current = resolveCurrentDispatcherInfo(runtime);
  if (current === null) {
    return;
  }
  if (current.kind !== "env-proxy" && current.kind !== "proxyline-managed") {
    return;
  }

  applyGlobalDispatcherStreamTimeouts({
    runtime,
    dispatcher: current.dispatcher,
    kind: current.kind,
    timeoutMs,
  });
}

export function ensureGlobalUndiciDispatcherStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMs = resolveStreamTimeoutMs(opts);
  if (timeoutMs === null) {
    return;
  }
  _globalUndiciStreamTimeoutMs = timeoutMs;
  const runtime = loadUndiciGlobalDispatcherDeps();
  const current = resolveCurrentDispatcherInfo(runtime);
  if (current === null) {
    return;
  }
  applyGlobalDispatcherStreamTimeouts({
    runtime,
    dispatcher: current.dispatcher,
    kind: current.kind,
    timeoutMs,
  });
}

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedTimeoutKey = null;
  lastAppliedProxyBootstrapKey = null;
  _globalUndiciStreamTimeoutMs = undefined;
}

/**
 * Re-evaluate proxy env changes for root undici imports. Installs
 * EnvHttpProxyAgent when proxy env is present, and restores a direct Agent
 * after proxy env is cleared.
 */
export function forceResetGlobalDispatcher(opts?: { preserveProxylineManaged?: boolean }): void {
  lastAppliedTimeoutKey = null;
  if (!hasEnvHttpProxyAgentConfigured()) {
    if (lastAppliedProxyBootstrapKey === null) {
      return;
    }
    lastAppliedProxyBootstrapKey = null;
    try {
      const { setGlobalDispatcher } = loadUndiciGlobalDispatcherDeps();
      setGlobalDispatcher(createHttp1Agent());
    } catch {
      // Best-effort reset only.
    }
    return;
  }
  try {
    const runtime = loadUndiciGlobalDispatcherDeps();
    const { setGlobalDispatcher } = runtime;
    const proxyOptions = resolveEnvProxyDispatcherOptions();
    if (opts?.preserveProxylineManaged) {
      const current = resolveCurrentDispatcherInfo(runtime);
      if (current?.kind === "proxyline-managed") {
        lastAppliedProxyBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
        return;
      }
    }
    setGlobalDispatcher(createHttp1EnvHttpProxyAgent(proxyOptions));
    lastAppliedProxyBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
  } catch {
    // Best-effort reset only.
  }
}
