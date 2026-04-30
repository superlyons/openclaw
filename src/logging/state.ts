/* lyc:
原理解析：单例模式与模块缓存
这种行为是由 JavaScript/TypeScript 的模块系统（Module System）机制决定的。
1. 模块只执行一次
  当你第一次在任何地方（比如 a.ts）import 一个模块（./state.js）时：
  JavaScript 引擎会执行该模块文件中的代码。
  创建 loggingState 对象。
  将该对象存储在模块缓存中。
  当你第二次在其他地方（比如 b.ts）import 同一个路径的模块时：
  JavaScript 引擎不会重新执行文件代码。
  它直接从缓存中返回之前创建好的那个 loggingState 对象的引用（Reference）。
2. 共享引用
  因为 a.ts 和 b.ts 拿到的是内存中同一个对象的引用，所以：
  a.ts 修改了对象的属性 cachedLogger。
  b.ts 读取该属性时，看到的自然就是被 a.ts 修改后的最新值。
  这实际上实现了一个天然的全局单例（Singleton）模式。
需要注意的例外情况（什么时候值会丢失？）
  服务器重启 (Node.js)
  页面刷新 (浏览器)
  多进程/集群 (Node.js Cluster)
  循环依赖导致的奇怪行为: 虽然罕见
  构建工具的热更新 (HMR)
*/
export const loggingState = {
  // lyc: 可以是任何类型, 因为该属性被断言为 unknown（顶级类型）
  cachedLogger: null as unknown,
  cachedSettings: null as unknown,
  cachedConsoleSettings: null as unknown,
  overrideSettings: null as unknown,
  // lyc: as为类型断言, 当前属性值为null, 未来可以是string类型或null
  invalidEnvLogLevelValue: null as string | null,
  consolePatched: false,
  forceConsoleToStderr: false,
  consoleTimestampPrefix: false,
  consoleSubsystemFilter: null as string[] | null,
  resolvingConsoleSettings: false,
  streamErrorHandlersInstalled: false,
  rawConsole: null as {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
  } | null,
};
