// The live hub history: which statements were injected into which sessions, over the last hubWindowDays days.
//   <dataDir>/state/hub-index.json   {version: 1, entries: {<statement id>: {<session id>: <iso time of its latest injection>}}}
// Updated by the prompt hook on each injection (under a lock: every host's hook shares the data dir), pruned to the window on each write.
// When the file does not exist it is built once from the turn logs (logs/turns-YYYY-MM-DD.jsonl: the injected prompt lines of the window), so
// the first run after an upgrade still knows what was said before. A file that exists but is not valid is an error, never rebuilt silently.
import fs from "node:fs";
import path from "node:path";
import { DAY_MS, hubIds } from "./hubs.mjs";
import { withLockSync } from "./lock.mjs";

const VERSION = 1;
const INJECTED = '"outcome":"injected"';

export const hubIndexPath = (dataDir) => path.join(dataDir, "state", "hub-index.json");

/** The injected statements of the turn logs in the window, as index entries. */
export function entriesFromLogs(dataDir, { sinceMs, nowMs }) {
  const entries = {};
  const logDir = path.join(dataDir, "logs");
  let names = [];
  try { names = fs.readdirSync(logDir); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const firstDay = new Date(sinceMs).toISOString().slice(0, 10);
  const lastDay = new Date(nowMs).toISOString().slice(0, 10);
  for (const name of names.sort()) {
    const day = /^turns-(\d{4}-\d\d-\d\d)\.jsonl$/.exec(name)?.[1];
    if (!day || day < firstDay || day > lastDay) continue;
    for (const line of fs.readFileSync(path.join(logDir, name), "utf8").split("\n")) {
      if (!line.includes(INJECTED)) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; } // a line another process is still writing
      if (row.event !== "prompt" || row.outcome !== "injected" || !row.session_id || !Array.isArray(row.injected)) continue;
      const at = Date.parse(row.ts);
      if (!(at > sinceMs)) continue;
      for (const id of row.injected) {
        const sessions = (entries[id] ??= {});
        if (!(sessions[row.session_id] >= row.ts)) sessions[row.session_id] = row.ts;
      }
    }
  }
  return entries;
}

function prune(entries, sinceMs) {
  const out = {};
  for (const [id, sessions] of Object.entries(entries)) {
    const kept = Object.fromEntries(Object.entries(sessions).filter(([, ts]) => Date.parse(ts) > sinceMs));
    if (Object.keys(kept).length) out[id] = kept;
  }
  return out;
}

const write = (file, entries) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, entries }));
  fs.renameSync(tmp, file);
};

/**
 * @param {{dataDir: string, windowDays: number, now?: () => Date}} o
 */
export function createHubIndex({ dataDir, windowDays, now = () => new Date() }) {
  const file = hubIndexPath(dataDir);
  const lockFile = path.join(dataDir, "locks", "hub-index.lock");
  const sinceMs = () => now().getTime() - windowDays * DAY_MS;

  /** Read the index (building it from the logs when there is none). Call under the lock when you will write. */
  function read() {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (e) {
      if (e.code !== "ENOENT") throw e;
      return entriesFromLogs(dataDir, { sinceMs: sinceMs(), nowMs: now().getTime() });
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error(`hub index ${file} is not valid JSON (delete it to rebuild it from the turn logs)`); }
    if (parsed?.version !== VERSION || typeof parsed.entries !== "object" || parsed.entries === null) throw new Error(`hub index ${file} is not a version ${VERSION} index (delete it to rebuild it from the turn logs)`);
    return parsed.entries;
  }

  return {
    file,
    /** The statement ids that are hubs now, for a hook of session `sessionId`. */
    suppressed({ sessionId, maxSessions }) {
      const history = Object.entries(read()).flatMap(([id, sessions]) => Object.entries(sessions).map(([session_id, ts]) => ({ id, session_id, ts })));
      return hubIds(history, { sessionId, nowMs: now().getTime(), windowDays, maxSessions });
    },
    /** Record that `ids` were injected into `sessionId` now. */
    record({ sessionId, ids }) {
      if (!ids.length) return;
      withLockSync(lockFile, () => {
        const entries = prune(read(), sinceMs());
        const ts = now().toISOString();
        for (const id of ids) (entries[id] ??= {})[sessionId] = ts;
        write(file, entries);
      }, { staleMs: 60_000, timeoutMs: 10_000 });
    },
  };
}
