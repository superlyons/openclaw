import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { matchRootFileOpenFailure } from "../infra/boundary-file-read.js";
import { readRootStructuredFileSync } from "../infra/json-files.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import type { PluginBundleFormat } from "./manifest-types.js";
import type { PluginManifestActivation } from "./manifest.js";
import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  normalizeManifestActivation,
  PLUGIN_MANIFEST_FILENAME,
} from "./manifest.js";

export const CODEX_BUNDLE_MANIFEST_RELATIVE_PATH = ".codex-plugin/plugin.json";
export const CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH = ".claude-plugin/plugin.json";
export const CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH = ".cursor-plugin/plugin.json";

export type BundlePluginManifest = {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  skills: string[];
  settingsFiles?: string[];
  // Only include hook roots that OpenClaw can execute via HOOK.md + handler files.
  hooks: string[];
  bundleFormat: PluginBundleFormat;
  activation?: PluginManifestActivation;
  capabilities: string[];
};

export type BundleManifestLoadResult =
  | { ok: true; manifest: BundlePluginManifest; manifestPath: string }
  | { ok: false; error: string; manifestPath: string };

type BundleManifestFileLoadResult =
  | { ok: true; raw: Record<string, unknown>; manifestPath: string }
  | { ok: false; error: string; manifestPath: string };

function normalizePathList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

export function normalizeBundlePathList(value: unknown): string[] {
  return Array.from(new Set(normalizePathList(value)));
}

export function mergeBundlePathLists(...groups: string[][]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged;
}

function hasInlineCapabilityValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return value === true;
}

// lyc: 插件ID转义, raw或rootDir的basename作为默认值,并进行转义: 转小写, 非字母数字字符替换为短横线-, 去掉首尾的横线, 如果为空则返回默认值 bundle-plugin
function slugifyPluginId(raw: string | undefined, rootDir: string): string {
  const fallback = path.basename(rootDir);
  const source = normalizeLowercaseStringOrEmpty(raw) || normalizeLowercaseStringOrEmpty(fallback);
  const slug = source
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "bundle-plugin";
}

// lyc: 加载绑定插件的清单manifest文件
function loadBundleManifestFile(params: {
  rootDir: string;
  rootRealPath?: string;
  manifestRelativePath: string;
  rejectHardlinks: boolean;
  allowMissing?: boolean;
}): BundleManifestFileLoadResult {
  const manifestPath = path.join(params.rootDir, params.manifestRelativePath);
  const result = readRootStructuredFileSync<Record<string, unknown>>({
    rootDir: params.rootDir,
    ...(params.rootRealPath !== undefined ? { rootRealPath: params.rootRealPath } : {}),
    relativePath: params.manifestRelativePath,
    boundaryLabel: "plugin root",
    rejectHardlinks: params.rejectHardlinks,
    parse: (raw) => JSON5.parse(raw),
    validate: isRecord,
  });
  if (!result.ok && result.reason === "open") {
    return matchRootFileOpenFailure(result.failure, {
      path: () => {
        if (params.allowMissing) {
          return { ok: true, raw: {}, manifestPath };
        }
        return { ok: false, error: `plugin manifest not found: ${manifestPath}`, manifestPath };
      },
      fallback: (failure) => ({
        ok: false,
        error: `unsafe plugin manifest path: ${manifestPath} (${failure.reason})`,
        manifestPath,
      }),
    });
  }
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === "invalid"
          ? "plugin manifest must be an object"
          : `failed to parse plugin manifest: ${result.error}`,
      manifestPath,
    };
  }
  return { ok: true, raw: result.value, manifestPath };
}

// lyc: 解析codex插件的技能目录列表, 如果manifest中没有声明技能目录列表, skills目录存在则返回默认目录 [skills]
function resolveCodexSkillDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  const declared = normalizeBundlePathList(raw.skills);
  if (declared.length > 0) {
    return declared;
  }
  return fs.existsSync(path.join(rootDir, "skills")) ? ["skills"] : [];
}

// lyc: 解析codex插件的hooks目录列表, 如果manifest中没有声明hooks目录列表, hooks目录存在则返回默认目录 [hooks]
function resolveCodexHookDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  const declared = normalizeBundlePathList(raw.hooks);
  if (declared.length > 0) {
    return declared;
  }
  return fs.existsSync(path.join(rootDir, "hooks")) ? ["hooks"] : [];
}

// lyc: 解析cursor插件的技能列表, 返回 [...raw.skills, skills(如果skills目录存在)] 去重
function resolveCursorSkillsRootDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  const declared = normalizeBundlePathList(raw.skills);
  const defaults = fs.existsSync(path.join(rootDir, "skills")) ? ["skills"] : [];
  return mergeBundlePathLists(defaults, declared);
}

// lyc: 解析cursor插件的命令列表, 返回 [...raw.commands, .cursor/commands(如果目录存在)] 去重
function resolveCursorCommandRootDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  const declared = normalizeBundlePathList(raw.commands);
  const defaults = fs.existsSync(path.join(rootDir, ".cursor", "commands"))
    ? [".cursor/commands"]
    : [];
  return mergeBundlePathLists(defaults, declared);
}

// lyc: 解析cursor插件的技能列表, 返回 [...raw.skills, raw.commands, skills(如果skills目录存在),.cursor/commands(如果目录存在)] 去重
function resolveCursorSkillDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  return mergeBundlePathLists(
    resolveCursorSkillsRootDirs(raw, rootDir),
    resolveCursorCommandRootDirs(raw, rootDir),
  );
}

function resolveCursorAgentDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  const declared = normalizeBundlePathList(raw.subagents ?? raw.agents);
  const defaults = fs.existsSync(path.join(rootDir, ".cursor", "agents")) ? [".cursor/agents"] : [];
  return mergeBundlePathLists(defaults, declared);
}

function hasCursorHookCapability(raw: Record<string, unknown>, rootDir: string): boolean {
  return (
    hasInlineCapabilityValue(raw.hooks) ||
    fs.existsSync(path.join(rootDir, ".cursor", "hooks.json"))
  );
}

function hasCursorRulesCapability(raw: Record<string, unknown>, rootDir: string): boolean {
  return (
    hasInlineCapabilityValue(raw.rules) || fs.existsSync(path.join(rootDir, ".cursor", "rules"))
  );
}

function hasCursorMcpCapability(raw: Record<string, unknown>, rootDir: string): boolean {
  return hasInlineCapabilityValue(raw.mcpServers) || fs.existsSync(path.join(rootDir, ".mcp.json"));
}

// lyc: 解析claude的raw.key列表, 返回 [...raw.key, ...defaults(如果目录存在)] 去重
function resolveClaudeComponentPaths(
  raw: Record<string, unknown>,
  key: string,
  rootDir: string,
  defaults: string[],
): string[] {
  const declared = normalizeBundlePathList(raw[key]);
  const existingDefaults = defaults.filter((candidate) =>
    fs.existsSync(path.join(rootDir, candidate)),
  );
  return mergeBundlePathLists(existingDefaults, declared);
}

// lyc: 解析claude插件的技能列表, 返回 [...raw.skills, skills(如果skills目录存在)] 去重
function resolveClaudeSkillsRootDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "skills", rootDir, ["skills"]);
}

// lyc: 解析claude插件的命令列表, 返回 [...raw.commands, commands(如果commands目录存在)] 去重
function resolveClaudeCommandRootDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "commands", rootDir, ["commands"]);
}

// lyc: 解析claude插件的技能目录列表, 返回 [...raw.skills, raw.commands, ...raw.agents, ...raw.outputStyles, skills(如果skills目录存在), commands(如果commands目录存在), agents(如果agents目录存在),output-styles(如果output-styles目录存在)] 去重
function resolveClaudeSkillDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  return mergeBundlePathLists(
    resolveClaudeSkillsRootDirs(raw, rootDir),
    resolveClaudeCommandRootDirs(raw, rootDir),
    resolveClaudeAgentDirs(raw, rootDir),
    resolveClaudeOutputStylePaths(raw, rootDir),
  );
}

// lyc: 解析claude插件的agents目录列表, 返回 [...raw.agents, agents(如果agents目录存在)] 去重
function resolveClaudeAgentDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "agents", rootDir, ["agents"]);
}

// lyc: 解析claude插件的hooks目录列表, 返回 [...raw.hooks, hooks/hooks.json(如果存在)] 去重
function resolveClaudeHookPaths(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "hooks", rootDir, ["hooks/hooks.json"]);
}

function resolveClaudeMcpPaths(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "mcpServers", rootDir, [".mcp.json"]);
}

function resolveClaudeLspPaths(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "lspServers", rootDir, [".lsp.json"]);
}
// lyc: 解析claude插件的outputStyles目录列表, 返回 [...raw.outputStyles, output-styles(如果目录存在)] 去重

function resolveClaudeOutputStylePaths(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "outputStyles", rootDir, ["output-styles"]);
}

function resolveClaudeSettingsFiles(_raw: Record<string, unknown>, rootDir: string): string[] {
  return fs.existsSync(path.join(rootDir, "settings.json")) ? ["settings.json"] : [];
}

function hasClaudeHookCapability(raw: Record<string, unknown>, rootDir: string): boolean {
  return hasInlineCapabilityValue(raw.hooks) || resolveClaudeHookPaths(raw, rootDir).length > 0;
}

// lyc: 构建codex能力列表
function buildCodexCapabilities(raw: Record<string, unknown>, rootDir: string): string[] {
  const capabilities: string[] = [];
  if (resolveCodexSkillDirs(raw, rootDir).length > 0) {
    capabilities.push("skills");
  }
  if (resolveCodexHookDirs(raw, rootDir).length > 0) {
    capabilities.push("hooks");
  }
  if (hasInlineCapabilityValue(raw.mcpServers) || fs.existsSync(path.join(rootDir, ".mcp.json"))) {
    capabilities.push("mcpServers");
  }
  if (hasInlineCapabilityValue(raw.apps) || fs.existsSync(path.join(rootDir, ".app.json"))) {
    capabilities.push("apps");
  }
  return capabilities;
}
// lyc: 构建claude能力列表

function buildClaudeCapabilities(raw: Record<string, unknown>, rootDir: string): string[] {
  const capabilities: string[] = [];
  if (resolveClaudeSkillDirs(raw, rootDir).length > 0) {
    capabilities.push("skills");
  }
  if (resolveClaudeCommandRootDirs(raw, rootDir).length > 0) {
    capabilities.push("commands");
  }
  if (resolveClaudeAgentDirs(raw, rootDir).length > 0) {
    capabilities.push("agents");
  }
  if (hasClaudeHookCapability(raw, rootDir)) {
    capabilities.push("hooks");
  }
  if (hasInlineCapabilityValue(raw.mcpServers) || resolveClaudeMcpPaths(raw, rootDir).length > 0) {
    capabilities.push("mcpServers");
  }
  if (hasInlineCapabilityValue(raw.lspServers) || resolveClaudeLspPaths(raw, rootDir).length > 0) {
    capabilities.push("lspServers");
  }
  if (
    hasInlineCapabilityValue(raw.outputStyles) ||
    resolveClaudeOutputStylePaths(raw, rootDir).length > 0
  ) {
    capabilities.push("outputStyles");
  }
  if (resolveClaudeSettingsFiles(raw, rootDir).length > 0) {
    capabilities.push("settings");
  }
  return capabilities;
}
// lyc: 构建cursor能力列表

function buildCursorCapabilities(raw: Record<string, unknown>, rootDir: string): string[] {
  const capabilities: string[] = [];
  if (resolveCursorSkillDirs(raw, rootDir).length > 0) {
    capabilities.push("skills");
  }
  if (resolveCursorCommandRootDirs(raw, rootDir).length > 0) {
    capabilities.push("commands");
  }
  if (resolveCursorAgentDirs(raw, rootDir).length > 0) {
    capabilities.push("agents");
  }
  if (hasCursorHookCapability(raw, rootDir)) {
    capabilities.push("hooks");
  }
  if (hasCursorRulesCapability(raw, rootDir)) {
    capabilities.push("rules");
  }
  if (hasCursorMcpCapability(raw, rootDir)) {
    capabilities.push("mcpServers");
  }
  return capabilities;
}

// lyc: 加载绑定插件的清单manifest文件, 特指codex, cursor, claude的绑定插件清单
export function loadBundleManifest(params: {
  rootDir: string;
  rootRealPath?: string;
  bundleFormat: PluginBundleFormat;
  rejectHardlinks?: boolean;
}): BundleManifestLoadResult {
  // lyc: 默认允许硬链接
  const rejectHardlinks = params.rejectHardlinks ?? true;
  // lyc: 根据格式名返回对应的manifest相对路径 .codex-plugin/plugin.json|.cursor-plugin/plugin.json|.claude-plugin/plugin.json
  const manifestRelativePath =
    params.bundleFormat === "codex"
      ? CODEX_BUNDLE_MANIFEST_RELATIVE_PATH
      : params.bundleFormat === "cursor"
        ? CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH
        : CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH;
  // lyc: 加载绑定插件的清单manifest文件
  const loaded = loadBundleManifestFile({
    rootDir: params.rootDir,
    ...(params.rootRealPath !== undefined ? { rootRealPath: params.rootRealPath } : {}),
    manifestRelativePath,
    rejectHardlinks,
    allowMissing: params.bundleFormat === "claude",
  });
  if (!loaded.ok) {
    return loaded;
  }

  const raw = loaded.raw;
  const interfaceRecord = isRecord(raw.interface) ? raw.interface : undefined;
  const name = normalizeOptionalString(raw.name);
  const description =
    normalizeOptionalString(raw.description) ??
    normalizeOptionalString(raw.shortDescription) ??
    normalizeOptionalString(interfaceRecord?.shortDescription);
  const version = normalizeOptionalString(raw.version);

  if (params.bundleFormat === "codex") {
    const skills = resolveCodexSkillDirs(raw, params.rootDir);
    const hooks = resolveCodexHookDirs(raw, params.rootDir);
    return {
      ok: true,
      manifest: {
        // lyc: 插件ID转义, raw.name或rootDir的basename作为默认值,并进行转义: 转小写, 非字母数字字符替换为短横线-, 去掉首尾的横线, 如果为空则返回默认值 bundle-plugin
        id: slugifyPluginId(name, params.rootDir),
        name,
        description,
        version,
        skills,
        settingsFiles: [],
        hooks,
        bundleFormat: "codex",
        // lyc: codex 的能力列表
        // lyc:aic v2026.5 新增：activation 字段（normalizeManifestActivation 规范化激活规则）
        activation: normalizeManifestActivation(raw.activation),
        capabilities: buildCodexCapabilities(raw, params.rootDir),
      },
      manifestPath: loaded.manifestPath,
    };
  }

  if (params.bundleFormat === "cursor") {
    return {
      ok: true,
      manifest: {
        id: slugifyPluginId(name, params.rootDir),
        name,
        description,
        version,
        // lyc: 解析cursor插件的技能列表, 返回 [...raw.skills, raw.commands, skills(如果skills目录存在),.cursor/commands(如果目录存在)] 去重
        skills: resolveCursorSkillDirs(raw, params.rootDir),
        settingsFiles: [],
        hooks: [],
        bundleFormat: "cursor",
        // lyc: cursor 的能力列表
        // lyc:aic v2026.5 新增：activation 字段
        activation: normalizeManifestActivation(raw.activation),
        capabilities: buildCursorCapabilities(raw, params.rootDir),
      },
      manifestPath: loaded.manifestPath,
    };
  }

  return {
    ok: true,
    manifest: {
      id: slugifyPluginId(name, params.rootDir),
      name,
      description,
      version,
      // lyc: 解析claude插件的技能列表, 返回 [...raw.skills, raw.commands, ...raw.agents, ...raw.outputStyles, skills(如果skills目录存在), commands(如果commands目录存在), agents(如果agents目录存在),output-styles(如果output-styles目录存在)] 去重
      skills: resolveClaudeSkillDirs(raw, params.rootDir),
      // lyc: 解析claude插件的settings.json文件列表
      settingsFiles: resolveClaudeSettingsFiles(raw, params.rootDir),
      // lyc: 解析claude插件的hooks目录列表, 返回 [...raw.hooks, hooks/hooks.json(如果存在)] 去重
      hooks: resolveClaudeHookPaths(raw, params.rootDir),
      bundleFormat: "claude",
      // lyc: claude 的能力列表
      // lyc:aic v2026.5 新增：activation 字段
      activation: normalizeManifestActivation(raw.activation),
      capabilities: buildClaudeCapabilities(raw, params.rootDir),
    },
    manifestPath: loaded.manifestPath,
  };
}

/* lyc: 检测插件包的格式并返回格式名(codex|cursor|claude|null), 代表非openclaw插件包(rootDir/package.json)的格式需要进一步确定
*/
export function detectBundleManifestFormat(rootDir: string): PluginBundleFormat | null {
  if (fs.existsSync(path.join(rootDir, CODEX_BUNDLE_MANIFEST_RELATIVE_PATH))) {
    return "codex";
  }
  if (fs.existsSync(path.join(rootDir, CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH))) {
    return "cursor";
  }
  if (fs.existsSync(path.join(rootDir, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH))) {
    return "claude";
  }
  if (fs.existsSync(path.join(rootDir, PLUGIN_MANIFEST_FILENAME))) {
    return null;
  }
  if (
    DEFAULT_PLUGIN_ENTRY_CANDIDATES.some((candidate) =>
      fs.existsSync(path.join(rootDir, candidate)),
    )
  ) {
    return null;
  }
  const manifestlessClaudeMarkers = [
    path.join(rootDir, "skills"),
    path.join(rootDir, "commands"),
    path.join(rootDir, "agents"),
    path.join(rootDir, "hooks", "hooks.json"),
    path.join(rootDir, ".mcp.json"),
    path.join(rootDir, ".lsp.json"),
    path.join(rootDir, "settings.json"),
  ];
  if (manifestlessClaudeMarkers.some((candidate) => fs.existsSync(candidate))) {
    return "claude";
  }
  return null;
}
