import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";

export type OwnerDisplaySetting = {
  ownerDisplay?: "raw" | "hash";
  ownerDisplaySecret?: string;
};

export type OwnerDisplaySecretResolution = {
  config: OpenClawConfig;
  generatedSecret?: string;
};

function trimToUndefined(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve owner display settings for prompt rendering.
 * Keep auth secrets decoupled from owner hash secrets.
 */
// lyc: 解决所有者显示设置问题，以便提示信息的呈现。保持认证密码与所有者哈希密码解耦。
export function resolveOwnerDisplaySetting(config?: OpenClawConfig): OwnerDisplaySetting {
  // lyc: ownerDisplay: 代表所有者ID在系统提示中的呈现方式。(raw 或 hash)
  const ownerDisplay = config?.commands?.ownerDisplay;
  if (ownerDisplay !== "hash") {
    return { ownerDisplay, ownerDisplaySecret: undefined };
  }
  return {
    ownerDisplay: "hash",
    // lyc: ownerDisplaySecret: 当 ownerDisplay 为“hash”时，用于对所有者ID哈希进行加密的密钥。
    ownerDisplaySecret: trimToUndefined(config?.commands?.ownerDisplaySecret),
  };
}

/**
 * Ensure hash mode has a dedicated secret.
 * Returns updated config and generated secret when autofill was needed.
 */
// lyc: 确保 hash 模式有专用密钥, (config.commands.ownerDisplay=hash时，保证ownerDisplaySecret一定有值)
export function ensureOwnerDisplaySecret(
  config: OpenClawConfig,
  generateSecret: () => string = () => crypto.randomBytes(32).toString("hex"),
): OwnerDisplaySecretResolution {
  // lyc: 获得所有者显示设置
  const settings = resolveOwnerDisplaySetting(config);
  // lyc: 如果 ownerDisplay 不为“hash” 或 ownerDisplaySecret有值，则原封直接返回config配置
  if (settings.ownerDisplay !== "hash" || settings.ownerDisplaySecret) {
    return { config };
  }
  // lyc: 生成专用密钥,并更新config配置
  const generatedSecret = generateSecret();
  return {
    config: {
      ...config,
      commands: {
        ...config.commands,
        ownerDisplay: "hash",
        ownerDisplaySecret: generatedSecret,
      },
    },
    generatedSecret,
  };
}
