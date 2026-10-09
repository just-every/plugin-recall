// Aggregations over the held turns: today's counters, active sessions, and the per-reason counts of a window.
import { didAudit, didSearch } from "./describe.mjs";
import { reasonInfo } from "./reasons.mjs";

const ACTIVE_MS = 30 * 60_000;
const linesOf = (turn) => [turn.prompt, ...turn.stops].filter(Boolean);
const isSilentSkip = (l) => l.outcome === "silent" && l.reason && reasonInfo(l.reason).kind === "skip";

/**
 * Counts of hook firings by what they did, for lines whose UTC day is `day`. `lookups` are the `recall show` lines (an agent, or the owner,
 * read the conversation around a recalled statement); they are not hook firings and are counted apart.
 */
export function dayCounters(turns, day, lookups = []) {
  const c = { day, lookedUp: lookups.filter((l) => String(l.ts).startsWith(day)).length, fired: 0, prompts: 0, stops: 0, searched: 0, injectedTurns: 0, injectedStatements: 0, audited: 0, blocked: 0, capped: 0, errors: 0, skipped: 0, costUsd: 0, skippedByReason: [] };
  const byReason = new Map();
  for (const turn of turns) {
    for (const l of linesOf(turn)) {
      if (!String(l.ts).startsWith(day)) continue;
      c.fired++;
      if (l.event === "prompt") c.prompts++;
      else if (l.event === "stop") c.stops++;
      if (didSearch(l)) c.searched++;
      if (l.outcome === "injected") { c.injectedTurns++; c.injectedStatements += Array.isArray(l.injected) ? l.injected.length : 0; }
      if (didAudit(l)) c.audited++;
      if (l.outcome === "blocked") c.blocked++;
      if (l.outcome === "silent" && l.reason === "cap-reached") c.capped++;
      if (l.level === "error") c.errors++;
      const cost = (Number.isFinite(l.stats?.costUsd) ? l.stats.costUsd : 0) + (Number.isFinite(l.stats?.embedCostUsd) ? l.stats.embedCostUsd : 0);
      c.costUsd += cost;
      if (isSilentSkip(l)) {
        c.skipped++;
        const k = `${l.event}|${l.reason}`;
        byReason.set(k, (byReason.get(k) ?? 0) + 1);
      }
    }
  }
  c.skippedByReason = reasonRows(byReason);
  return c;
}

function reasonRows(byReason) {
  return [...byReason].map(([k, count]) => {
    const [event, ...rest] = k.split("|");
    const reason = rest.join("|");
    const info = reasonInfo(reason);
    return { event, reason, label: info.label, group: info.group, kind: info.kind, count };
  }).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Every silent reason in lines at or after `sinceIso`, with its count (skips, nothing-above-threshold, errors alike). */
export function reasonCounts(turns, sinceIso) {
  const byReason = new Map();
  for (const turn of turns) {
    for (const l of linesOf(turn)) {
      if (l.ts < sinceIso || !l.reason || l.outcome === "blocked") continue;
      const k = `${l.event}|${l.reason}`;
      byReason.set(k, (byReason.get(k) ?? 0) + 1);
    }
  }
  return reasonRows(byReason);
}

const AUTOMATED = /^(headless:|unknown:|child$)/;

/**
 * Sessions with a hook line in the last 30 minutes, newest first. A session whose every line was silenced as automated (headless, unknown,
 * Recall's own worker) is not a person's session and is left out.
 */
export function activeSessions(turns, nowMs) {
  const sessions = new Map();
  for (const turn of turns) {
    for (const l of linesOf(turn)) {
      if (!l.session_id) continue;
      let s = sessions.get(l.session_id);
      if (!s) { s = { session_id: l.session_id, host: null, home: null, project: null, last: "", lines: 0, person: false }; sessions.set(l.session_id, s); }
      s.lines++;
      if (!(l.reason && AUTOMATED.test(l.reason))) s.person = true;
      if (l.ts >= s.last) { s.last = l.ts; s.host = l.host ?? s.host; s.home = l.home ?? s.home; s.project = l.project ?? s.project; }
      else { s.host ??= l.host ?? null; s.home ??= l.home ?? null; s.project ??= l.project ?? null; }
    }
  }
  return [...sessions.values()]
    .filter((s) => s.person && nowMs - Date.parse(s.last) <= ACTIVE_MS)
    .sort((a, b) => (a.last < b.last ? 1 : -1))
    .map(({ person, ...s }) => s);
}
