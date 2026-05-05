import { clearActiveProgressLine } from "./progress-line.js";

const RESET_SEQUENCE =
  "\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[>4;0m";

type RestoreTerminalStateOptions = {
  /**
   * Resumes paused stdin after restoring terminal mode.
   * Keep this off when the process should exit immediately after cleanup.
   *
   * Default: false (safer for "cleanup then exit" call sites).
   */
  resumeStdin?: boolean;

  /**
   * Alias for resumeStdin. Prefer this name to make the behavior explicit.
   *
   * Default: false.
   */
  resumeStdinIfPaused?: boolean;
};

// lyc: 报告恢复终端状态失败, [终端] 恢复 ${scope范围} 失败(${reason原因}): ${error错误信息}, 例如: [终端] 恢复 progress line(进度条行) 失败(runtime exit): Error: EPIPE
function reportRestoreFailure(scope: string, err: unknown, reason?: string): void {
  const suffix = reason ? ` (${reason})` : "";
  const message = `[terminal] restore ${scope} failed${suffix}: ${String(err)}`;
  try {
    process.stderr.write(`${message}\n`);
  } catch (writeErr) {
    console.error(`[terminal] restore reporting failed${suffix}: ${String(writeErr)}`);
  }
}

/* lyc: 恢复终端状态, 清除进度条行, 恢复原始模式, 恢复 stdin, 重置 stdout 序列 
当 OpenClaw 运行 CLI 向导、进度条、交互式界面时，它会改掉终端的正常行为。如果不改回来，程序退出后你的终端就"坏"了——键盘按了没反应、光标消失、颜色错乱。
这个函数就是在程序退出前，把终端恢复到最初"干净"的状态。
入参:
reason: 恢复终端状态的原因, 例如: runtime exit, cleanup then exit; 它不参与任何逻辑，只是出 bug 时方便你查日志："哦，是因为 runtime exit 才出错的"。
options: 恢复终端状态的选项, 例如: resumeStdin: true, resumeStdinIfPaused: true
*/
export function restoreTerminalState(
  reason?: string,
  options: RestoreTerminalStateOptions = {},
): void {
  // Docker TTY note: resuming stdin can keep a container process alive even
  // after the wizard is "done" (stdin_open: true), making installers appear hung.
  // lyc: Docker TTY 注意事项：即使在向导“完成”后（stdin_open: true），恢复 stdin 也可以使容器进程保持活动状态，从而使安装程序看起来处于挂起状态。
  // lyc: 是否恢复stdin, 如果在 Docker TTY 中恢复 stdin，可能导致容器进程无法正常退出（因为 stdin 还在等待输入）。所以默认不恢复 stdin
  const resumeStdin = options.resumeStdinIfPaused ?? options.resumeStdin ?? false;
  try {
    clearActiveProgressLine();
  } catch (err) {
    reportRestoreFailure("progress line", err, reason);
  }

  const stdin = process.stdin;
  // lyc: 如果stdin(标准输入)是TTY(终端) & 支持设置原始模式(setRawMode)
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    try {
      // lyc: 关闭raw mode原始模式, 恢复正常模式, 正常终端:输入 ls ，按下回车，整行才发给程序。raw mode下程序能立刻捕获你按下的 每一个键 ，包括 Ctrl+C、方向键、Tab 等
      stdin.setRawMode(false);
    } catch (err) {
      reportRestoreFailure("raw mode", err, reason);
    }
    // lyc: 如果允许恢复stdin & isPaused是函数 & 之前调用过pause()暂停了键盘输入
    // lyc: 默认resumeStdin为false, 因为在docker容器里如果你恢复了stdin，容器进程会认为"还有人在输入"，就一直等，退出不了，看起来像卡住了。
    if (resumeStdin && typeof stdin.isPaused === "function" && stdin.isPaused()) {
      try {
        // lyc: 恢复stdin的键盘输入 让用户可以继续输入
        stdin.resume();
      } catch (err) {
        reportRestoreFailure("stdin resume", err, reason);
      }
    }
  }
  // lyc: 如果stdout(标准输出)是TTY(终端)
  if (process.stdout.isTTY) {
    try {
      // lyc: 恢复终端: 颜色关了、光标显示了、鼠标关了、粘贴模式关了——终端回到最普通的状态
      process.stdout.write(RESET_SEQUENCE);
    } catch (err) {
      reportRestoreFailure("stdout reset", err, reason);
    }
  }
}
