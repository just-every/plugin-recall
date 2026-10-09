// The backfill (peel-backfill.mjs) re-reads a file from the start. Every line of it that already holds a statement is judged again with the
// current rules, so that an upgraded index holds what a fresh index of the same files would, under the ids it already has:
//   - the rules make the same statement of the line (same id, or the same text)        kept as it is
//   - the rules make another text of the line                                          rewritten in place: new text and text hash under the
//                                                                                      statement's id, so its card (keyed by id) survives;
//                                                                                      the new hash has no embedding yet, so the indexer's
//                                                                                      embedding step embeds it (the old vector stays, keyed
//                                                                                      by the old hash, used by no statement unless another
//                                                                                      one has that text)
//   - the rules make another text that another statement already holds (its own id)    retired: the turn has that statement; but when
//                                                                                      this pass added that statement (a copy of the turn
//                                                                                      read before this line), it gives way: it is retired
//                                                                                      and the held statement is rewritten, so the turn
//                                                                                      keeps its older id (and card) whatever the file order
//   - the rules reject the line (an owner-text rule, or the scanner left the line out:  retired: taken out of statements.jsonl (so nothing
//     an Every Code turn nobody typed, an Auto Drive row; or the whole file: a session   retrieves it, nothing gives it a card) and written
//     that is not a person's), and no other line of the file makes the same statement   to retired.jsonl with the reason (the rule's, the
//                                                                                      session verdict's, or NOT_OFFERED); its card stays in
//                                                                                      cards.jsonl, inert (cards are only attached to the
//                                                                                      statements a retrieval loads), and so does its vector
// A rollout statement indexed before `ts_seq` existed gets it from its line (turn-identity.mjs). A line the pass did not reach (a turn that must wait for its log row) is not judged. The changes are written before the scan state that
// stamps the file is saved, so a pass that dies in between re-judges the file next time.
import { parseSrc } from "../cards/context-source.mjs";
import { textHash } from "../text.mjs";
import { PEEL_VERSION } from "./peel-backfill.mjs";

/** The reason a statement is retired when the scan left its line out (an owner-text rule would have named its own). */
export const NOT_OFFERED = "line-not-a-candidate";

const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };

/** @param {object[]} statements the index as the pass starts (after moved rollouts are repointed) */
export function createRejudge(statements) {
  let bySrc = null;
  let byFile = null;
  const index = () => {
    if (bySrc) return;
    bySrc = new Map();
    byFile = new Map();
    for (const s of statements) {
      const src = parseSrc(s.src);
      if (!src) continue;
      push(bySrc, s.src, s);
      push(byFile, src.file, { s, line: src.line });
    }
  };
  const retire = new Map(); // id -> {statement, reason}
  const rewrite = new Map(); // id -> {text, hash}
  const stamp = new Map(); // id -> ts_seq: a rollout statement indexed before ts_seq existed gets it (turn-identity.mjs)
  const rewrittenTo = new Set(); // the ids the rewritten texts would have: a second statement of the line rewritten to one is that turn again
  const addedNow = new Map(); // id -> statement: the statements this pass added
  const counts = { kept: 0, rewritten: 0, retired: 0, retiredBy: {} };
  const retireOne = (s, reason) => {
    if (retire.has(s.id) || rewrite.has(s.id)) return;
    retire.set(s.id, { statement: s, reason });
    counts.retired++;
    counts.retiredBy[reason] = (counts.retiredBy[reason] ?? 0) + 1;
  };

  return {
    counts,
    /** Record a statement the pass added (a held statement of its turn judged later in the pass takes the turn back: line()). */
    added(s) { addedNow.set(s.id, s); },

    /** The statements a src line holds ("<file>:L<line>"). */
    held(src) { index(); return bySrc.get(src) ?? []; },

    /**
     * Judge the statements a line holds against what the rules make of it now (indexer.buildStatement's result).
     * @param {object[]} held  @param {{statement?: object, reason?: string}} built  @param {Set<string>} known the ids in the index
     * @returns {object[]} the held statements that get a ts_seq, as they will be (for the turn index)
     */
    line(held, built, known) {
      const stamped = [];
      for (const s of held) {
        if (!built.statement) { retireOne(s, built.reason); continue; }
        const now = built.statement;
        if (Number.isInteger(now.ts_seq) && !Number.isInteger(s.ts_seq) && now.ts === s.ts) { stamp.set(s.id, now.ts_seq); stamped.push({ ...s, ts_seq: now.ts_seq }); }
        if (now.id === s.id || now.text === s.text) { counts.kept++; continue; }
        if (rewrittenTo.has(now.id) || (known.has(now.id) && !addedNow.has(now.id))) { retireOne(s, "turn-held-by-another-statement"); continue; }
        if (addedNow.has(now.id)) retireOne(addedNow.get(now.id), "turn-held-by-another-statement");
        if (!rewrite.has(s.id)) { rewrite.set(s.id, { text: now.text, hash: textHash(now.text) }); rewrittenTo.add(now.id); counts.rewritten++; }
      }
      return stamped;
    },

    /**
     * After a file's backfill: retire the statements of the lines the scan judged (up to `through`) but offered no candidate for, unless
     * another line of the file made the same statement (`produced`: a message Codex writes twice, as an event and as a response item).
     * `reason`: why the scan offered nothing (a file it rejected whole names its verdict), else NOT_OFFERED.
     * @param {{file: string, offered: Set<string>, produced: Set<string>, through: number, reason?: string}} o
     */
    unoffered({ file, offered, produced, through, reason = NOT_OFFERED }) {
      index();
      for (const { s, line } of byFile.get(file) ?? []) {
        if (line > through || offered.has(s.src) || produced.has(s.id)) continue;
        retireOne(s, reason);
      }
    },

    pending: () => retire.size > 0 || rewrite.size > 0 || stamp.size > 0,

    /** Write what was decided: rewrite and remove rows of statements.jsonl, append the retired ones to retired.jsonl. */
    flush(store, at = new Date().toISOString()) {
      if (!retire.size && !rewrite.size && !stamp.size) return;
      const gone = [];
      store.updateStatements((rows) => rows.flatMap((s) => {
        const r = retire.get(s.id);
        if (r) { gone.push({ ...s, retired: { at, reason: r.reason, rules: PEEL_VERSION } }); return []; }
        const seq = stamp.has(s.id) ? { ts_seq: stamp.get(s.id) } : {};
        const w = rewrite.get(s.id);
        return w ? [{ ...s, ...seq, text: w.text, hash: w.hash, rewritten: { at, rules: PEEL_VERSION, previousHash: s.hash } }] : [{ ...s, ...seq }];
      }));
      store.appendRetired(gone);
      retire.clear();
      rewrite.clear();
      stamp.clear();
    },
  };
}
