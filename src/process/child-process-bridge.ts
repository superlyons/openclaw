import type { ChildProcess } from "node:child_process";
import process from "node:process";

export type ChildProcessBridgeOptions = {
  /* lyc:
   ?:是typescript的类型注解, 表示可选属性, 标记属性可以存在，也可以不存在; 当属性不存在时，其值为 undefined; 使用该属性的代码需要进行存在性检查
   */
  signals?: NodeJS.Signals[];
  onSignal?: (signal: NodeJS.Signals) => void;
};

const defaultSignals: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGTERM", "SIGINT", "SIGBREAK"]
    : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];

/* lyc:ai
附加子进程桥接函数
此函数在父进程和子进程之间建立信号传递桥接，确保当父进程收到系统信号（如SIGINT、SIGTERM等）时，
能够将这些信号转发给子进程，实现优雅的进程终止。
不同平台支持的信号类型不同：Windows支持SIGTERM、SIGINT、SIGBREAK；Unix-like系统额外支持SIGHUP、SIGQUIT。
返回一个包含detach方法的对象，用于清理事件监听器。
*/
export function attachChildProcessBridge(
  child: ChildProcess,
  { signals = defaultSignals, onSignal }: ChildProcessBridgeOptions = {},
): { detach: () => void } {
  // lyc:ai 创建信号监听器映射表，用于跟踪已注册的信号处理器
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    // lyc:ai 为每个信号创建监听器函数
    const listener = (): void => {
      // lyc:ai 调用可选的onSignal回调函数
      onSignal?.(signal);
      try {
        // lyc:ai 向子进程发送相同的信号
        child.kill(signal);
      } catch {
        // ignore
        // lyc:ai 忽略kill操作可能的错误（如子进程已退出）
      }
    };
    try {
      // lyc:ai 在父进程上注册信号监听器
      process.on(signal, listener);
      listeners.set(signal, listener);
    } catch {
      // Unsupported signal on this platform.
      // lyc:ai 某些信号在特定平台上可能不支持，忽略此类错误
    }
  }

  // lyc:ai 创建detach函数，用于移除所有信号监听器
  const detach = (): void => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
  };

  // lyc:ai 当子进程退出或发生错误时，自动清理信号监听器
  child.once("exit", detach);
  child.once("error", detach);

  // lyc:ai 返回包含detach方法的对象，允许手动清理
  return { detach };
}
