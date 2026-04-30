import { isValueToken } from "../infra/cli-root-options.js";

// lyc: 获取CLI根选项的值, 支持内联值和后续参数
export function takeCliRootOptionValue(
  raw: string,
  next: string | undefined,
): {
  // lyc: 返回选项的值
  value: string | null;
  // lyc: 是否消耗了下一个选项, true为后续参数, false为内联参数
  consumedNext: boolean;
} {
  // lyc: 内联值, 例如--container=container-name
  if (raw.includes("=")) {
    const [, value] = raw.split("=", 2);
    const trimmed = (value ?? "").trim();
    return { value: trimmed || null, consumedNext: false };
  }
  const consumedNext = isValueToken(next);
  const trimmed = consumedNext ? next!.trim() : "";
  return { value: trimmed || null, consumedNext };
}
