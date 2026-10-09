// Ranking rules. Scores in `ranked` are made strictly monotone with the order (a tie-break fraction is folded in) so a consumer that
// sorts by score reproduces the order; the raw per-stage numbers live in `parts`.
export const TOP_N = 50;

/** Append embedding-order items (not already ranked) until `n` are listed, scored below everything ranked so far. */
export function fillFromEmbeddings(ranked, corpus, emb, cos, n = TOP_N) {
  const seen = new Set(ranked.map((r) => r.id));
  const floor = ranked.length ? Math.min(...ranked.map((r) => r.score)) - 1 : 0;
  for (const r of emb) {
    if (ranked.length >= n) break;
    const id = corpus.items[r.idx].id;
    if (seen.has(id)) continue;
    ranked.push({ id, score: floor + r.score * 1e-3, parts: { emb: r.score, embRank: null } });
  }
  return ranked;
}
