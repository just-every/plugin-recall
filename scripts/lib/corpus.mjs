// A corpus is the statements retrieval can search: id, text, ts, session_id, repo, host, plus the embedding and BM25 document.
// Built from the on-disk index (indexed statements joined to the embedding store) or from an eval corpus JSONL.
import { bm25Rank, makeDoc } from "./bm25.mjs";
import { clip, textHash, tokenize, tsMicros } from "./text.mjs";
import { dot, DIM } from "./vec.mjs";

/**
 * @param {{statements: object[], embeddings: Map<string, Float32Array>}} o
 * @returns {{items: object[], vecs: Float32Array[], docs: object[], byId: Map<string, number>, withoutEmbedding: object[]}}
 *   items are sorted by time ascending. Statements without an embedding are NOT searchable and are returned in withoutEmbedding
 *   so the caller can log them loudly; they are never silently dropped.
 */
export function buildCorpus({ statements, embeddings }) {
  const withoutEmbedding = [];
  const rows = [];
  const seen = new Set();
  for (const s of statements) {
    if (seen.has(s.id)) throw new Error(`duplicate corpus id ${JSON.stringify(s.id)}`);
    seen.add(s.id);
    const vec = embeddings.get(s.hash ?? textHash(s.text));
    if (!vec) { withoutEmbedding.push(s); continue; }
    rows.push({ s, vec, micros: tsMicros(s.ts) });
  }
  rows.sort((a, b) => a.micros - b.micros || (a.s.id < b.s.id ? -1 : 1));
  const items = rows.map((r) => ({ id: r.s.id, text: r.s.text, ts: r.s.ts, micros: r.micros, session_id: r.s.session_id, repo: r.s.repo ?? null, host: r.s.host, src: r.s.src ?? null }));
  const vecs = rows.map((r) => r.vec);
  const docs = items.map((it) => makeDoc(it.id, tokenize(clip(it.text, 4000))));
  const byId = new Map(items.map((it, i) => [it.id, i]));
  return { items, vecs, docs, byId, withoutEmbedding };
}

/**
 * Indices (ascending time) of the items eligible for a query: strictly before the decision time (parsed microseconds, never strings),
 * not in excludeIds (eval contract or live visible set), not from excludeSession (CLI query's explicit session exclusion), and accepted by
 * `allow` (the card filter: directives only, scope; null = no filter).
 */
export function eligibleIndices(corpus, { decisionMicros, excludeIds = new Set(), excludeSession = null, allow = null }) {
  const out = [];
  for (let i = 0; i < corpus.items.length; i++) {
    const it = corpus.items[i];
    if (!(it.micros < decisionMicros)) continue;
    if (excludeIds.has(it.id)) continue;
    if (excludeSession && it.session_id === excludeSession) continue;
    if (allow && !allow(it)) continue;
    out.push(i);
  }
  return out;
}

export function rankByEmbedding(corpus, eligible, qvec) {
  if (qvec.length !== DIM) throw new Error(`query vector has ${qvec.length} dimensions`);
  const out = eligible.map((i) => ({ idx: i, score: dot(qvec, corpus.vecs[i]) }));
  out.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return out;
}

export function rankByBm25(corpus, eligible, query) {
  const docs = eligible.map((i) => corpus.docs[i]);
  return bm25Rank(docs, tokenize(query)).map((r) => ({ idx: corpus.byId.get(r.id), score: r.score }));
}
