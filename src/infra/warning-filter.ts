import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const warningFilterKey = Symbol.for("openclaw.warning-filter");

export type ProcessWarning = {
  code?: string;
  name?: string;
  message?: string;
};

type ProcessWarningInstallState = {
  installed: boolean;
};

// lyc: 判断是否应该忽略警告, Node.js内部的警告,实验性的警告, 与 punycode 相关的警告, 不需要显示给用户
export function shouldIgnoreWarning(warning: ProcessWarning): boolean {
  if (warning.code === "DEP0040" && warning.message?.includes("punycode")) {
    return true;
  }
  if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) {
    return true;
  }
  if (
    warning.name === "ExperimentalWarning" &&
    warning.message?.includes("SQLite is an experimental feature")
  ) {
    return true;
  }
  return false;
}

// lyc: 标准化警告参数, 确保所有警告都符合统一的格式{ name, code, message }
function normalizeWarningArgs(args: unknown[]): ProcessWarning {
  const warningArg = args[0];
  const secondArg = args[1];
  const thirdArg = args[2];
  let name: string | undefined;
  let code: string | undefined;
  let message: string | undefined;

  if (warningArg instanceof Error) {
    name = warningArg.name;
    message = warningArg.message;
    code = (warningArg as Error & { code?: string }).code;
  } else if (typeof warningArg === "string") {
    message = warningArg;
  }

  if (secondArg && typeof secondArg === "object" && !Array.isArray(secondArg)) {
    const options = secondArg as { type?: unknown; code?: unknown };
    if (typeof options.type === "string") {
      name = options.type;
    }
    if (typeof options.code === "string") {
      code = options.code;
    }
  } else {
    if (typeof secondArg === "string") {
      name = secondArg;
    }
    if (typeof thirdArg === "string") {
      code = thirdArg;
    }
  }

  return { name, code, message };
}

// lyc: 安装警告过滤器
export function installProcessWarningFilter(): void {
  // lyc: 获得在globalThis中存储的警告过滤器状态
  const state = resolveGlobalSingleton<ProcessWarningInstallState>(warningFilterKey, () => ({
    installed: false,
  }));
  if (state.installed) {
    return;
  }

  // lyc: 如果没有安装过警告过滤器, 才执行以下代码, 包装 Node.js 的 process.emitWarning 方法，创建了一个自定义的警告处理逻辑

  /* lyc: 保存原始的 process.emitWarning 方法, 使用 .bind(process) 确保调用时的 this 指向正确的 process 对象
    原始的process.emitWarning方法会执行以下步骤：
      执行警告过滤（如 --no-warnings 标志）
      格式化警告消息
      检查是否重复警告
      发出警告到控制台
      触发 'warning' 事件监听器 process.emit("warning", ...)
  */
  const originalEmitWarning = process.emitWarning.bind(process);
  /* lyc: 定义一个新的函数来替代原始的 emitWarning
    as typeof process.emitWarning : 类型注解确保新函数具有与原函数相同的类型
  */
  const wrappedEmitWarning: typeof process.emitWarning = ((...args: unknown[]) => {
    // lyc: 是否应该忽略警告, 如果是, 则直接返回
    if (shouldIgnoreWarning(normalizeWarningArgs(args))) {
      return;
    }
    // lyc: 当第一个参数是 Error 对象且第二个参数是Object时 只触发 'warning' 事件监听器，但不在控制台显示警告
    if (
      args[0] instanceof Error &&
      args[1] &&
      typeof args[1] === "object" &&
      !Array.isArray(args[1])
    ) {
      const warning = args[0];
      // lyc: emitted=创建一个新的 Error 对象，复制原始警告(warning或args[0])的 message、name 和 code
      const emitted = Object.assign(new Error(warning.message), {
        name: warning.name,
        code: (warning as Error & { code?: string }).code,
      });
      // lyc: 直接触发 process.emit("warning", emitted) 事件监听器而不是使用原始的 emitWarning, 
      // lyc: 这样可以绕过某些警告过滤机制也不会发出警告到控制台
      process.emit("warning", emitted);
      return;
    }
    // lyc: 其他情况, 直接调用原始的 emitWarning 方法
    Reflect.apply(originalEmitWarning, process, args);
    return;
  }) as typeof process.emitWarning;

  process.emitWarning = wrappedEmitWarning;
  state.installed = true;
}
