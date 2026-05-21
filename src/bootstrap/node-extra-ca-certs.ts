import fs from "node:fs";

// lyc: Linux 系统下的 CA 证书路径候选列表
export const LINUX_CA_BUNDLE_PATHS = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
] as const;

export type EnvMap = Record<string, string | undefined>;
type AccessSyncFn = (path: string, mode?: number) => void;

// lyc: 解析 Linux 系统下的有效的 CA 证书路径(从 LINUX_CA_BUNDLE_PATHS 中尝试每个路径)
export function resolveLinuxSystemCaBundle(
  params: {
    platform?: NodeJS.Platform;
    accessSync?: AccessSyncFn;
  } = {},
): string | undefined {
  const platform = params.platform ?? process.platform;
  if (platform !== "linux") {
    return undefined;
  }

  const accessSync = params.accessSync ?? fs.accessSync.bind(fs);
  for (const candidate of LINUX_CA_BUNDLE_PATHS) {
    try {
      accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

// lyc: 检查是否为 NVM (Node.js 版本管理器) 运行时
export function isNodeVersionManagerRuntime(
  env: EnvMap = process.env as EnvMap,
  execPath: string = process.execPath,
): boolean {
  if (env.NVM_DIR?.trim()) {
    return true;
  }
  return execPath.includes("/.nvm/");
}

// lyc: 自动解析 Node.js 额外 CA 证书路径(从 LINUX_CA_BUNDLE_PATHS 中尝试每个路径)
// lyc: 如果成功解析, 则返回该路径; 否则返回 undefined
// lyc: 如果 NODE_EXTRA_CA_CERTS(自定义CA证书路径) 已设置, 则返回 undefined
export function resolveAutoNodeExtraCaCerts(
  params: {
    env?: EnvMap;
    platform?: NodeJS.Platform;
    execPath?: string;
    accessSync?: AccessSyncFn;
  } = {},
): string | undefined {
  const env = params.env ?? (process.env as EnvMap);
  // lyc: 如果 NODE_EXTRA_CA_CERTS(自定义CA证书路径) 已设置, 则返回 undefined
  if (env.NODE_EXTRA_CA_CERTS?.trim()) {
    return undefined;
  }

  const platform = params.platform ?? process.platform;
  const execPath = params.execPath ?? process.execPath;
  // lyc: 如果不是 Linux 系统, 或者不是 NVM (Node.js 版本管理器) 运行时, 则返回 undefined
  if (platform !== "linux" || !isNodeVersionManagerRuntime(env, execPath)) {
    return undefined;
  }

  // lyc: 解析 Linux 系统下的有效的 CA 证书路径(从 LINUX_CA_BUNDLE_PATHS 中尝试每个路径)
  // lyc: 如果成功解析, 则返回该路径; 否则返回 undefined
  return resolveLinuxSystemCaBundle({
    platform,
    accessSync: params.accessSync,
  });
}
