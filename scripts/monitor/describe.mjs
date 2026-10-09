// Turn the raw log lines into what the feed shows: one "half" per hook firing (chip, tone, plain-language detail, latency, cost) and one
// "turn" per prompt line + its Stop line(s). Pure functions of the lines and the effective bars; the labels come from reasons.mjs.
import { GROUPS, reasonInfo } from "./reasons.mjs";

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** 0.95 -> "0.95", 0.9 -> "0.9" */
export const fmtBar = (x) => String(Number(x.toFixed(4)));
export const fmtScore = (x) => x.toFixed(2);
export const fmtUsd = (x) => `$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`;

/** Embedding plus Decisions cost the hook recorded in its own stats; null when the line has none. */
export function lineCost(l) {
  const a = num(l.stats?.costUsd);
  const b = num(l.stats?.embedCostUsd);
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

/** Did this prompt line run a retrieval (and so cost something)? */
export const didSearch = (l) => l.event === "prompt" && (l.outcome === "injected" || l.reason === "nothing-above-threshold" || l.reason === "retrieval-failed" || l.reason === "apply-gate-failed");
/** Number of candidates a Stop line audited (0 when it did not audit). */
export const auditedCount = (l) => (l.event === "stop" ? (num(l.audited) ?? num(l.stats?.audited) ?? 0) : 0);
export const didAudit = (l) => l.event === "stop" && (l.outcome === "blocked" || auditedCount(l) > 0);

/** Highest violation score the Stop audit saw, or null. */
export function bestScore(l) {
  const scores = [...(Array.isArray(l.stats?.top) ? l.stats.top : []), ...(Array.isArray(l.hits) ? l.hits : [])].map((t) => num(t?.score)).filter((x) => x !== null);
  return scores.length ? Math.max(...scores) : null;
}

/**
 * One hook firing as the feed shows it.
 * @param {object} l the raw log line
 * @param {{promptThreshold: number|null, stopThreshold: number|null}} bars
 */
export function describeHalf(l, bars) {
  const silent = l.outcome !== "blocked"; // a block's `reason` is the feedback text sent to the agent, not a silence reason
  const info = silent && l.reason ? reasonInfo(l.reason) : null;
  const half = { event: l.event, ts: l.ts, level: l.level ?? "info", outcome: l.outcome ?? null, reason: silent ? (l.reason ?? null) : null, feedback: silent ? null : (l.reason ?? null), error: l.error ?? null, latencyMs: num(l.latency_ms), costUsd: lineCost(l), line: l };
  const done = (kind, tone, label, detail) => ({ ...half, kind, tone, label, detail, group: info?.group ?? null });

  if (l.outcome === "injected") {
    const n = Array.isArray(l.injected) ? l.injected.length : 0;
    return done("injected", "info", `Injected ${n}`, `${plural(n, "earlier statement")} added to the agent's context.`);
  }
  if (l.outcome === "blocked") {
    const best = bestScore(l);
    return done("blocked", "bad", "Blocked", `Recall sent the agent back once${best === null ? "" : `: the best violation score was ${fmtScore(best)}`}.`);
  }
  if (l.event === "stop" && didAudit(l)) {
    const n = auditedCount(l);
    const best = bestScore(l);
    const thr = bars.stopThreshold;
    const label = l.reason === "nominated-hits-not-confirmed" ? `Audited ${n} · nominated, not confirmed`
      : `Audited ${n}${best === null ? "" : ` · best ${fmtScore(best)}`}${thr === null ? "" : ` / ${fmtBar(thr)}`}`;
    return done("audited", "info", label, info ? `${plural(n, "candidate")} audited: ${info.label}.` : `${plural(n, "candidate")} audited.`);
  }
  if (info) {
    if (info.kind === "empty") {
      const thr = bars.promptThreshold;
      return done("empty", "quiet", thr === null ? "Nothing above the injection bar" : `Nothing above ${fmtBar(thr)}`, info.detail);
    }
    if (info.kind === "capped") return done("capped", "mid", info.chip, info.detail);
    if (info.kind === "error") return done("error", "bad", info.chip, `${info.detail}${l.error ? ` ${l.error}` : ""}`);
    if (info.kind === "audited") return done("audited", "info", "Audited", info.detail);
    return done("skip", "quiet", `Skipped: ${info.label}`, info.detail);
  }
  if (l.level === "error") return done("error", "bad", l.event === "auto-index" ? "Background index failed" : "Error", l.error ?? "An error was logged without a reason.");
  return done("skip", "quiet", l.outcome ? `Outcome: ${l.outcome}` : "No outcome recorded", "The log line has neither an outcome nor a reason.");
}

const STOP_RANK = { blocked: 0, audited: 1, error: 2, capped: 3, empty: 4, injected: 4, skip: 5 };
/** The Stop half the card shows: a block beats an audit beats an error beats a skip; a bare stop-hook-active follow-up comes last. */
export function pickStop(stops) {
  if (!stops.length) return null;
  const rank = (s) => (s.reason === "stop-hook-active" ? 9 : (STOP_RANK[s.kind] ?? 6));
  return stops.reduce((best, s) => (rank(s) < rank(best) ? s : best));
}

/** @returns {object} the turn as the feed and the drawer need it */
export function viewTurn(turn, bars) {
  const prompt = turn.prompt ? describeHalf(turn.prompt, bars) : null;
  const stops = turn.stops.map((l) => describeHalf(l, bars));
  const stop = pickStop(stops);
  const lines = [turn.prompt, ...turn.stops].filter(Boolean);
  const first = lines[0];
  const withMeta = lines.find((l) => l.home !== undefined || l.project !== undefined) ?? first; // lines from before the origin fields have none
  const halves = [prompt, stop].filter(Boolean);
  const pureSkip = halves.length > 0 && halves.every((h) => h.kind === "skip");
  const groupKey = pureSkip ? (halves.find((h) => h.group)?.group ?? "other") : null;
  const cost = halves.reduce((sum, h) => sum + (h.costUsd ?? 0), 0);
  return {
    id: turn.id,
    ts: lines.reduce((min, l) => (l.ts < min ? l.ts : min), first.ts),
    updated: lines.reduce((max, l) => (l.ts > max ? l.ts : max), first.ts),
    session_id: first.session_id ?? null,
    turn_key: first.turn_key ?? null,
    host: withMeta.host ?? first.host ?? null,
    home: withMeta.home ?? null,
    project: withMeta.project ?? null,
    cwd: withMeta.cwd ?? null,
    transcript: withMeta.transcript ?? null,
    query: typeof turn.prompt?.query === "string" ? turn.prompt.query : null,
    prompt,
    stop,
    followUps: stops.length - (stop ? 1 : 0),
    stops: stops.length > 1 ? stops : undefined,
    skip: pureSkip,
    skipGroup: groupKey,
    skipGroupLabel: groupKey ? GROUPS[groupKey] : null,
    costUsd: halves.some((h) => h.costUsd !== null) ? cost : null,
  };
}
