#!/usr/bin/env node
import { spawn } from "node:child_process";
import { enableCompileCache } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isRootHelpInvocation, isRootVersionInvocation } from "./cli/argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import { shouldSkipRespawnForArgv } from "./cli/respawn-policy.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import { isTruthyEnvValue, normalizeEnv } from "./infra/env.js";
import { isMainModule } from "./infra/is-main.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

/* lyc:
这个文件是 OpenClaw 的入口点，它负责启动 OpenClaw 网关。
entry.ts (主入口)
    │
    ├─→ 检查是否是主模块？
    │   ├─→ 否：作为模块被导入，直接返回
    │   └─→ 是：作为主模块执行，继续以下流程
    │
    ├─→ 设置进程标题
    ├─→ 安装警告过滤器
    ├─→ 规范化环境变量
    ├─→ 启用编译缓存（可选）
    ├─→ 处理特殊参数（只读认证存储、颜色等）
    ├─→ 检查实验性警告（重要！）
    ├─→ 解析 CLI 参数
    ├─→ 处理快速路径（版本/帮助）
    └─→ 运行 CLI 主逻辑
*/

// lyc: 定义了包装器文件与实际入口文件的映射关系, openclaw.mjs 和 openclaw.js 是包装器，它们会导入 entry.js, 这样 isMainModule 可以正确识别主入口
const ENTRY_WRAPPER_PAIRS = [
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },
  { wrapperBasename: "openclaw.js", entryBasename: "entry.js" },
] as const;

/* lyc:
检查是否强制只读认证存储
检测是否执行 openclaw secrets audit 命令
# 运行: openclaw secrets audit
# argv = ["node", "openclaw.mjs", "secrets", "audit"]
# tokens = ["secrets", "audit"]
# 返回 true，设置只读模式
*/
function shouldForceReadOnlyAuthStore(argv: string[]): boolean {
  const tokens = argv.slice(2).filter((token) => token.length > 0 && !token.startsWith("-"));
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "secrets" && tokens[index + 1] === "audit") {
      return true;
    }
  }
  return false;
}

// Guard: only run entry-point logic when this file is the main module.
// The bundler may import entry.js as a shared dependency when dist/index.js
// is the actual entry point; without this guard the top-level code below
// would call runCli a second time, starting a duplicate gateway that fails
// on the lock / port and crashes the process.
/* lyc: isMainModule检查
- 防止重复执行：打包工具可能将 entry.js 作为依赖导入
- 避免端口冲突：如果启动两次 gateway 会冲突
- 确保单例：程序只有一个入口点
*/
if (
  !isMainModule({
    // lyc: import.meta.url = "file:///C:/path/to/entry.js"
    // lyc: fileURLToPath(import.meta.url) = "C:/path/to/entry.js"
    currentFile: fileURLToPath(import.meta.url),
    wrapperEntryPairs: [...ENTRY_WRAPPER_PAIRS],
  })
) {
  // lyc: 当前是作为模块被导入的
  /* lyc:
    # 某个文件中: import { someFunction } from './entry.js'
    # isMainModule 返回 false
    # 不执行 else 块中的代码
    */
  // Imported as a dependency — skip all entry-point side effects.
} else {
  // lyc: 当前是作为主模块被执行的
  /* lyc:
    # 运行: node openclaw.mjs
    # isMainModule 返回 true
    # 执行 else 块中的所有入口逻辑
    */
  // lyc: 设置进程标题
  process.title = "openclaw";
  // lyc: 安装进程警告过滤器
  installProcessWarningFilter();
  // lyc: 标准化环境变量
  normalizeEnv();
  // lyc: 启用编译缓存（性能优化）
  if (!isTruthyEnvValue(process.env.NODE_DISABLE_COMPILE_CACHE)) {
    try {
      // lyc: Node.js 22+ 的特性, 缓存编译后的代码，加快启动速度, 如果失败不影响程序运行（catch 块）
      enableCompileCache();
    } catch {
      // Best-effort only; never block startup.
      // lyc: 仅尽最大努力；绝不阻碍启动。
    }
  }
  // lyc: 处理特殊环境变量
  // lyc: secrets audit 命令设置只读模式
  if (shouldForceReadOnlyAuthStore(process.argv)) {
    process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
  }
  // lyc: - --no-color 禁用彩色输出
  if (process.argv.includes("--no-color")) {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
  }

  // lyc: 实验性警告处理（重要！）
  const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

  // lyc: 检查是否禁用了实验性警告
  function hasExperimentalWarningSuppressed(): boolean {
    /* lyc:
    process.env 是 Node.js 的环境变量对象
    例如: NODE_ENV=production node app.js -> process.env.NODE_ENV = "production"
    NODE_OPTIONS 是一个特殊的环境变量，用于向 Node.js 传递启动参数
    例如：NODE_OPTIONS="--max-old-space-size=4096" node app.js
    ?? 空值合并运算符
    只有当左侧的值为 null 或 undefined 时，才会返回右侧的值
    与 || 的区别：|| 会在左侧为假值（false、0、''、null、undefined、NaN）时返回右侧
    相当于: process.env.NODE_OPTIONS !== null && process.env.NODE_OPTIONS !== undefined
      */
    const nodeOptions = process.env.NODE_OPTIONS ?? "";
    if (nodeOptions.includes(EXPERIMENTAL_WARNING_FLAG) || nodeOptions.includes("--no-warnings")) {
      return true;
    }
    /* lyc:
      execArgv 代表专门用来配置 Node.js 运行环境的“开关”，
      argv 是传给咱们自己写的代码的“数据”
      例子: node --inspect --max-old-space-size=2048 app.js --port=3000 --production
      execArgv = ["--inspect", "--max-old-space-size=2048"]
      argv = [ '/usr/local/bin/node', '/path/to/app.js', '--port=3000', '--production' ]
      */
    for (const arg of process.execArgv) {
      if (arg === EXPERIMENTAL_WARNING_FLAG || arg === "--no-warnings") {
        return true;
      }
    }
    return false;
  }

  /* lyc:
    检查是否需要重新启动进程以禁用实验性警告, true表示已重新启动, false表示没重新启动
    */
  function ensureExperimentalWarningSuppressed(): boolean {
    // lyc: 检查是否应该跳过重新启动
    // lyc: 如果命令行包含帮助标志、版本标志或根版本别名(-v) 返回false  包含非执行标志，跳过重新启动
    if (shouldSkipRespawnForArgv(process.argv)) {
      return false;
    }
    // lyc: 检查环境变量OPENCLAW_NO_RESPAWN = true 返回false  参数明确指定不需要重新启动, 跳过重新启动
    if (isTruthyEnvValue(process.env.OPENCLAW_NO_RESPAWN)) {
      return false;
    }
    // lyc: 检查环境变量OPENCLAW_NODE_OPTIONS_READY = true 返回false 参数指定NODE_OPTIONS_READY为true，跳过重新启动
    if (isTruthyEnvValue(process.env.OPENCLAW_NODE_OPTIONS_READY)) {
      return false;
    }
    // lyc: 禁用了实验性警告 返回false  参数明确禁用实验性警告，跳过重新启动
    if (hasExperimentalWarningSuppressed()) {
      return false;
    }

    // Respawn guard (and keep recursion bounded if something goes wrong).
    // lyc: 防止递归重新启动
    process.env.OPENCLAW_NODE_OPTIONS_READY = "1";
    // Pass flag as a Node CLI option, not via NODE_OPTIONS (--disable-warning is disallowed in NODE_OPTIONS).
    /* lyc: 重新启动
    [ '/usr/local/bin/node', '--disable-warning=ExperimentalWarning', '--execArgvValues', '/path/to/app.js', '--port=3000', '--production' ]
    */
    const child = spawn(
      // lyc: 重新启动当前进程
      process.execPath, 
      // lyc: 添加 --disable-warning=ExperimentalWarning 参数
      [EXPERIMENTAL_WARNING_FLAG, ...process.execArgv, ...process.argv.slice(1)], 
      {
        // lyc: 继承所有标准输入输出
        stdio: "inherit", 
        // lyc: 继承所有环境变量
        env: process.env, 
      },
    );

    // lyc: 附加子进程桥接
    attachChildProcessBridge(child); 

    child.once("exit", (code, signal) => {
      if (signal) {
        process.exitCode = 1;
        return;
      }
      process.exit(code ?? 1);
    });

    child.once("error", (error) => {
      console.error(
        "[openclaw] Failed to respawn CLI:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exit(1);
    });

    // Parent must not continue running the CLI.
    // lyc: 重新启动成功, 表示已经处理，父进程不需要继续运行可以退出
    return true; 
  }

  // lyc: 显示版本的快速路径, 如果命令行包含版本标志或根版本别名(-v) 输出版本信息并返回true
  function tryHandleRootVersionFastPath(argv: string[]): boolean {
    if (!isRootVersionInvocation(argv)) {
      return false;
    }
    import("./version.js")
      .then(({ VERSION }) => {
        console.log(VERSION);
      })
      .catch((error) => {
        console.error(
          "[openclaw] Failed to resolve version:",
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        process.exitCode = 1;
      });
    return true;
  }

  // lyc: 显示帮助的快速路径, 如果命令行包含帮助标志或根帮助别名(-h) 输出帮助信息并返回true  
  function tryHandleRootHelpFastPath(argv: string[]): boolean {
    if (!isRootHelpInvocation(argv)) {
      return false;
    }
    import("./cli/program.js")
      .then(({ buildProgram }) => {
        buildProgram().outputHelp();
      })
      .catch((error) => {
        console.error(
          "[openclaw] Failed to display help:",
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        process.exitCode = 1;
      });
    return true;
  }

  /* lyc:
    规范化 Windows 参数; 处理 Windows 平台的命令行参数解析问题
    - Windows 的命令行参数解析与 Unix 不同
    - 特殊字符、引号等处理方式不同
    - 需要规范化以保证跨平台一致性
    */
  process.argv = normalizeWindowsArgv(process.argv);

  if (!ensureExperimentalWarningSuppressed()) {
    // lyc: 已禁用了实验性警告或者明确指定不需要重新启动进程(返回false), 表示没重新启动进程以禁用实验性警告, 当前进程继续运行
    // lyc: 解析CLI Profile配置的参数; 解析命令行参数, 提取Profile名称(存入return.profile)和命令参数(存入return.argv)以及是否成功解析(return.ok)
    const parsed = parseCliProfileArgs(process.argv);
    if (!parsed.ok) {
      // Keep it simple; Commander will handle rich help/errors after we strip flags.
      console.error(`[openclaw] ${parsed.error}`);
      process.exit(2);
    }

    if (parsed.profile) {
      // lyc: 应用CLI Profile配置的环境变量
      applyCliProfileEnv({ profile: parsed.profile });
      // Keep Commander and ad-hoc argv checks consistent.
      process.argv = parsed.argv;
    }

    if (!tryHandleRootVersionFastPath(process.argv) && !tryHandleRootHelpFastPath(process.argv)) {
      import("./cli/run-main.js")
        .then(({ runCli }) => runCli(process.argv))
        .catch((error) => {
          console.error(
            "[openclaw] Failed to start CLI:",
            error instanceof Error ? (error.stack ?? error.message) : error,
          );
          process.exitCode = 1;
        });
    }
  }
}
