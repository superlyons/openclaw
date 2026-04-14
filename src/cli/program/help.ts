import type { Command } from "commander";
import { formatDocsLink } from "../../terminal/links.js";
import { isRich, theme } from "../../terminal/theme.js";
import { escapeRegExp } from "../../utils.js";
import { hasFlag, hasRootVersionAlias } from "../argv.js";
import { formatCliBannerLine, hasEmittedCliBanner } from "../banner.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { CLI_LOG_LEVEL_VALUES, parseCliLogLevelOption } from "../log-level-option.js";
import { getCoreCliCommandsWithSubcommands } from "./command-registry.js";
import type { ProgramContext } from "./context.js";
import { getSubCliCommandsWithSubcommands } from "./register.subclis.js";

const CLI_NAME = resolveCliName();
const CLI_NAME_PATTERN = escapeRegExp(CLI_NAME);
const ROOT_COMMANDS_WITH_SUBCOMMANDS = new Set([
  ...getCoreCliCommandsWithSubcommands(),
  ...getSubCliCommandsWithSubcommands(),
]);
const ROOT_COMMANDS_HINT =
  "Hint: commands suffixed with * have subcommands. Run <command> --help for details.";

const EXAMPLES = [
  ["openclaw models --help", "Show detailed help for the models command."],
  [
    "openclaw channels login --verbose",
    "Link personal WhatsApp Web and show QR + connection logs.",
  ],
  [
    'openclaw message send --target +15555550123 --message "Hi" --json',
    "Send via your web session and print JSON result.",
  ],
  ["openclaw gateway --port 18789", "Run the WebSocket Gateway locally."],
  ["openclaw --dev gateway", "Run a dev Gateway (isolated state/config) on ws://127.0.0.1:19001."],
  ["openclaw gateway --force", "Kill anything bound to the default gateway port, then start it."],
  ["openclaw gateway ...", "Gateway control via WebSocket."],
  [
    'openclaw agent --to +15555550123 --message "Run summary" --deliver',
    "Talk directly to the agent using the Gateway; optionally send the WhatsApp reply.",
  ],
  [
    'openclaw message send --channel telegram --target @mychat --message "Hi"',
    "Send via your Telegram bot.",
  ],
] as const;

export function configureProgramHelp(program: Command, ctx: ProgramContext) {
  program
    .name(CLI_NAME)
    .description("")
    .version(ctx.programVersion)
    .option(
      "--dev",
      "Dev profile: isolate state under ~/.openclaw-dev, default gateway port 19001, and shift derived ports (browser/canvas)",
    )
    .option(
      "--profile <name>",
      "Use a named profile (isolates OPENCLAW_STATE_DIR/OPENCLAW_CONFIG_PATH under ~/.openclaw-<name>)",
    )
    //lyc: parseCliLogLevelOption是一个函数时不代表默认值, 况且<level>是必填参数, 当输入命令:openclaw --log-level debug时, 会调用parseCliLogLevelOption("debug")它的返回值会存入program.logLevel和program.opts().logLevel
    .option(
      "--log-level <level>",
      `Global log level override for file + console (${CLI_LOG_LEVEL_VALUES})`,
      parseCliLogLevelOption,
    );

  program.option("--no-color", "Disable ANSI colors", false);
  // lyc: 定义选项形式的帮助触发器, 当用户输入 -h 或者 --help 时，请显示帮助
  program.helpOption("-h, --help", "Display help for command");
  // lyc: 定义命令形式的帮助触发器, 允许用户输入 openclaw help gateway 来查看 gateway 命令的帮助
  program.helpCommand("help [command]", "Display help for command");

  // lyc: 美化输出帮助信息
  program.configureHelp({
    // sort options and subcommands alphabetically
    // lyc: 按字母顺序排序子命令和选项
    sortSubcommands: true,
    sortOptions: true,
    optionTerm: (option) => theme.option(option.flags),
    subcommandTerm: (cmd) => {
      // lyc: 格式化子命令, 如果是根命令且有子命令, 则添加 * 后缀
      const isRootCommand = cmd.parent === program;
      const hasSubcommands = isRootCommand && ROOT_COMMANDS_WITH_SUBCOMMANDS.has(cmd.name());
      return theme.command(hasSubcommands ? `${cmd.name()} *` : cmd.name());
    },
  });

  const formatHelpOutput = (str: string) => {
    let output = str;
    const isRootHelp = new RegExp(
      `^Usage:\\s+${CLI_NAME_PATTERN}\\s+\\[options\\]\\s+\\[command\\]\\s*$`,
      "m",
    ).test(output);
    if (isRootHelp && /^Commands:/m.test(output)) {
      output = output.replace(/^Commands:/m, `Commands:\n  ${theme.muted(ROOT_COMMANDS_HINT)}`);
    }

    return output
      .replace(/^Usage:/gm, theme.heading("Usage:"))
      .replace(/^Options:/gm, theme.heading("Options:"))
      .replace(/^Commands:/gm, theme.heading("Commands:"));
  };

  // lyc: 接管 CLI 的输出流
  program.configureOutput({
    writeOut: (str) => {
      process.stdout.write(formatHelpOutput(str));
    },
    writeErr: (str) => {
      process.stderr.write(formatHelpOutput(str));
    },
    outputError: (str, write) => write(theme.error(str)),
  });

  if (
    hasFlag(process.argv, "-V") ||
    hasFlag(process.argv, "--version") ||
    hasRootVersionAlias(process.argv)
  ) {
    console.log(ctx.programVersion);
    process.exit(0);
  }

  // lyc: 在帮助信息的特定位置插入自定义的文本块
  // lyc: beforeAll在所有内容（包括 Usage, Options 等）之前 插入Logo Banner, 当你输入 --help 时, 会在最开始显示Logo Banner
  program.addHelpText("beforeAll", () => {
    if (hasEmittedCliBanner()) {
      return "";
    }
    const rich = isRich();
    const line = formatCliBannerLine(ctx.programVersion, { richTty: rich });
    return `\n${line}\n`;
  });

  const fmtExamples = EXAMPLES.map(
    ([cmd, desc]) => `  ${theme.command(replaceCliName(cmd, CLI_NAME))}\n    ${theme.muted(desc)}`,
  ).join("\n");

  // lyc: 在所有内容之后（通常在底部）插入自定义的文本块, 当你输入 --help 时, 会在最底部显示示例和文档链接
  program.addHelpText("afterAll", ({ command }) => {
    if (command !== program) {
      return "";
    }
    const docs = formatDocsLink("/cli", "docs.openclaw.ai/cli");
    return `\n${theme.heading("Examples:")}\n${fmtExamples}\n\n${theme.muted("Docs:")} ${docs}\n`;
  });
}
