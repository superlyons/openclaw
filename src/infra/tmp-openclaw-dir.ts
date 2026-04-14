import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const POSIX_OPENCLAW_TMP_DIR = "/tmp/openclaw";
const TMP_DIR_ACCESS_MODE = fs.constants.W_OK | fs.constants.X_OK;

type ResolvePreferredOpenClawTmpDirOptions = {
  accessSync?: (path: string, mode?: number) => void;
  chmodSync?: (path: string, mode: number) => void;
  lstatSync?: (path: string) => {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode?: number;
    uid?: number;
  };
  mkdirSync?: (path: string, opts: { recursive: boolean; mode?: number }) => void;
  getuid?: () => number | undefined;
  tmpdir?: () => string;
  warn?: (message: string) => void;
};

type MaybeNodeError = { code?: string };

function isNodeErrorWithCode(err: unknown, code: string): err is MaybeNodeError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as MaybeNodeError).code === code
  );
}

/* lyc:
  解析受信任的 OpenClaw 临时目录, 地址可能为: 
    tmpdir() + "/openclaw" 或 tmpdir() + "/openclaw-" + uid
    /tmp/openclaw
  如果目录不存在, 则创建目录, 并设置目录权限为 700 安全的私有目录
  如果目录存在, 但不可写执行, 则尝试修复目录权限, 并设置目录权限为 700 安全的私有目录
  如果目录存在, 但不可写执行, 且修复目录权限失败, 则抛出错误
*/
export function resolvePreferredOpenClawTmpDir(
  options: ResolvePreferredOpenClawTmpDirOptions = {},
): string {
  // lyc: 用于测试当前进程是否有权限访问指定的文件或目录, 即是否有写fs.constants.W_OK和执行fs.constants.X_OK权限
  const accessSync = options.accessSync ?? fs.accessSync;
  const chmodSync = options.chmodSync ?? fs.chmodSync;
  /* lyc: 
    同步获取符号链接或文件系统路径的详细状态信息‌的方法, 
    返回fs.Stats对象: 
      isFile()‌：是否为普通文件
      isDirectory()‌：是否为目录
      ‌isSymbolicLink()‌：是否为符号链接（仅在 lstat 结果中有效）‌
    ‌  size‌：文件大小（字节）
      ‌mode‌：文件权限 是一个整数值，编码了文件的‌类型‌和‌访问权限‌。
      uid‌：文件所有者 UID
    */
  const lstatSync = options.lstatSync ?? fs.lstatSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const getuid =
    options.getuid ??
    (() => {
      try {
        // lyc: 启动该Node.js进程的那个用户的 UID
        return typeof process.getuid === "function" ? process.getuid() : undefined;
      } catch {
        return undefined;
      }
    });
  /* lyc:
    windows: C:\Users\<用户名>\AppData\Local\Temp
    linux|Docker: /tmp
    macOS: /var/folders/xx/xxxxxxxxxxxxx/T/
    */
  const tmpdir = options.tmpdir ?? os.tmpdir;
  const uid = getuid();
  // lyc: 检查目录对所有者是否是安全的私有目录, 即目录所有者是否为当前用户, 且其它用户不能写入目录
  const isSecureDirForUser = (st: { mode?: number; uid?: number }): boolean => {
    if (uid === undefined) {
      return true;
    }
    if (typeof st.uid === "number" && st.uid !== uid) {
      return false;
    }
    // Avoid group/other writable dirs when running on multi-user hosts.
    // lyc: 在多用户主机上运行时，应避免使用组/其他可写目录
    /* lyc: 用户是当前目录所有者但其它用户可以写入目录因此不是安全的私有目录所以返回false
      st.mode 表示目录权限, 可能的值为 0o700, 0o755, 0o770, 0o777 等
      例如0o755代表的权限为: 可能的权限十进制为读4写2执行1, 4+2+1=7代表可读写执行
        7代表所有者权限二进制为111, 代表rwx即可读写执行 
        5(第一个)代表组权限二进制为101, 代表r-x即可读取目录
        5(第二个)代表其他用户权限二进制为101, 代表r-x即可读取目录
        即: 755 = 111 101 101 = rwx r-x r-x = 所有者权限rwx 组权限r-x 其他用户权限r-x
      0o022 表示 000 010 010
      755 = 111 101 101 = rwx r-x r-x
            000 010 010 &
          ----------------
            000 000 000 === 0 目录的组权限和其他用户权限的w写权限为不可写
      766 = 111 110 110 = rwx rw- rw-
            000 010 010 &
          ----------------
            000 010 010 !== 0 目录的组权限和其他用户权限的w写权限为可写
    */
    if (typeof st.mode === "number" && (st.mode & 0o022) !== 0) {
      return false;
    }
    return true;
  };

  // lyc: 返回备用目录路径, 即 tmpdir() + "/openclaw" 或 tmpdir() + "/openclaw-" + uid
  const fallback = (): string => {
    const base = tmpdir();
    const suffix = uid === undefined ? "openclaw" : `openclaw-${uid}`;
    return path.join(base, suffix);
  };

  // lyc: 检查目录是否为受信任的临时目录, 即目录为目录, 且不是符号链接, 且目录所有者为当前用户, 且目录为安全的私有目录
  const isTrustedTmpDir = (st: {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode?: number;
    uid?: number;
  }): boolean => {
    return st.isDirectory() && !st.isSymbolicLink() && isSecureDirForUser(st);
  };

  /* lyc: 
    解析目录状态, 即检查目录是否存在, 是否为受信任的临时目录
    available代表目录存在且为受信任的临时目录, 可写执行, 
    missing代表目录不存在, 
    invalid代表不是目录 或 为符号链接 或 不是受信任的临时目录
    */
  const resolveDirState = (candidatePath: string): "available" | "missing" | "invalid" => {
    try {
      const candidate = lstatSync(candidatePath);
      if (!isTrustedTmpDir(candidate)) {
        return "invalid";
      }
      accessSync(candidatePath, TMP_DIR_ACCESS_MODE);
      return "available";
    } catch (err) {
      // lyc: 检查err.code是否为ENOENT错误, 即目录不存在
      if (isNodeErrorWithCode(err, "ENOENT")) {
        return "missing";
      }
      return "invalid";
    }
  };

  // lyc: 尝试修复目录权限使其变为受信任的临时目录, 即设置目录权限为 700 即安全的私有目录
  const tryRepairWritableBits = (candidatePath: string): boolean => {
    try {
      const st = lstatSync(candidatePath);
      // lyc: 如果不是目录 或 是符号链接, 则返回false
      if (!st.isDirectory() || st.isSymbolicLink()) {
        return false;
      }
      // lyc: 如果目录所有者不是当前用户, 则返回false
      if (uid !== undefined && typeof st.uid === "number" && st.uid !== uid) {
        return false;
      }
      // lyc: 是目录 & 目录所有者是当前用户 & 目录为安全的私有目录, 则返回false代表不需要修复目录
      if (typeof st.mode !== "number" || (st.mode & 0o022) === 0) {
        return false;
      }
      chmodSync(candidatePath, 0o700);
      warn(`[openclaw] tightened permissions on temp dir: ${candidatePath}`);
      return resolveDirState(candidatePath) === "available";
    } catch {
      return false;
    }
  };

  /* lyc: 创建备用目录(fallback)并使其变为受信任的临时目录
    备用目录存在且为受信任的临时目录则返回备用目录路径
    备用目录存在但不是受信任的临时目录则尝试修复目录权限, 并设置目录权限为 700
    备用目录不存在则创建备用目录, 并设置目录权限为 700 使其成为受信任的临时目录
    */
  const ensureTrustedFallbackDir = (): string => {
    const fallbackPath = fallback();
    const state = resolveDirState(fallbackPath);
    if (state === "available") {
      return fallbackPath;
    }
    if (state === "invalid") {
      if (tryRepairWritableBits(fallbackPath)) {
        return fallbackPath;
      }
      throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackPath}`);
    }
    try {
      mkdirSync(fallbackPath, { recursive: true, mode: 0o700 });
      chmodSync(fallbackPath, 0o700);
    } catch {
      throw new Error(`Unable to create fallback OpenClaw temp dir: ${fallbackPath}`);
    }
    if (resolveDirState(fallbackPath) !== "available" && !tryRepairWritableBits(fallbackPath)) {
      throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackPath}`);
    }
    return fallbackPath;
  };

  const existingPreferredState = resolveDirState(POSIX_OPENCLAW_TMP_DIR);
  if (existingPreferredState === "available") {
    return POSIX_OPENCLAW_TMP_DIR;
  }
  if (existingPreferredState === "invalid") {
    if (tryRepairWritableBits(POSIX_OPENCLAW_TMP_DIR)) {
      return POSIX_OPENCLAW_TMP_DIR;
    }
    return ensureTrustedFallbackDir();
  }

  // lyc: existingPreferredState === "missing", 则创建目录, 并设置目录权限为 700
  try {
    accessSync("/tmp", TMP_DIR_ACCESS_MODE);
    // Create with a safe default; subsequent callers expect it exists.
    mkdirSync(POSIX_OPENCLAW_TMP_DIR, { recursive: true, mode: 0o700 });
    chmodSync(POSIX_OPENCLAW_TMP_DIR, 0o700);
    if (
      resolveDirState(POSIX_OPENCLAW_TMP_DIR) !== "available" &&
      !tryRepairWritableBits(POSIX_OPENCLAW_TMP_DIR)
    ) {
      return ensureTrustedFallbackDir();
    }
    return POSIX_OPENCLAW_TMP_DIR;
  } catch {
    return ensureTrustedFallbackDir();
  }
}
