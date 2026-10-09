// What the filters leave of the held turns, and how the feed groups them.
import { store } from "./store.js";

export const ACTIVE_MS = 30 * 60_000;

export function windowTurns(nowMs = Date.now()) {
  const since = nowMs - store.filters.hours * 3_600_000;
  return [...store.turns.values()].filter((t) => Date.parse(t.updated) >= since).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

export function filterOptions(turns) {
  const uniq = (key) => [...new Set(turns.map((t) => t[key]).filter(Boolean))].sort();
  return { hosts: uniq("host"), homes: uniq("home") };
}

export function matches(t, f) {
  if (f.host && t.host !== f.host) return false;
  if (f.home && t.home !== f.home) return false;
  const q = f.q.trim().toLowerCase();
  if (q) {
    const hay = `${t.query ?? ""}\n${t.project ?? ""}\n${t.home ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Feed items, newest first: cards, and (unless skips are shown) runs of consecutive pure-skip turns collapsed into one row. */
export function feedItems(turns, showSkips) {
  const items = [];
  let run = null;
  for (const turn of turns) {
    if (turn.skip && !showSkips) {
      if (!run) { run = { kind: "run", turns: [] }; items.push(run); }
      run.turns.push(turn);
    } else {
      run = null;
      items.push({ kind: "card", turn });
    }
  }
  return items;
}
