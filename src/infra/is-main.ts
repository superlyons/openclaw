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

/* lyc: 主模块检查

*/
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
  // lyc: 返回currentFile=src/entry.ts在cwd下的真实路径
  const normalizedCurrent = normalizePathCandidate(currentFile, cwd);
  /* lyc: 返回argv[1]=openclaw.mjs在cwd下的真实路径
  设: argv[1]的值为 "openclaw.mjs"
    如果是run dev命令会执行 node scripts/run-node.mjs, 
    run-node.mjs中的runOpenClaw()函数内部会使用spawn执行node openclaw.mjs arg1 arg2 arg3
    openclaw.mjs会通过tryImport("./dist/entry.js")导入await import("./dist/entry.js")即src/entry.ts
    entry.ts内部会调用本函数检查是否为主模块, 因此argv[1]为"openclaw.mjs"
  */
  const normalizedArgv1 = normalizePathCandidate(argv[1], cwd);

  if (normalizedCurrent && normalizedArgv1 && normalizedCurrent === normalizedArgv1) {
    return true;
  }

  // PM2 runs the script via an internal wrapper; `argv[1]` points at the wrapper.
  // PM2 exposes the actual script path in `pm_exec_path`.
  /* lyc:
  PM2 运行脚本时，会通过内部包装器运行脚本；`argv[1]` 指向包装器。
  PM2 在 `pm_exec_path` 中暴露了实际的脚本路径。
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
  // lyc: 对于导入真实入口的包装器启动器(wrapperEntryPairs入参)，存在可选的包装器->入口映射。
  if (normalizedCurrent && normalizedArgv1 && wrapperEntryPairs.length > 0) {
    // lyc: path.basename() 返回路径的文件名部分，不包含目录名, 例如: entry.ts, openclaw.mjs
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
