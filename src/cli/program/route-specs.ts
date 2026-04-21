import { hasFlag } from "../argv.js";
import { cliCommandCatalog, type CliCommandCatalogEntry } from "../command-catalog.js";
import { matchesCommandPath } from "../command-path-matches.js";
import { resolveCliCommandPathPolicy } from "../command-path-policy.js";
import {
  routedCommandDefinitions,
  type AnyRoutedCommandDefinition,
} from "./routed-command-definitions.js";

export type RouteSpec = {
  match: (path: string[]) => boolean;
  loadPlugins?: boolean | ((argv: string[]) => boolean);
  run: (argv: string[]) => Promise<boolean>;
};

function createCommandLoadPlugins(commandPath: readonly string[]): (argv: string[]) => boolean {
  return (argv) => {
    const loadPlugins = resolveCliCommandPathPolicy([...commandPath]).loadPlugins;
    return loadPlugins === "always" || (loadPlugins === "text-only" && !hasFlag(argv, "--json"));
  };
}

function createParsedRoute(params: {
  entry: CliCommandCatalogEntry;
  definition: AnyRoutedCommandDefinition;
}): RouteSpec {
  return {
    match: (path) =>
      matchesCommandPath(path, params.entry.commandPath, { exact: params.entry.exact }),
    loadPlugins: params.entry.route?.preloadPlugins
      ? createCommandLoadPlugins(params.entry.commandPath)
      : undefined,
    run: async (argv) => {
      const args = params.definition.parseArgs(argv);
      if (!args) {
        return false;
      }
      await params.definition.runParsedArgs(args as never);
      return true;
    },
  };
}

// lyc: 从CLI命令目录(cliCommandCatalog)中筛选出符合路由条件的命令, 这些命令是快速路径命令, 可以直接执行
export const routedCommands: RouteSpec[] = cliCommandCatalog
  // lyc: entry是CliCommandCatalogEntry类型, 且有route属性, 且route属性的id值是routedCommandDefinitions变量的key或是CliRoutedCommandId类型的一个值
  .filter(
    (
      entry,
    ): entry is CliCommandCatalogEntry & { route: { id: keyof typeof routedCommandDefinitions | CliRoutedCommandId } } =>
      Boolean(entry.route),
  )
  // lyc: 创建统一的路由执行类: match, loadPlugins, run{routedCommandDefinition.runParsedArgs&parseArgs}
  .map((entry) =>
    createParsedRoute({
      entry,
      definition: routedCommandDefinitions[entry.route.id],
    }),
  );
