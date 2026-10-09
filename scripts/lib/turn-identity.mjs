// One turn, one statement. A statement's id is a hash of (host, time, text) (indexer.mjs), so the same turn read under two versions of the
// owner-text rules gets two ids when its text changed: a copy of a rollout read whole for the first time (in another home, as a .jsonl.zst, or
// under a second rollout name when a resumed session was written again), or a file read again from the start (a .zst rollout that changed, a
// file that shrank), next to the statement an earlier version made of it. A candidate whose turn already has a statement under another id is
// not admitted. Which turn a statement is, by source:
//   a Codex or Every Code rollout  (host, session, time, seq): every record carries its own time to the millisecond, but messages queued while
//                                  the agent worked are written together under one time (measured on the real homes: 28 such pairs among
//                                  13,441 rollout turn times), so `seq` (the statement's `ts_seq`) numbers the turns of a file that share a
//                                  time, in file order. Neither depends on the file's name, place or compression, and a copy of the turns
//                                  holds them in the same order
//   a legacy rollout, a typed-     (host, session, time, file, line): every turn of a legacy rollout carries its session's start
//   prompt log, a Claude            (codex-legacy.mjs) and a log's rows whole seconds, so different messages share a time and only the line
//   transcript                      tells them apart; the time keeps a line that now holds another turn (a rewritten file) from being taken
//                                   for the old one. A rollout is named by its session (rolloutSessionId: no timestamp prefix, no .zst)
// A rollout statement indexed before `ts_seq` existed (0.4.0 and earlier) is known by its line and by (host, session, time) alone; a candidate
// that is the only turn of its file at its time is that statement's turn when it is the only such statement (`alone`). The backfill stamps
// `ts_seq` on the statements it judges again (rejudge.mjs).
import path from "node:path";
import { parseSrc } from "./cards/context-source.mjs";
import { rolloutSessionId } from "./transcripts/codex.mjs";

const isRollout = (file) => path.basename(file).startsWith("rollout-");

/**
 * The keys of the turn a statement (or a candidate statement) was made from, or null when its src names no line.
 * @returns {{exact: string|null, loose: string|null, line: string}|null} exact: (host, session, time, seq) of a rollout statement with a
 *   `ts_seq`; loose: (host, session, time) of one without; line: with the file and line
 */
export function turnKeys(s) {
  const src = parseSrc(s.src);
  if (!src) return null;
  const rollout = isRollout(src.file);
  const turn = `${s.host}\u0000${s.session_id}\u0000${s.ts}`;
  const seq = rollout && Number.isInteger(s.ts_seq);
  return {
    exact: seq ? `${turn}\u0000#${s.ts_seq}` : null,
    loose: rollout && !seq ? turn : null,
    line: `${turn}\u0000${rollout ? rolloutSessionId(src.file) : path.basename(src.file)}:L${src.line}`,
  };
}

/**
 * Number the candidate turns of one rollout that share a time, in file order: each gets `tsSeq` (0 for the first turn at its time) and
 * `tsAlone` (no other turn of the file has its time). `tail` is where the previous read of the file stopped ({ts, n}: the last time and how
 * many turns had it), so a file read on from an offset goes on counting. Returns the new tail.
 */
export function numberTimes(rows, tail = null) {
  const total = new Map(); // time -> how many turns of the file have it
  if (tail) total.set(tail.ts, tail.n);
  const seen = new Map(tail ? [[tail.ts, tail.n]] : []);
  for (const r of rows) total.set(r.ts, (total.get(r.ts) ?? 0) + 1);
  for (const r of rows) {
    const n = seen.get(r.ts) ?? 0;
    seen.set(r.ts, n + 1);
    r.tsSeq = n;
    r.tsAlone = total.get(r.ts) === 1;
  }
  const last = rows.at(-1);
  return last ? { ts: last.ts, n: total.get(last.ts) } : tail;
}

/**
 * The statements' turns: `other(s, o)` is the id of an earlier statement of the same turn with a different id, or null; `add(s)` records one
 * under every key it has.
 */
export function createTurnIndex(statements = []) {
  const byKey = new Map();
  const loose = new Map(); // (host, session, time) -> {id, n}: the rollout statements without ts_seq
  const add = (s) => {
    const keys = turnKeys(s);
    if (!keys) return;
    for (const k of [keys.exact, keys.line]) if (k && !byKey.has(k)) byKey.set(k, s.id);
    if (keys.loose) { const l = loose.get(keys.loose); if (l) l.n++; else loose.set(keys.loose, { id: s.id, n: 1 }); }
  };
  for (const s of statements) add(s);
  const pick = (id, s) => (id && id !== s.id ? id : null);
  return {
    add,
    /** @param {{alone?: boolean}} [o] alone: no other turn of the candidate's file has its time */
    other(s, { alone = false } = {}) {
      const keys = turnKeys(s);
      if (!keys) return null;
      if (keys.exact) {
        const id = byKey.get(keys.exact);
        if (id) return pick(id, s);
        const l = alone ? loose.get(`${s.host}\u0000${s.session_id}\u0000${s.ts}`) : null;
        if (l?.n === 1) return pick(l.id, s);
      }
      return pick(byKey.get(keys.line), s);
    },
  };
}
