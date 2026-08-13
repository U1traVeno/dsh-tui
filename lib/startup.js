import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

/**
 * The terminal app's command-line provider: parses `--resume`, `--model`,
 * `--list`, and `--help`, then publishes {@link TUI_STARTUP_SERVICE}. The
 * front door is an ordinary consumer whose activation waits for that service
 * (mirrors `@deepseek-ai/dsh-headless/startup`).
 * @module dsh-tui/startup
 */

/** Stable Cordis plugin name. */
export const name = "tui-startup";
/** Services required before the app options can be resolved. */
export const inject = ["cmdlineArgs"];
/** Service provided by this plugin and injected by the front door. */
export const TUI_STARTUP_SERVICE = "tuiStartup";

/**
 * This app's command: the terminal flags, their descriptions, and help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
export function tuiCommand() {
  return new Command()
    .name("dsh --profile tui")
    .description("Interactive terminal chat over a DeepSeek Harness agent.")
    .helpOption("-h, --help", "show this help")
    .option("--resume <sessionId>", "resume an existing persisted session")
    .option("--model <provider/model>", "override the default model selection, e.g. deepseek-official/deepseek-v4-flash")
    .option("--list", "list persisted sessions and exit")
    .addHelpText("after", `
Examples:
  dsh --profile tui                          start a fresh session
  dsh --profile tui --resume session-...     continue an existing session
  dsh --profile tui --list                   list persisted sessions
`);
}

/**
 * Parse and provide the terminal app options as an ordinary Cordis service.
 * On rejection (and on `--help`) nothing is provided, so the front door row
 * never activates and the process exits through the launcher.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx) {
  const program = tuiCommand();
  program.action(() => {
    const opts = program.opts();
    ctx.provide(TUI_STARTUP_SERVICE, {
      resume: opts.resume,
      model: opts.model,
      list: opts.list ?? false,
    });
  });
  parseCmdline(ctx, program);
}
