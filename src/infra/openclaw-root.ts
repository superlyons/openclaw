import path from "node:path";
import { fileURLToPath } from "node:url";
import { openClawRootFs, openClawRootFsSync } from "./openclaw-root.fs.runtime.js";

const CORE_PACKAGE_NAMES = new Set(["openclaw"]);

function parsePackageName(raw: string): string | null {
  const parsed = JSON.parse(raw) as { name?: unknown };
  return typeof parsed.name === "string" ? parsed.name : null;
}

async function readPackageName(dir: string): Promise<string | null> {
  try {
    return parsePackageName(await openClawRootFs.readFile(path.join(dir, "package.json"), "utf-8"));
  } catch {
    return null;
  }
}

function readPackageNameSync(dir: string): string | null {
  try {
    return parsePackageName(
      openClawRootFsSync.readFileSync(path.join(dir, "package.json"), "utf-8"),
    );
  } catch {
    return null;
  }
}

async function findPackageRoot(startDir: string, maxDepth = 12): Promise<string | null> {
  for (const current of iterAncestorDirs(startDir, maxDepth)) {
    const name = await readPackageName(current);
    if (name && CORE_PACKAGE_NAMES.has(name)) {
      return current;
    }
  }
  return null;
}

// lyc: 查找 根package.json 所在的目录
// lyc: 从startDir开始向上遍历目录，查找第一个包含package.json的目录，这个package.json必须有name字段，且name字段的值在CORE_PACKAGE_NAMES中，则返回这个目录，否则返回null
function findPackageRootSync(startDir: string, maxDepth = 12): string | null {
  for (const current of iterAncestorDirs(startDir, maxDepth)) {
    const name = readPackageNameSync(current);
    if (name && CORE_PACKAGE_NAMES.has(name)) {
      return current;
    }
  }
  return null;
}

function* iterAncestorDirs(startDir: string, maxDepth: number): Generator<string> {
  let current = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i += 1) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

/* lyc: 从argv1中提取候选目录, argv1为process.argv[1]的值,  node myscript.js arg1 arg2 -> process.argv[1] = /path/to/mycript.js
设 argv1 = "/path/to/node_modules/.bin/openclaw"
*/
function candidateDirsFromArgv1(argv1: string): string[] {
  const normalized = path.resolve(argv1);
  // lyc: /path/to/node_modules/.bin
  const candidates = [path.dirname(normalized)];

  // Resolve symlinks for version managers (nvm, fnm, n, Homebrew/Linuxbrew)
  // that create symlinks in bin/ pointing to the real package location.
  // lyc: 为版本管理器（nvm、fnm、n、Homebrew/Linuxbrew）解析符号链接，这些管理器会在bin/目录中创建指向实际包位置的符号链接。
  try {
    // lyc: 设argv1的"/path/to/node_modules/.bin/openclaw"是一个符号链接，resolved为解析后的实际包位置
    // lyc: 因此添加到候选目录中candidates
    const resolved = openClawRootFsSync.realpathSync(normalized);
    if (resolved !== normalized) {
      candidates.push(path.dirname(resolved));
    }
  } catch {
    // realpathSync throws if path doesn't exist; keep original candidates
  }

  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  // lyc: argv1的"/path/to/node_modules/.bin/app/agent/openclaw"是运行在"../node_modules/.bin/..."目录下的
  if (binIndex > 0 && parts[binIndex - 1] === "node_modules") {
    // lyc: binName = openclaw
    const binName = path.basename(normalized);
    // lyc: nodeModulesDir = /path/to/node_modules/.bin
    const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
    // lyc: /path/to/node_modules/.bin/openclaw
    candidates.push(path.join(nodeModulesDir, binName));
  }
  return candidates;
}

export async function resolveOpenClawPackageRoot(opts: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): Promise<string | null> {
  for (const candidate of buildCandidates(opts)) {
    const found = await findPackageRoot(candidate);
    if (found) {
      return found;
    }
  }

  return null;
}

// lyc: 从argv1、moduleUrl、cwd中提取候选目录, 并在候选目录中向上查找 根package.json 所在的目录, 找到返回这个目录, 否则返回null
export function resolveOpenClawPackageRootSync(opts: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): string | null {
  for (const candidate of buildCandidates(opts)) {
    const found = findPackageRootSync(candidate);
    if (found) {
      return found;
    }
  }

  return null;
}

// lyc: 从argv1、moduleUrl、cwd中提取候选目录
function buildCandidates(opts: { cwd?: string; argv1?: string; moduleUrl?: string }): string[] {
  const candidates: string[] = [];

  if (opts.moduleUrl) {
    try {
      candidates.push(path.dirname(fileURLToPath(opts.moduleUrl)));
    } catch {
      // Ignore invalid file:// URLs and keep other package-root hints.
    }
  }
  if (opts.argv1) {
    candidates.push(...candidateDirsFromArgv1(opts.argv1));
  }
  if (opts.cwd) {
    candidates.push(opts.cwd);
  }

  return candidates;
}
