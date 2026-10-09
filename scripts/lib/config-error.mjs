// An invalid configuration (a bad environment value, or a bad/unknown/mistyped <dataDir>/config.json) makes the hook silent: one error-level
// line in the turn log (also on stderr, one short line, no stack) naming the problem, and the host's normal "continue" output. Never a crash.
import { resolveDataDir } from "./config.mjs";
import { readStdin } from "./hook-io.mjs";
import { createTurnLog } from "./turn-log.mjs";

export const isConfigError = (e) => e?.name === "ConfigError";

/** Drain the payload (so the host never writes into a closed pipe) and log the failure. `event` is "prompt". */
export async function logConfigFailure(event, error, { env = process.env, now } = {}) {
  if (!env.CODE_HOOK_PAYLOAD) { try { await readStdin(); } catch { /* the host's pipe is its own business */ } }
  try {
    createTurnLog(resolveDataDir(env), now ? { now } : {}).write({ event, level: "error", outcome: "silent", reason: "config-invalid", error: `${error.name}: ${error.message}` });
  } catch (e) {
    process.stderr.write(`[recall ERROR] ${event} config-invalid: ${error.message} (and the turn log could not be written: ${e.message})\n`);
  }
}
