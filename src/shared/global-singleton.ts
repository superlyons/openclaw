// Safe for process-local caches and registries that can tolerate helper-based
// resolution. Do not use this for live mutable state that must survive split
// runtime chunks; keep those on a direct globalThis[Symbol.for(...)] lookup.
// lyc: 对于能够容忍基于助手代码解析的过程本地缓存和注册表是安全的。不要将其用于必须跨运行时块存活的活动可变状态；这些状态应保留在直接的globalThis[Symbol.for(...)]查找中。
// lyc: 获得在globalThis中存储单例对象
// lyc: globalThis: 跨环境的全局对象统一访问, 浏览器中为window, Node.js中为global
// lyc: 如果key不存在, 则创建并存储在globalThis中
// lyc: 如果key存在, 则返回已存在的对象
export function resolveGlobalSingleton<T>(key: symbol, create: () => T): T {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  if (Object.prototype.hasOwnProperty.call(globalStore, key)) {
    return globalStore[key] as T;
  }
  const created = create();
  globalStore[key] = created;
  return created;
}

export function resolveGlobalMap<TKey, TValue>(key: symbol): Map<TKey, TValue> {
  return resolveGlobalSingleton(key, () => new Map<TKey, TValue>());
}
