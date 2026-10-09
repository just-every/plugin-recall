// Injection-layer dedupe: the same statement can sit in the corpus twice (mirrored across homes or sessions, or typed twice) and would
// take two of the RECALL_K slots. Applied by the hooks only, AFTER the pipeline has ranked: retrieve() and `recall eval` rankings are
// never touched, so experiments stay comparable.
// The indexer has no text normalization for identity (its textHash is a hash of the clipped text, case-sensitive), so the key is the
// shared whitespace normalization (norm: collapse, trim) lowercased.
import { norm } from "./text.mjs";

export const dedupeKey = (text) => norm(text).toLowerCase();

/**
 * Entries of `ranked` ([{id, score, ...}], best first) with at most one entry per normalized text. The highest-scored occurrence of each
 * text is kept (the earliest in rank order on a tie), at its own rank position, so the remaining order is unchanged and a following
 * slice(0, k) fills up to k with distinct statements.
 */
export function dedupeRanked(ranked, textOf) {
  const best = new Map(); // key -> index into ranked of the kept occurrence
  ranked.forEach((e, i) => {
    const key = dedupeKey(textOf(e));
    const j = best.get(key);
    if (j === undefined || e.score > ranked[j].score) best.set(key, i);
  });
  return ranked.filter((_, i) => i === best.get(dedupeKey(textOf(ranked[i]))));
}
