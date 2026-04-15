import fs from "node:fs";
import path from "node:path";

/* lyc:
这个文件用于判断 当前模块是否是主模块 （入口文件），这对于避免重复执行、控制程序流程非常重要。
*/

type IsMainModuleOptions = {
  currentFile: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  wrapperEntryPairs?: Array<{
    wrapperBasename: string;
    entryBasename: string;
  }>;
};
/* lyc:
将路径字符串标准化为 绝对路径 ，并解析符号链接。
*/
function normalizePathCandidate(candidate: string | undefined, cwd: string): string | undefined {
  // lyc: 如果传入的路径是 undefined 或空字符串，直接返回 undefined
  if (!candidate) {
    return undefined;
  }
  /* lyc:
    cwd = "/home/user/project"
    candidate = "src/entry.js"
    // resolved = "/home/user/project/src/entry.js"
    candidate = "/tmp/test.js"
    // resolved = "/tmp/test.js" (已经是绝对路径)
    */
  const resolved = path.resolve(cwd, candidate);
  try {
    /* lyc:
      尝试获取 resolved 路径的 真实路径 （解析符号链接）。
      如果成功，返回真实路径；如果失败（例如路径不存在），返回原始路径。
      # 假设文件结构：
      # /app/src/entry.js (实际文件)
      # /app/bin/entry.js -> /app/src/entry.js (符号链接)
      fs.realpathSync.native("/app/bin/entry.js")
      # 返回 "/app/src/entry.js" (解析后的实际路径)
      */
    return fs.realpathSync.native(resolved);
  } catch {
    /* lyc:
      为什么需要 try-catch？
      - 在某些系统或权限不足时， realpathSync.native() 可能抛出异常
      - 如果解析失败，返回未解析的绝对路径（降级处理）
      */
    return resolved;
  }
}

export function isMainModule({
  currentFile,
  /* lyc: 
    运行: node openclaw.mjs hello world
    process.argv =["node", "C:/path/to/openclaw.mjs", "hello", "world"]
    */
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
  wrapperEntryPairs = [],
}: IsMainModuleOptions): boolean {
  const normalizedCurrent = normalizePathCandidate(currentFile, cwd);
  const normalizedArgv1 = normalizePathCandidate(argv[1], cwd);

  if (normalizedCurrent && normalizedArgv1 && normalizedCurrent === normalizedArgv1) {
    return true;
  }

  // PM2 runs the script via an internal wrapper; `argv[1]` points at the wrapper.
  // PM2 exposes the actual script path in `pm_exec_path`.
  /* lyc:
  PM2 运行脚本时，会通过内部包装器运行脚本；`argv[1]` 指向包装器。
  PM2 会将实际脚本路径暴露在 `pm_exec_path` 环境变量中。
  PM2 是 Node.js 进程管理工具，它会通过包装器运行脚本。
  命令实例: pm2 start src/entry.js
  # argv[1] = "/app/node_modules/pm2/lib/ProcessHandler.js" (包装器)
  # env.pm_exec_path = "/app/src/entry.js" (实际脚本)
  */
  const normalizedPmExecPath = normalizePathCandidate(env.pm_exec_path, cwd);
  if (normalizedCurrent && normalizedPmExecPath && normalizedCurrent === normalizedPmExecPath) {
    return true;
  }

  // Optional wrapper->entry mapping for wrapper launchers that import the real entry.
  if (normalizedCurrent && normalizedArgv1 && wrapperEntryPairs.length > 0) {
    const currentBase = path.basename(normalizedCurrent);
    const argvBase = path.basename(normalizedArgv1);
    const matched = wrapperEntryPairs.some(
      ({ wrapperBasename, entryBasename }) =>
        currentBase === entryBasename && argvBase === wrapperBasename,
    );
    if (matched) {
      return true;
    }
  }

  return false;
}
