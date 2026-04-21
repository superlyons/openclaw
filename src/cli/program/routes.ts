import { routedCommands, type RouteSpec } from "./route-specs.js";

export type { RouteSpec } from "./route-specs.js";

// lyc: 查找快速路径命令, 如果存在, 则返回路由执行类, 否则返回 null
export function findRoutedCommand(path: string[]): RouteSpec | null {
  for (const route of routedCommands) {
    if (route.match(path)) {
      return route;
    }
  }
  return null;
}
