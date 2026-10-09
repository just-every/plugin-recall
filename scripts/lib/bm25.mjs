// BM25 over a per-query eligible document set. IDF comes ONLY from the eligible documents, so no corpus statistic from after the
// decision point reaches a score. Same k1/b and tie-break as the research prototype this was ported from.
export function makeDoc(id, tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { id, tf, len: tokens.length };
}

/** Ranked [{id, score}] over `docs` (best first, ties by id). Only the query's terms are looked up, so cost is O(docs x query terms). */
export function bm25Rank(docs, queryTokens, k1 = 1.2, b = 0.75) {
  const N = docs.length;
  if (!N) return [];
  const q = [...new Set(queryTokens)];
  const df = new Map();
  for (const d of docs) for (const t of q) if (d.tf.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = docs.reduce((s, d) => s + d.len, 0) / N;
  const out = docs.map((d) => {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = df.get(t);
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg));
    }
    return { id: d.id, score: s };
  });
  out.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return out;
}
