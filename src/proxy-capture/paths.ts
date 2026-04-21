import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

// lyc: 解析调试代理根目录, 默认为~/.openclaw/debug-proxy
export function resolveDebugProxyRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "debug-proxy");
}

// lyc: 解析调试代理数据库路径, 默认为~/.openclaw/debug-proxy/capture.sqlite
export function resolveDebugProxyDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "capture.sqlite");
}
// lyc: 解析调试代理blob目录, 默认为~/.openclaw/debug-proxy/blobs
export function resolveDebugProxyBlobDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "blobs");
}
// lyc: 解析调试代理证书目录, 默认为~/.openclaw/debug-proxy/certs
export function resolveDebugProxyCertDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "certs");
}
