// Which agent tools this machine has: Node, the claude and codex CLIs (version, and whether each is logged in) and Every Code (~/.code).
// Read-only: each CLI is asked `--version` and its own login status, nothing else.
import os from "node:os";
import path from "node:path";
import { cliLogin } from "../lib/cli-login.mjs";
import { isDir, resolveHome } from "../lib/home-paths.mjs";
import { cliVersion } from "./probes.mjs";

export const MIN_NODE = [22, 15];

export function nodeOk(version) {
  const [maj, min] = String(version).replace(/^v/, "").split(".").map(Number);
  return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
}

/** The first x.y.z in a `--version` line ("2.1.287 (Claude Code)" -> "2.1.287"), else the line. */
export const shortVersion = (line) => /\d+\.\d+\.\d+/.exec(String(line ?? ""))?.[0] ?? (line || null);

/** The home a card writer of this kind runs under: $CLAUDE_CONFIG_DIR or ~/.claude, $CODEX_HOME or ~/.codex. */
export function writerHome(kind, { env, homeDir }) {
  const v = kind === "claude" ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME;
  return v ? resolveHome(v, homeDir) : path.join(homeDir, kind === "claude" ? ".claude" : ".codex");
}

/**
 * @param {{env?: object, homeDir?: string, run: Function, version?: typeof cliVersion}} o
 * @returns {Promise<{claude: {found: boolean, version?: string, login?: string}, codex: object, everyCode: boolean,
 *   writer: "claude"|"codex"|null, stop: null|"no-tool"|"no-login"}>}
 */
export async function detectTools({ env = process.env, homeDir = os.homedir(), run, version = cliVersion }) {
  const tools = {};
  await Promise.all(["claude", "codex"].map(async (kind) => {
    const v = version(kind, { env });
    if (!v.found) { tools[kind] = { found: false }; return; }
    const login = await cliLogin(kind, { home: writerHome(kind, { env, homeDir }), env, run });
    tools[kind] = { found: true, version: shortVersion(v.version), login };
  }));
  const usable = (t) => t.found && t.login !== "logged-out";
  const writer = usable(tools.claude) ? "claude" : usable(tools.codex) ? "codex" : null;
  const stop = !tools.claude.found && !tools.codex.found ? "no-tool" : writer ? null : "no-login";
  return { claude: tools.claude, codex: tools.codex, everyCode: isDir(path.join(homeDir, ".code")), writer, stop };
}
