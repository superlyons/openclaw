import * as net from "node:net";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { isWSL2Sync } from "../wsl.js";
import { hasEnvHttpProxyAgentConfigured, resolveEnvHttpProxyAgentOptions } from "./proxy-env.js";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Module-level bridge so `resolveDispatcherTimeoutMs` in fetch-guard.ts
 * can read the global dispatcher timeout without relying on Undici's
 * non-public `.options` field.
 */
export let _globalUndiciStreamTimeoutMs: number | undefined;

const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;

let lastAppliedTimeoutKey: string | null = null;
let lastAppliedProxyBootstrap = false;

type DispatcherKind = "agent" | "env-proxy" | "unsupported";

function resolveDispatcherKind(dispatcher: unknown): DispatcherKind {
  const ctorName = (dispatcher as { constructor?: { name?: string } })?.constructor?.name;
  if (typeof ctorName !== "string" || ctorName.length === 0) {
    return "unsupported";
  }
  if (ctorName.includes("EnvHttpProxyAgent")) {
    return "env-proxy";
  }
  if (ctorName.includes("ProxyAgent")) {
    return "unsupported";
  }
  if (ctorName.includes("Agent")) {
    return "agent";
  }
  return "unsupported";
}

function resolveAutoSelectFamily(): boolean | undefined {
  if (typeof net.getDefaultAutoSelectFamily !== "function") {
    return undefined;
  }
  try {
    const systemDefault = net.getDefaultAutoSelectFamily();
    // WSL2 has unstable IPv6 connectivity; disable autoSelectFamily to
    // force IPv4 connections and avoid "fetch failed" errors when reaching
    // Windows-host services (e.g. Ollama) from inside WSL2.
    if (systemDefault && isWSL2Sync()) {
      return false;
    }
    return systemDefault;
  } catch {
    return undefined;
  }
}

function resolveConnectOptions(
  autoSelectFamily: boolean | undefined,
): { autoSelectFamily: boolean; autoSelectFamilyAttemptTimeout: number } | undefined {
  if (autoSelectFamily === undefined) {
    return undefined;
  }
  return {
    autoSelectFamily,
    autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  };
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

// lyc: 获取当前 uiundici 的全局 dispatcher 分发器 的 kind
function resolveCurrentDispatcherKind(): DispatcherKind | null {
  let dispatcher: unknown;
  try {
    dispatcher = getGlobalDispatcher();
  } catch {
    return null;
  }

  const currentKind = resolveDispatcherKind(dispatcher);
  return currentKind === "unsupported" ? null : currentKind;
}

/* lyc: 确保全局undici dispatcher 分发器是基于环境变量配置的代理
#  分发器(Dispatcher): 是undici库中的核心概念，它是一个负责处理HTTP请求的组件
## 分发器类型:
  Agent: 基础的HTTP客户端代理，管理连接池
  EnvHttpProxyAgent: 根据环境变量配置的代理，自动处理HTTP代理
  ProxyAgent: 通用的代理分发器，支持各种代理协议
## EnvHttpProxyAgent
  - 自动读取环境变量：HTTP_PROXY、HTTPS_PROXY、NO_PROXY
  - 根据目标URL和NO_PROXY规则决定是否使用代理
  - 只在需要时才使用代理，其他请求直接连接
  process.env.NO_PROXY = 'localhost,127.0.0.1,*.internal.com';
  process.env.HTTPS_PROXY = 'http://corporate-proxy:8080';
  // 这时开始检查环境变量,存在HTTPS_PROXY则使用setGlobalDispatcher(new EnvHttpProxyAgent())设置全局 dispatcher 分发器
  import { fetch } from 'undici'; 
  // 这些请求不会走代理
  await fetch('http://localhost:3000');
  await fetch('http://127.0.0.1:3000');
  await fetch('https://api.internal.com');
  // 这个会走代理, 请求通过代理服务器转发：client → proxy(http://corporate-proxy:8080) → https://external-service.com
  await fetch('https://external-service.com');
*/
export function ensureGlobalUndiciEnvProxyDispatcher(): void {
  // lyc: 检查环境变量中是否配置了HTTP/S代理
  const shouldUseEnvProxy = hasEnvHttpProxyAgentConfigured();
  if (!shouldUseEnvProxy) {
    return;
  }
  // lyc: 如果已应用代理引导
  if (lastAppliedProxyBootstrap) {
    // lyc: 检查当前 uiundici 的全局 dispatcher 分发器的kind是否是 env-proxy(基于环境变量配置的代理)
    if (resolveCurrentDispatcherKind() === "env-proxy") {
      // lyc: 是直接返回
      return;
    }
    // lyc: 否则, 标记为未应用代理引导, 
    // lyc: 这代表当前 uiundici 的全局 dispatcher 分发器不是 env-proxy(基于环境变量配置的代理), 所以需要重新引导
    lastAppliedProxyBootstrap = false;
  }
  // lyc: 检查当前 uiundici 的全局 dispatcher 分发器的kind
  const currentKind = resolveCurrentDispatcherKind();
  // lyc: 代表不支持, 直接返回
  if (currentKind === null) {
    return;
  }
  // lyc: 如果分发器kind是 env-proxy(基于环境变量配置的代理), 则直接返回
  if (currentKind === "env-proxy") {
    // lyc: 标记为已应用代理引导 并返回
    lastAppliedProxyBootstrap = true;
    return;
  }
  try {
    /* lyc: 设置 uiundici 的全局 dispatcher 分发器为 EnvHttpProxyAgent (基于env-proxy) 实例
    EnvHttpProxyAgent: 
      自动读取环境变量：HTTP_PROXY、HTTPS_PROXY、NO_PROXY
      根据目标URL和NO_PROXY规则决定是否使用代理
      只在需要时才使用代理，其他请求直接连接
    */
    setGlobalDispatcher(new EnvHttpProxyAgent(resolveEnvHttpProxyAgentOptions()));
    // lyc: 标记为已应用代理引导
    lastAppliedProxyBootstrap = true;
  } catch {
    // Best-effort bootstrap only.
  }
}

export function ensureGlobalUndiciStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMsRaw)) {
    return;
  }
  const timeoutMs = Math.max(DEFAULT_UNDICI_STREAM_TIMEOUT_MS, Math.floor(timeoutMsRaw));
  _globalUndiciStreamTimeoutMs = timeoutMs;
  const kind = resolveCurrentDispatcherKind();
  if (kind === null) {
    return;
  }

  const autoSelectFamily = resolveAutoSelectFamily();
  const nextKey = resolveDispatcherKey({ kind, timeoutMs, autoSelectFamily });
  if (lastAppliedTimeoutKey === nextKey) {
    return;
  }

  const connect = resolveConnectOptions(autoSelectFamily);
  try {
    if (kind === "env-proxy") {
      const proxyOptions = {
        ...resolveEnvHttpProxyAgentOptions(),
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        ...(connect ? { connect } : {}),
      } as ConstructorParameters<typeof EnvHttpProxyAgent>[0];
      setGlobalDispatcher(new EnvHttpProxyAgent(proxyOptions));
    } else {
      setGlobalDispatcher(
        new Agent({
          bodyTimeout: timeoutMs,
          headersTimeout: timeoutMs,
          ...(connect ? { connect } : {}),
        }),
      );
    }
    lastAppliedTimeoutKey = nextKey;
  } catch {
    // Best-effort hardening only.
  }
}

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedTimeoutKey = null;
  lastAppliedProxyBootstrap = false;
  _globalUndiciStreamTimeoutMs = undefined;
}
