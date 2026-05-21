import fs from "node:fs";
import path from "node:path";

/* lyc:
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
*/

function normalizePathCandidate(candidate: string | undefined, cwd: string): string | undefined {
  // lyc: 如果传入的路径是 undefined 或空字符串，直接返回 undefined
  if (!candidate) {
    return undefined;
  }
  /* lyc:
    // resolved = "/home/user/project/src/entry.js"
    // resolved = "/tmp/test.js" (已经是绝对路径)
    */

  const resolved = path.resolve(cwd, candidate);
  try {
    /* lyc:
      # 假设文件结构：
      # /app/src/entry.js (实际文件)
      # /app/bin/entry.js -> /app/src/entry.js (符号链接)
      # 返回 "/app/src/entry.js" (解析后的实际路径)
      */
    return fs.realpathSync.native(resolved);
  } catch {
    /* lyc:
      */
    return resolved;
  }
}

/* lyc: 主模块检查

*/
export function isMainModule({
  currentFile,
  /* lyc: 
    */
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
  wrapperEntryPairs = [],
}: IsMainModuleOptions): boolean {
  // lyc: 返回currentFile=src/entry.ts在cwd下的真实路径
  const normalizedCurrent = normalizePathCandidate(currentFile, cwd);
  /* lyc: 返回argv[1]=openclaw.mjs在cwd下的真实路径
  */
  const normalizedArgv1 = normalizePathCandidate(argv[1], cwd);

  if (normalizedCurrent && normalizedArgv1 && normalizedCurrent === normalizedArgv1) {
    return true;
  }

  // PM2 runs the script via an internal wrapper; `argv[1]` points at the wrapper.
  // PM2 exposes the actual script path in `pm_exec_path`.
  /* lyc:
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
