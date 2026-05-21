const optionalBundledClusters = [
  "acpx",
  "diagnostics-otel",
  "diffs",
  "googlechat",
  "memory-lancedb",
  "msteams",
  "nostr",
  "tlon",
  "twitch",
  "ui",
  "whatsapp",
  "zalouser",
];

export const optionalBundledClusterSet = new Set(optionalBundledClusters);

const OPTIONAL_BUNDLED_BUILD_ENV = "OPENCLAW_INCLUDE_OPTIONAL_BUNDLED";

// lyc: 检查插件是否是可选捆绑集群
// lyc:aic v2026.5：upstream 去掉了 export，变成模块私有
function isOptionalBundledCluster(cluster) {
  return optionalBundledClusterSet.has(cluster);
}

// lyc: 是否应包含可选捆绑集群
// lyc:aic v2026.5：upstream 去掉了 export
function shouldIncludeOptionalBundledClusters(env = process.env) {
  // Release artifacts should preserve the last shipped upgrade surface by
  // default. Specific size-sensitive lanes can still opt out explicitly.
  // lyc:  默认情况下，发布工件应保留上次发布的升级界面。对尺寸敏感的特定通道仍可明确选择退出。
  return env[OPTIONAL_BUNDLED_BUILD_ENV] !== "0";
}

// lyc: 检查插件是否是已发布的捆绑集群
// lyc: 即插件的package.json文件中是否有openclaw.install.npmSpec字段, 且该字段的值不是空字符串
// lyc:aic v2026.5：upstream 去掉了 export
function hasReleasedBundledInstall(packageJson) {
  return (
    typeof packageJson?.openclaw?.install?.npmSpec === "string" &&
    packageJson.openclaw.install.npmSpec.trim().length > 0
  );
}

// lyc: 检查是否应构建捆绑集群: 以下三种情况之一为true
// lyc: package.json.openclaw.install.npmSpec, env.OPENCLAW_INCLUDE_OPTIONAL_BUNDLED !== "0", optionalBundledClusters.includes(cluster)
export function shouldBuildBundledCluster(cluster, env = process.env, options = {}) {
  if (hasReleasedBundledInstall(options.packageJson)) {
    return true;
  }
  return shouldIncludeOptionalBundledClusters(env) || !isOptionalBundledCluster(cluster);
}
