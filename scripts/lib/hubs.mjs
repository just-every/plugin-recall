// Hub suppression: a statement already injected into at least `maxSessions` distinct OTHER sessions within the last `windowDays` days is a
// hub (a generic statement said into everything: on one developer's history ten statements were 31% of the cards injected and none was useful) and is not injected again.
// Pure: the history is passed in, so a live hook (the hub index) and a replay (an explicit per-run history file) count the same way.
import { tsMicros } from "./text.mjs";

export const DAY_MS = 86_400_000;
const millis = (ts) => tsMicros(ts) / 1000;

/**
 * @param {Iterable<{id: string, session_id: string, ts: string}>} history one row per (statement, session) injection
 * @param {{sessionId: string|null, nowMs: number, windowDays: number, maxSessions: number}} o   (times are parsed, never compared as strings)
 *   Rows at or after `nowMs` are ignored (a replay must not see its own future), and so are rows of `sessionId` itself (within-session repeats
 *   are noRepeat's business).
 * @returns {Set<string>} the ids that may not be injected now; empty when maxSessions is 0 (off)
 */
export function hubIds(history, { sessionId, nowMs, windowDays, maxSessions }) {
  const hubs = new Set();
  if (!maxSessions) return hubs;
  const since = nowMs - windowDays * DAY_MS;
  const sessions = new Map();
  for (const row of history) {
    const at = millis(row.ts);
    if (!(at > since && at < nowMs) || row.session_id === sessionId) continue;
    if (!sessions.has(row.id)) sessions.set(row.id, new Set());
    sessions.get(row.id).add(row.session_id);
  }
  for (const [id, set] of sessions) if (set.size >= maxSessions) hubs.add(id);
  return hubs;
}
