export type StructuredCommandPathMatchRule = {
  pattern: readonly string[];
  exact?: boolean;
};

export type CommandPathMatchRule = readonly string[] | StructuredCommandPathMatchRule;

type NormalizedCommandPathMatchRule = {
  pattern: readonly string[];
  exact: boolean;
};

function isStructuredCommandPathMatchRule(
  rule: CommandPathMatchRule,
): rule is StructuredCommandPathMatchRule {
  return !Array.isArray(rule);
}

function normalizeCommandPathMatchRule(rule: CommandPathMatchRule): NormalizedCommandPathMatchRule {
  if (!isStructuredCommandPathMatchRule(rule)) {
    return { pattern: rule, exact: false };
  }
  return { pattern: rule.pattern, exact: rule.exact ?? false };
}

// lyc: 匹配commandPath是否与其它入参相符
export function matchesCommandPath(
  commandPath: string[],
  pattern: readonly string[],
  params?: { exact?: boolean },
): boolean {
  // lyc: 检查commandPath是否与pattern匹配, 只会匹配pattern中包含的命令, 如果不匹配返回false
  if (pattern.some((segment, index) => commandPath[index] !== segment)) {
    return false;
  }
  // lyc: 如果params.exact为true, 则commandPath的长度必须与pattern的长度相同, 代表必须完全匹配(命令完全相同), 否则返回false
  return !params?.exact || commandPath.length === pattern.length;
}

export function matchesCommandPathRule(commandPath: string[], rule: CommandPathMatchRule): boolean {
  const normalizedRule = normalizeCommandPathMatchRule(rule);
  return matchesCommandPath(commandPath, normalizedRule.pattern, {
    exact: normalizedRule.exact,
  });
}

export function matchesAnyCommandPath(
  commandPath: string[],
  rules: readonly CommandPathMatchRule[],
): boolean {
  return rules.some((rule) => matchesCommandPathRule(commandPath, rule));
}
