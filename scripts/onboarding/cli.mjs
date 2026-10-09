// `recall setup`, `recall uninstall`, `recall pause`, `recall resume` and `recall doctor`: their options, and the exit codes (0 done or
// declined, 1 an expected failure or no answer on stdin, 2 a usage error, 130 Ctrl-C). The flags arrive parsed by recall.mjs.
import os from "node:os";
import { UsageError } from "../lib/usage-error.mjs";
import { diagnose } from "./diagnose.mjs";
import { help, PAUSE_HELP, RESUME_HELP, UNINSTALL_HELP } from "./help.mjs";
import { runPause } from "./pause.mjs";
import { ONE_LINER, pluginMeta } from "./plugin-meta.mjs";
import { createPrompter, Interrupted, NoAnswer } from "./prompt.mjs";
import { formatChecks } from "./report.mjs";
import { runSetup } from "./setup.mjs";
import { createUi } from "./ui.mjs";
import { runUninstall } from "./uninstall.mjs";

const ALLOWED = {
  doctor: ["json", "offline"],
  setup: ["yes", "homes", "exclude", "new-key", "no-index", "skip-key", "no-save-key", "daily-cap", "dry-run", "help"],
  uninstall: ["yes", "purge", "homes", "help"],
  pause: ["help"],
  resume: ["help"],
};

const hint = (cmd) => `(see: ${ONE_LINER} ${["uninstall", "pause", "resume"].includes(cmd) ? `${cmd} --help` : "--help"})`;
const VALUED = new Set(["homes", "exclude", "daily-cap"]);
const SHORT = { "-y": "yes", "-h": "help" };

/** Check the option names of a raw command line before its values are parsed, so `recall --frob` is an unknown option, not a missing value. */
export function checkArgv(cmd, argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) continue;
    const name = SHORT[a] ?? a.replace(/^--?/, "");
    if (!ALLOWED[cmd].includes(name)) throw new UsageError(`unknown option --${name} ${hint(cmd)}`);
    if (VALUED.has(name)) i++;
  }
}

function checkOptions(cmd, flags) {
  for (const name of flags.keys()) {
    if (name === "_") throw new UsageError(`unexpected argument ${JSON.stringify(flags.get("_"))}`);
    if (!ALLOWED[cmd].includes(name)) throw new UsageError(`unknown option --${name} ${hint(cmd)}`);
  }
}

/** The setup flags as setup reads them. */
function setupFlags(flags) {
  let dailyCap = null;
  if (flags.has("daily-cap")) {
    dailyCap = Number(flags.get("daily-cap"));
    if (!(dailyCap > 0) || !Number.isFinite(dailyCap)) throw new UsageError(`--daily-cap must be a positive number of dollars, got ${JSON.stringify(flags.get("daily-cap"))}`);
  }
  for (const other of ["skip-key", "no-save-key"]) {
    if (flags.has("new-key") && flags.has(other)) throw new UsageError(`--new-key saves the key you paste to ~/.env; it does not go with --${other}`);
  }
  return {
    yes: flags.has("yes"),
    homes: flags.get("homes") ?? null,
    exclude: flags.get("exclude") ?? null,
    noIndex: flags.has("no-index") || flags.has("skip-key"),
    skipKey: flags.has("skip-key"),
    noSaveKey: flags.has("no-save-key"),
    newKey: flags.has("new-key"),
    dryRun: flags.has("dry-run"),
    dailyCap,
  };
}

/**
 * @param {"setup"|"uninstall"|"pause"|"resume"|"doctor"} cmd
 * @param {Map<string, string|true>} flags
 * @param {{env?: object, homeDir?: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} [io] where to look and talk (tests)
 * @returns {Promise<number>} the process exit code
 */
export async function runOnboarding(cmd, flags, { env = process.env, homeDir = os.homedir(), input = process.stdin, output = process.stdout } = {}) {
  checkOptions(cmd, flags);
  const print = (s) => output.write(`${s}\n`);
  if (cmd === "doctor") {
    const { checks, failed } = await diagnose({ env, homeDir, offline: flags.has("offline") });
    print(flags.has("json") ? JSON.stringify({ checks, failed }, null, 2) : formatChecks(checks, { glyph: createUi({ stream: output, env, homeDir }).glyph }));
    return failed ? 1 : 0;
  }
  if (flags.has("help")) { print({ setup: help(pluginMeta().version), uninstall: UNINSTALL_HELP, pause: PAUSE_HELP, resume: RESUME_HELP }[cmd]); return 0; }
  const ui = createUi({ stream: output, env, homeDir });
  if (cmd === "pause" || cmd === "resume") return runPause(cmd, { env, homeDir, ui });
  const prompter = createPrompter({ yes: flags.has("yes"), input, output });
  try {
    if (cmd === "uninstall") return await runUninstall({ flags: { yes: flags.has("yes"), purge: flags.has("purge"), homes: flags.get("homes") ?? null }, env, homeDir, prompter, ui });
    return await runSetup({ flags: setupFlags(flags), env, homeDir, prompter, ui });
  } catch (e) {
    if (e instanceof NoAnswer) {
      ui.say(flags.has("yes") ? "No answer on stdin, so nothing was changed." : "No answer on stdin, so nothing was changed. To run without questions, add --yes.");
      return 1;
    }
    if (e instanceof Interrupted) { ui.say("Stopped. Nothing was changed."); return 130; }
    throw e;
  } finally {
    prompter.close();
  }
}
