// The optional fleet roster (config homesRoster, off by default): a list of agent homes with a placement policy, for people who run many
// accounts. A .json array, or a .mjs/.js module exporting CONTROL_USAGE_HOMES, of entries {id, kind: "claude"|"codex", home, protected,
// manual}. With a roster set, the roster names the homes to read (homes.mjs) and only entries with protected:false AND manual:false may
// run a worker (router.mjs).
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveHome } from "./home-paths.mjs";

export class RosterError extends Error {
  constructor(message) {
    super(message);
    this.name = "RosterError";
  }
}

/** The roster entries, with `home` resolved to an absolute path. Throws RosterError when it cannot be read: the caller decides what that stops. */
export async function loadRoster(rosterPath, homeDir) {
  if (!rosterPath) throw new RosterError("no roster configured (homesRoster / RECALL_HOMES_ROSTER is empty)");
  const file = resolveHome(rosterPath, homeDir);
  if (!fs.existsSync(file)) throw new RosterError(`roster file ${file} does not exist (config homesRoster)`);
  let entries;
  if (file.endsWith(".json")) entries = JSON.parse(fs.readFileSync(file, "utf8"));
  else {
    const mod = await import(pathToFileURL(file).href);
    entries = mod.CONTROL_USAGE_HOMES;
  }
  if (!Array.isArray(entries) || !entries.length) throw new RosterError(`roster ${file} has no CONTROL_USAGE_HOMES array`);
  return entries.map((e) => {
    if (!e || typeof e.home !== "string" || !["claude", "codex"].includes(e.kind) || typeof e.protected !== "boolean" || typeof e.manual !== "boolean") {
      throw new RosterError(`roster ${file}: malformed entry ${JSON.stringify(e)}`);
    }
    return { id: e.id ?? e.home, kind: e.kind, home: resolveHome(e.home, homeDir), protected: e.protected, manual: e.manual };
  });
}

/** Roster entries a worker may be placed on: protected:false AND manual:false. */
export const eligibleForWork = (roster) => roster.filter((e) => e.protected === false && e.manual === false);
