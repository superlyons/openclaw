/**
 * Strict plain-object guard (excludes arrays and host objects).
 */
// lyc: 检查值是否为纯对象(排除数组和宿主对象), 基础类型(int, string, boolean等)不是纯对象
// lyc: 纯对象（Plain Object）: 通过字面量 {} 或 new Object() 创建的对象
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}
