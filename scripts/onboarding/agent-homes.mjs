// The agent homes setup can install into: one row per host, read from the home folder and the host's environment variable. A host whose
// CLI is not on PATH has no installable homes (its history is still read by the indexer's default homes). Every Code has no plugin system,
// so it is never one of these.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHome } from "../lib/home-paths.mjs";
import { listTranscripts } from "../lib/transcripts/files.mjs";
import { tildePath } from "./ui.mjs";

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** One row per host: its default home, the variable that names another one, and what a sibling folder must hold to count as a home. */
export const HOSTS = Object.freeze([
  Object.freeze({ host: "claude", label: "Claude Code", defaultName: ".claude", envVar: "CLAUDE_CONFIG_DIR", sibling: /^\.claude[_-]/, marker: (d) => isFile(path.join(d, ".claude.json")) }),
  Object.freeze({ host: "codex", label: "Codex", defaultName: ".codex", envVar: "CODEX_HOME", sibling: /^\.codex[_-]/, marker: (d) => ["config.toml", "auth.json"].some((f) => isFile(path.join(d, f))) || isDir(path.join(d, "sessions")) }),
]);

export const hostLabel = (host) => HOSTS.find((h) => h.host === host).label;

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * @param {{homeDir?: string, env?: object, hosts: {claude?: boolean, codex?: boolean}}} o which hosts' CLIs are on PATH
 * @returns {{host: "claude"|"codex", label: string, home: string, display: string, isDefault: boolean, exists: boolean, sessions: number}[]}
 *   Claude Code homes first, then Codex; within a host the default home first, then the rest by displayed path.
 */
export function discoverHomes({ homeDir = os.homedir(), env = process.env, hosts }) {
  const out = [];
  const seen = new Set();
  let names = [];
  try { names = fs.readdirSync(homeDir); } catch { /* no home folder listing */ }
  for (const h of HOSTS) {
    if (!hosts[h.host]) continue;
    const rows = [];
    const add = (dir, isDefault) => {
      const key = real(dir);
      if (seen.has(key)) return;
      seen.add(key);
      const exists = isDir(dir);
      rows.push({ host: h.host, label: h.label, home: path.resolve(dir), display: tildePath(dir, homeDir), isDefault, exists, sessions: exists ? listTranscripts(dir, h.host).length : 0 });
    };
    const dflt = path.join(homeDir, h.defaultName);
    if (isDir(dflt)) add(dflt, true);
    if (env[h.envVar]) { const d = resolveHome(env[h.envVar], homeDir); if (isDir(d)) add(d, false); }
    for (const name of names.sort()) {
      const d = path.join(homeDir, name);
      if (h.sibling.test(name) && isDir(d) && h.marker(d)) add(d, false);
    }
    if (!rows.length) add(dflt, true);
    rows.sort((a, b) => (a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : a.display < b.display ? -1 : a.display > b.display ? 1 : 0));
    out.push(...rows);
  }
  return out;
}
