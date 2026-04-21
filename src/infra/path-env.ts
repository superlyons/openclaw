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
/* lyc: 合并路径, 并确保每个路径只出现一次, 并保持路径顺序（prepend → existing → append）
existing = "/usr/bin:/bin:/usr/local/bin:/opt/tools";
prepend = ["/opt/tools", "/custom/bin", "/usr/bin"];
append = ["/another/path", "/opt/tools", "/custom/bin"];
结果: "/opt/tools:/custom/bin:/usr/bin:/bin:/usr/local/bin:/another/path"
*/
function mergePath(params: { existing: string; prepend?: string[]; append?: string[] }): string {
  const partsExisting = params.existing
    // lyc: 在Windows上是';'，在POSIX系统上是':'
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

// lyc: 解析可执行二进制文件目录, 并将其添加到prepend(前置)和append(追加)中
function candidateBinDirs(opts: EnsureOpenClawPathOpts): { prepend: string[]; append: string[] } {
  // lyc: 获取node的可执行文件路径, 当前工作目录, 用户主目录, 系统平台
  const execPath = opts.execPath ?? process.execPath;
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;

  const prepend: string[] = [];
  const append: string[] = [];

  // Keep the active runtime directory ahead of PATH hardening so shebang-based
  // subprocesses keep using the same Node/Bun the current OpenClaw process is on.
  // lyc: 在进行PATH环境变量强化之前，请确保活动运行时目录位于PATH环境变量之前，以便基于shebang的子进程能够继续使用当前OpenClaw进程所使用的Node/Bun版本。
  try {
    // lyc: 如果node的可执行文件所在目录是可执行的, 则将其目录添加到prepend(前置)中
    const execDir = path.dirname(execPath);
    if (isExecutable(execPath)) {
      prepend.push(execDir);
    }
  } catch {
    // ignore
  }

  // Bundled macOS app: `openclaw` lives next to the executable (process.execPath).
  // lyc: 预捆绑的macOS应用程序：`openclaw`位于可执行文件（process.execPath）旁边。
  try {
    // lyc: dir(execPath)/openclaw 是可执行的, 则将其目录添加到prepend(前置)中
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
  // lyc: 项目本地安装是一种常见的基于仓库的攻击向量（二进制文件劫持）。默认情况下应保持禁用状态；如果操作员明确启用，则仅进行追加（从不前置）。
  const allowProjectLocalBin =
    opts.allowProjectLocalBin === true ||
    isTruthyEnvValue(process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN);
  if (allowProjectLocalBin) {
    // lyc: cwd()/node_modules/.bin/openclaw 是可执行的, 则将其目录添加到append(追加)中
    const localBinDir = path.join(cwd, "node_modules", ".bin");
    if (isExecutable(path.join(localBinDir, "openclaw"))) {
      append.push(localBinDir);
    }
  }

  // Only immutable OS directories go in prepend so they take priority over
  // user-writable locations, preventing PATH hijack of system binaries.
  // lyc: 只有不可变的操作系统目录才会被置于前面，这样它们就能优先于用户可写位置，从而防止系统二进制文件被PATH劫持。
  prepend.push("/usr/bin", "/bin");

  // User-writable / package-manager directories are appended so they never
  // shadow trusted OS binaries.
  // This includes Brew/Homebrew dirs, which are useful for finding `openclaw`
  // in launchd/minimal environments but must not be treated as trusted.
  /* lyc: 用户可写/包管理器目录会被追加，因此它们永远不会覆盖受信任的操作系统二进制文件。
    这包括Brew/Homebrew目录，这些目录在launchd/minimal环境中对于查找`openclaw`很有用，但绝不能被视为可信目录。
  */
  // lyc: brew指的是: Homebrew和Linuxbrew的路径目录, 将其添加到append(追加)中
  append.push(...resolveBrewPathDirs({ homeDir }));
  // lyc: MISE指的是 ‌mise‌ 一个现代化的开发环境管理工具,支持 Python、Node.js、Go、Rust、Java 等 ‌700+ 种开发工具‌。
  // lyc: MISE_DATA_DIR‌ 是一个可自定义的环境变量，用于指定 ‌mise 安装和存储开发工具版本的根目录‌。
  // lyc: 如果设置了env.MISE_DATA_DIR, miseDataDir = ~/.local/share/mise
  const miseDataDir = process.env.MISE_DATA_DIR ?? path.join(homeDir, ".local", "share", "mise");
  // lyc: ~/.local/share/mise/shims, 是一个目录, 用于存储 ‌mise 安装的二进制文件的符号链接。
  const miseShims = path.join(miseDataDir, "shims");
  if (isDirectory(miseShims)) {
    append.push(miseShims);
  }
  // lyc: 如果是darwin平台, 则追加~/Library/pnpm
  if (platform === "darwin") {
    append.push(path.join(homeDir, "Library", "pnpm"));
  }
  // lyc: ‌XDG‌ 是指由 ‌freedesktop.org‌ 制定的一套 Linux 桌面环境标准规范，全称为 ‌X Desktop Group‌，其核心目标是统一不同桌面环境（如 GNOME、KDE、XFCE 等）中应用程序的文件存储位置，解决长期以来配置文件、数据文件、缓存等混杂在用户主目录（~）下的混乱问题。
  // lyc: env.XDG_BIN_HOME‌ 用户可执行二进制文件目录‌，默认为 ~/.local/bin，用于存放用户安装的命令行工具或脚本 ‌
  // lyc: 如果设置了env.XDG_BIN_HOME, 则追加该目录
  if (process.env.XDG_BIN_HOME) {
    append.push(process.env.XDG_BIN_HOME);
  }
  // lyc: ~/.local/bin, ~/.local/share/pnpm, ~/.bun/bin, ~/.yarn/bin, 都是用户可执行的二进制文件目录
  append.push(path.join(homeDir, ".local", "bin"));
  append.push(path.join(homeDir, ".local", "share", "pnpm"));
  append.push(path.join(homeDir, ".bun", "bin"));
  append.push(path.join(homeDir, ".yarn", "bin"));

  return { prepend: prepend.filter(isDirectory), append: append.filter(isDirectory) };
}

/**
 * Best-effort PATH bootstrap so skills that require the `openclaw` CLI can run
 * under launchd/minimal environments (and inside the macOS app bundle).
 */
// lyc: 尽最大努力设置引导 PATH，使得需要`openclaw`命令行界面的skills可以在launchd(启动守护进程)/最小环境下运行（以及在macOS应用程序包内运行）。
// lyc: 设置env.PATH
export function ensureOpenClawCliOnPath(opts: EnsureOpenClawPathOpts = {}) {
  if (isTruthyEnvValue(process.env.OPENCLAW_PATH_BOOTSTRAPPED)) {
    return;
  }
  process.env.OPENCLAW_PATH_BOOTSTRAPPED = "1";

  const existing = opts.pathEnv ?? process.env.PATH ?? "";
  // lyc: 解析可执行二进制文件目录, 并将其添加到prepend(前置)和append(追加)中
  const { prepend, append } = candidateBinDirs(opts);
  if (prepend.length === 0 && append.length === 0) {
    return;
  }
  // lyc: 合并路径, 并确保每个路径只出现一次, 并保持路径顺序（prepend → existing → append）
  const merged = mergePath({ existing, prepend, append });
  if (merged) {
    process.env.PATH = merged;
  }
}
