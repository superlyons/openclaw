import { type EnvMap, resolveAutoNodeExtraCaCerts } from "./node-extra-ca-certs.js";

export type NodeStartupTlsEnvironment = {
  NODE_EXTRA_CA_CERTS?: string;
  NODE_USE_SYSTEM_CA?: string;
};

// lyc: 解析 Node.js 启动时的 TLS 环境变量, 包括自定义CA证书路径和是否使用系统CA证书
export function resolveNodeStartupTlsEnvironment(
  params: {
    env?: EnvMap;
    platform?: NodeJS.Platform;
    execPath?: string;
    includeDarwinDefaults?: boolean;
    accessSync?: (path: string, mode?: number) => void;
  } = {},
): NodeStartupTlsEnvironment {
  const env = params.env ?? (process.env as EnvMap);
  const platform = params.platform ?? process.platform;
  const includeDarwinDefaults = params.includeDarwinDefaults ?? true;
  // lyc: 自定义CA证书路径, 获取途径: NODE_EXTRA_CA_CERTS, darwin系统默认值 /etc/ssl/cert.pem, 自动解析 Linux 系统下的 CA 证书路径
  const nodeExtraCaCerts =
    env.NODE_EXTRA_CA_CERTS ??
    (platform === "darwin" && includeDarwinDefaults
      ? "/etc/ssl/cert.pem"
      : resolveAutoNodeExtraCaCerts({
          env,
          platform,
          execPath: params.execPath,
          accessSync: params.accessSync,
        }));
  // lyc: 是否使用系统CA证书, NODE_USE_SYSTEM_CA, darwin系统默认开启
  const nodeUseSystemCa =
    env.NODE_USE_SYSTEM_CA ?? (platform === "darwin" && includeDarwinDefaults ? "1" : undefined);

  return {
    NODE_EXTRA_CA_CERTS: nodeExtraCaCerts,
    NODE_USE_SYSTEM_CA: nodeUseSystemCa,
  };
}
