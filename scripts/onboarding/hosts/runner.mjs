// Running a host's own CLI (`claude plugin ...`, `codex plugin ...`) for one agent home: the child environment that points the CLI at that
// home and at nothing else, a timeout that always settles, a one-line failure reason, and a small pool so homes run side by side.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { neutralCwd } from "./neutral-cwd.mjs";

/** Removed from every host child: what makes a nested CLI think it is its parent session, the home variables, and every credential. */
const STRIP = [/^CLAUDECODE$/, /^CLAUDE_CODE_/, /^NODE_OPTIONS$/, /^CLAUDE_CONFIG_DIR$/, /^CODEX_HOME$/, /_API_KEY$/, /_AUTH_TOKEN$/, /^CODEX_ACCESS_TOKEN$/];

/**
 * The environment a host CLI runs with for `home`. Claude's default home (~/.claude) keeps CLAUDE_CONFIG_DIR unset: its ~/.claude.json lives
 * beside the directory, and setting the variable would move it inside.
 */
export function hostEnv(host, home, { base = process.env, homeDir = os.homedir() } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!STRIP.some((re) => re.test(k))) env[k] = v;
  if (host === "claude") {
    if (path.resolve(home) !== path.resolve(homeDir, ".claude")) env.CLAUDE_CONFIG_DIR = home;
  } else env.CODEX_HOME = home;
  return env;
}

/**
 * Run a command and collect its output, in `cwd` (default: a neutral directory, never the caller's; see neutral-cwd.mjs). Never rejects: a
 * command that cannot start resolves with exit 127 and the reason in stderr; one that runs past `timeoutMs` gets SIGTERM, then SIGKILL 2 s later, and resolves with timedOut.
 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function run(cmd, args, { env = process.env, timeoutMs = 60000, cwd = neutralCwd() } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killer = null;
    const done = (exitCode) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killer); resolve({ exitCode, stdout, stderr, timedOut }); };
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      stderr = `${cmd}: ${e.message}`;
      done(127);
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killer = setTimeout(() => { child.kill("SIGKILL"); done(null); }, 2000);
      killer.unref();
    }, timeoutMs);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (e) => { stderr += e.code === "ENOENT" ? `${cmd}: command not found` : `${cmd}: ${e.message}`; done(127); });
    child.on("close", (code) => done(code));
  });
}

/** stderr lines a host prints on success that are not a reason for anything. */
const NOISE = [/Refusing to create helper binaries under temporary dir/i];

const lastJsonLine = (text) => {
  const lines = String(text).trim().split("\n").map((l) => l.trim()).filter(Boolean);
  for (const l of [lines.at(-1), String(text).trim()]) {
    try { return JSON.parse(l); } catch { /* not JSON */ }
  }
  return null;
};

/** The parsed result of a host command: Claude prints one JSON line last, Codex a pretty-printed object. null when stdout holds none. */
export const resultJson = lastJsonLine;

/** How to install a host's CLI, and how to update it. */
const INSTALL = { claude: "curl -fsSL https://claude.ai/install.sh | bash", codex: "npm i -g @openai/codex" };
const UPDATE = { claude: "claude update", codex: "npm i -g @openai/codex" };

/**
 * Why a host command failed, in one line of at most 200 characters: the CLI is not installed (exit 127 or ENOENT: how to install it, then
 * `ifMissing`, what else the person can do), or the CLI does not know the command (how to update it).
 */
export function failureReason(result, host, ifMissing = "") {
  if (result.timedOut) return "timed out after 60 s";
  const json = lastJsonLine(result.stdout);
  const stderr = String(result.stderr).split("\n").map((l) => l.trim()).filter((l) => l && !NOISE.some((re) => re.test(l)));
  if (result.exitCode === 127 || /ENOENT/.test(stderr[0] ?? "")) return `${host} is not installed; install it (${INSTALL[host]})${ifMissing}`;
  let reason = (typeof json?.message === "string" && json.message.split("\n")[0]) || stderr[0] || `exited ${result.exitCode}`;
  reason = reason.replace(/^error:\s*/i, "").slice(0, 200);
  if (/unrecognized subcommand|unknown command|unexpected argument/i.test(reason)) reason += ` (update ${host}: ${UPDATE[host]})`;
  return reason;
}

/** Map `items` through `fn` with at most `limit` running at once; results keep the order of `items`. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
