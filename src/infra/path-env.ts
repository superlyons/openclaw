import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrewPathDirs } from "./brew.js";
import { isTruthyEnvValue } from "./env.js";

type EnsureOpenClawPathOpts = {
  execPath?: string;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  pathEnv?: string;
  allowProjectLocalBin?: boolean;
};

// lyc: 检查文件是否可执行
function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

// lyc: 合并候选目录到 PATH 中
function mergePath(params: { existing: string; prepend?: string[]; append?: string[] }): string {
  // lyc: path.delimiter: PATH 中的分隔符, linux为":", windows为";"
  const partsExisting = params.existing
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  const partsPrepend = (params.prepend ?? []).map((part) => part.trim()).filter(Boolean);
  const partsAppend = (params.append ?? []).map((part) => part.trim()).filter(Boolean);

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of [...partsPrepend, ...partsExisting, ...partsAppend]) {
    if (!seen.has(part)) {
      seen.add(part);
      merged.push(part);
    }
  }
  return merged.join(path.delimiter);
}

function candidateBinDirs(opts: EnsureOpenClawPathOpts): { prepend: string[]; append: string[] } {
  // lyc: node.js/node.exe程序的路径
  const execPath = opts.execPath ?? process.execPath;
  // lyc: node.js当前工作目录的路径, 即运行node.js脚本的目录
  const cwd = opts.cwd ?? process.cwd();
  // lyc: 用户主目录的路径
  const homeDir = opts.homeDir ?? os.homedir();
  // lyc: 当前操作系统
  const platform = opts.platform ?? process.platform;

  const prepend: string[] = [];
  const append: string[] = [];

  // Bundled macOS app: `openclaw` lives next to the executable (process.execPath).
  // lyc: 检查node.js程序所在目录是否存在"openclaw"可执行文件
  try {
    const execDir = path.dirname(execPath);
    const siblingCli = path.join(execDir, "openclaw");
    if (isExecutable(siblingCli)) {
      prepend.push(execDir);
    }
  } catch {
    // ignore
  }

  // Project-local installs are a common repo-based attack vector (bin hijacking). Keep this
  // disabled by default; if an operator explicitly enables it, only append (never prepend).
  // lyc: 项目本地安装是一种常见的基于仓库的攻击向量（二进制文件劫持）。默认情况下应保持禁用状态；如果操作员明确启用，则仅进行追加（绝不前置）。
  const allowProjectLocalBin =
    opts.allowProjectLocalBin === true ||
    isTruthyEnvValue(process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN);
  if (allowProjectLocalBin) {
    // lyc: 检查项目本地安装目录是否存在"openclaw"可执行文件, 地址为:cwd+node_modules/.bin/openclaw
    const localBinDir = path.join(cwd, "node_modules", ".bin");
    if (isExecutable(path.join(localBinDir, "openclaw"))) {
      // 仅进行追加(append)（绝不前置prepend）
      append.push(localBinDir);
    }
  }

  // lyc: 检查MISE数据目录是否存在"shims"目录, 地址为:homeDir/.local/share/mise/shims
  const miseDataDir = process.env.MISE_DATA_DIR ?? path.join(homeDir, ".local", "share", "mise");
  const miseShims = path.join(miseDataDir, "shims");
  if (isDirectory(miseShims)) {
    prepend.push(miseShims);
  }

  prepend.push(...resolveBrewPathDirs({ homeDir }));

  // Common global install locations (macOS first).
  // lyc: 检查用户主目录是否存在"Library/pnpm"目录, 地址为:homeDir/Library/pnpm
  if (platform === "darwin") {
    prepend.push(path.join(homeDir, "Library", "pnpm"));
  }
  if (process.env.XDG_BIN_HOME) {
    prepend.push(process.env.XDG_BIN_HOME);
  }
  prepend.push(path.join(homeDir, ".local", "bin"));
  prepend.push(path.join(homeDir, ".local", "share", "pnpm"));
  prepend.push(path.join(homeDir, ".bun", "bin"));
  prepend.push(path.join(homeDir, ".yarn", "bin"));
  prepend.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");

  return { prepend: prepend.filter(isDirectory), append: append.filter(isDirectory) };
}

/**
 * Best-effort PATH bootstrap so skills that require the `openclaw` CLI can run
 * under launchd/minimal environments (and inside the macOS app bundle).
 */
/* lyc: 
  尽最大努力实现PATH引导，以便需要`openclaw`命令行界面（CLI）的技能(skills)可以在 启动守护进程/最小环境下（以及macOS应用程序包内）运行。
  “尽力而为”的PATH引导，使得需要`openclaw`命令行界面的技能(skills)可以在 启动守护进程/最小环境下 运行（以及在macOS应用程序包内运行）。
*/
export function ensureOpenClawCliOnPath(opts: EnsureOpenClawPathOpts = {}) {
  // lyc: 如果已经引导了PATH，就直接返回
  if (isTruthyEnvValue(process.env.OPENCLAW_PATH_BOOTSTRAPPED)) {
    return;
  }
  // lyc: 标记为已引导, 避免重复执行
  process.env.OPENCLAW_PATH_BOOTSTRAPPED = "1";

  const existing = opts.pathEnv ?? process.env.PATH ?? "";
  // lyc: 获得候选的二进制目录列表, prepend: 前置目录, append: 后置目录, 前置目录更安全并且优先使用, 后置目录最后使用
  const { prepend, append } = candidateBinDirs(opts);
  if (prepend.length === 0 && append.length === 0) {
    return;
  }

  // lyc: mergePath会在existing前后插入前置和后置目录, 前置目录优先使用, existing目录次之, 后置目录最后使用
  const merged = mergePath({ existing, prepend, append });
  if (merged) {
    process.env.PATH = merged;
  }
}
