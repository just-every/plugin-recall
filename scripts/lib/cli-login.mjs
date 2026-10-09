// Is the claude or codex CLI logged in? Read from each CLI's own status command, for the home a card writer would run under; nothing here
// opens a credential file. "unknown" (an old CLI, a crash, a timeout) counts as usable: only a clear "logged out" stops anything.
import { workerEnv } from "./cli-worker.mjs";

/**
 * @param {"claude"|"codex"} kind
 * @param {{home: string, env?: object, run: (cmd: string, args: string[], o: {env: object, timeoutMs: number}) => Promise<{exitCode: number|null, stdout: string, stderr: string}>}} o
 * @returns {Promise<"logged-in"|"logged-out"|"unknown">}
 */
export async function cliLogin(kind, { home, env = process.env, run }) {
  const probeEnv = workerEnv(env, kind, home, {}, { explicit: false });
  if (kind === "claude") {
    const r = await run("claude", ["auth", "status", "--json"], { env: probeEnv, timeoutMs: 15000 });
    try {
      const status = JSON.parse(r.stdout);
      if (typeof status?.loggedIn === "boolean") return status.loggedIn ? "logged-in" : "logged-out";
    } catch { /* not the JSON status: an older CLI */ }
    return "unknown";
  }
  const r = await run("codex", ["login", "status"], { env: probeEnv, timeoutMs: 15000 });
  if (r.exitCode === 0) return "logged-in";
  if (/Not logged in/i.test(`${r.stdout}\n${r.stderr}`)) return "logged-out";
  return "unknown";
}
