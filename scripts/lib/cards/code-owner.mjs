// Whose user turns an Every Code rollout holds, for the context of a card (context-source.mjs): the indexer decides it against the homes'
// typed-prompt logs (transcripts/code-rollout.mjs), because the rollout itself cannot tell a typed prompt from an Auto Drive coordinator's,
// an auto-review's or a host's canned request. The card context takes the "previous owner message" by the same rule, from the same logs
// (every home the indexer reads), so a coordinator prompt is never shown to the card writer as something the person said.
import os from "node:os";
import path from "node:path";
import { indexedHomes } from "../homes.mjs";
import { historyLog } from "../transcripts/files.mjs";
import { readTypedLogs } from "../transcripts/typed-rows.mjs";

const ROOTS = ["sessions", "archived_sessions"];

/** The home a rollout is in: the directory its sessions/ or archived_sessions/ tree hangs from (the indexer's agent home). */
export function rolloutHome(file) {
  const parts = path.resolve(file).split(path.sep);
  const at = parts.findLastIndex((p, i) => ROOTS.includes(p) && i < parts.length - 1);
  return at > 0 ? parts.slice(0, at).join(path.sep) : null;
}

/**
 * @param {{config: object, homeDir?: string, env?: object, now?: number}} o the homes are looked up as the indexer does (homes.mjs)
 * @returns {(file: string) => Promise<{typed: object, home: string|null, now: number}>} what codeTurnVerdict needs for a rollout's turns;
 *   the logs are read once, on the first call
 */
export function createCodeOwners({ config, homeDir = os.homedir(), env = process.env, now = Date.now() }) {
  let typed = null;
  const load = async () => {
    const { homes } = await indexedHomes(config, { homeDir, env });
    return readTypedLogs(homes.map((h) => ({ home: h, f: historyLog(h.dir) })).filter((x) => x.f));
  };
  return async (file) => ({ typed: await (typed ??= load()), home: rolloutHome(file), now });
}
