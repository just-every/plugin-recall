// Which agent homes to read. By default the standard ones:
//   ~/.claude and ~/.codex, $CLAUDE_CONFIG_DIR and $CODEX_HOME when set, ~/.code (Every Code) when it exists,
// plus every home listed in config `homes`. A home that does not exist is skipped. Homes named by an optional roster (config homesRoster)
// replace the standard ones for reading (roster.mjs). Credentials are never opened: the transcript walk skips credential paths.
// A `homes` entry written {path, kind} is read for indexing only (a backup, a copy from another machine, an account no worker may use): it is
// never one of minedHomes(), which the worker router reads, so no worker can be placed there; indexedHomes() is what the indexer reads.
//
//   claude  <home>/projects/**/<session>.jsonl         (sub-agent transcripts excluded), <home>/history.jsonl
//   codex   <home>/{sessions,archived_sessions}/**/rollout-*.jsonl[.zst]   (interactive sessions only), <home>/history.jsonl
//   code    the same as codex (Every Code)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeKind, isDir, resolveHome } from "./home-paths.mjs";
import { loadRoster } from "./roster.mjs";

export { homeKind, isDir, resolveHome };

/** Other agent homes sitting in the home folder (`.claude_work`, `.codex-alt` ...) that `chosen` does not include. */
function otherHomes(homeDir, chosen) {
  const names = new Set([...chosen].map((d) => path.basename(d)));
  const found = [];
  let entries = [];
  try { entries = fs.readdirSync(homeDir).sort(); } catch { return found; }
  for (const name of entries) {
    if (!/^\.(claude|codex)($|[_-])/.test(name) || names.has(name)) continue;
    if (isDir(path.join(homeDir, name))) found.push(path.join(homeDir, name));
  }
  return found;
}

/**
 * Homes to read. Returns {homes: [{dir, kind}], skipped: [dir]}: `homes` are the homes a worker may also run in (the router's candidates),
 * `skipped` the agent homes that exist but are not read (add them to config `homes` to read them). The index-only homes are not in `homes`
 * (indexOnlyHomes() lists them) and not in `skipped` either. Throws RosterError when a configured roster cannot be read.
 * @param {object} config
 * @param {{homeDir?: string, env?: object}} [o] the home folder and the environment to look in (tests give both)
 */
export async function minedHomes(config, { homeDir = os.homedir(), env = process.env } = {}) {
  const homes = new Map();
  const add = (dir) => { if (isDir(dir)) homes.set(dir, { dir, kind: homeKind(dir) }); };
  if (config.homesRoster) {
    for (const e of await loadRoster(config.homesRoster, homeDir)) add(e.home);
  } else {
    add(path.join(homeDir, ".claude"));
    add(path.join(homeDir, ".codex"));
    if (env.CLAUDE_CONFIG_DIR) add(resolveHome(env.CLAUDE_CONFIG_DIR, homeDir));
    if (env.CODEX_HOME) add(resolveHome(env.CODEX_HOME, homeDir));
  }
  add(path.join(homeDir, ".code"));
  for (const h of config.homes ?? []) if (typeof h === "string") add(resolveHome(h, homeDir));
  const indexOnly = indexOnlyHomes(config, { homeDir }).map((h) => h.dir);
  return { homes: [...homes.values()], skipped: otherHomes(homeDir, [...homes.keys(), ...indexOnly]) };
}

/**
 * The config `homes` entries written {path, kind}: homes read for indexing only, never a worker's. Each {dir, kind, indexOnly: true}; one
 * that does not exist is skipped.
 */
export function indexOnlyHomes(config, { homeDir = os.homedir() } = {}) {
  const out = new Map();
  for (const h of config.homes ?? []) {
    if (typeof h === "string") continue;
    const dir = resolveHome(h.path, homeDir);
    if (isDir(dir)) out.set(dir, { dir, kind: h.kind, indexOnly: true });
  }
  return [...out.values()];
}

/** Every home the indexer reads: the mined homes, then the index-only ones that are not mined already. */
export async function indexedHomes(config, o = {}) {
  const mined = await minedHomes(config, o);
  const have = new Set(mined.homes.map((h) => h.dir));
  return { homes: [...mined.homes, ...indexOnlyHomes(config, o).filter((h) => !have.has(h.dir))], skipped: mined.skipped };
}
