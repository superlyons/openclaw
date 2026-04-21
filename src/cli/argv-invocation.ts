import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  hasHelpOrVersion,
  isRootHelpInvocation,
} from "./argv.js";

export type CliArgvInvocation = {
  argv: string[];
  commandPath: string[];
  primary: string | null;
  hasHelpOrVersion: boolean;
  isRootHelpInvocation: boolean;
};

// lyc: 解析调用信息, 通过命令行参数, 获得命令路径, 主命令, 是否有帮助或版本选项, 是否为根帮助调用
export function resolveCliArgvInvocation(argv: string[]): CliArgvInvocation {
  return {
    argv,
    // lyc: 获得命令路径, 例如: ["node", "openclaw", "run", "dev", "--profile", "1000"] -> ["run", "dev"]
    commandPath: getCommandPathWithRootOptions(argv, 2),
    // lyc: 获得主命令, 例如: ["node", "openclaw", "run", "dev", "--profile", "1000"] -> "run"  
    primary: getPrimaryCommand(argv),
    // lyc: 是否有帮助或版本选项
    hasHelpOrVersion: hasHelpOrVersion(argv),
    // lyc: 是否为根帮助调用
    isRootHelpInvocation: isRootHelpInvocation(argv),
  };
}
