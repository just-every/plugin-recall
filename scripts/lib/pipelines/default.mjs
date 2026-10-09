// Pipeline "default" = the tuned winner of the research prototype (docs/x3-pipeline.json):
//   prefilter  embeddings top 150 + BM25 top 60 + same-thread newest 30 (about 200 statements)
//   D-generic  the generic question over the prefilter, one predicate per statement, packs of 72 sent concurrently
//   fusion     reciprocal rank fusion, k = 60 (k = 10 in prompt mode, see SPEC.rrfKPrompt): 1/(k+E) + 1/(k+B) + 2/(k+Dg), E and B full-history ranks, Dg the rank by D score within the prefilter
//              (ties by embedding rank; refused questions after every scored one, in embedding order)
//   order      fused score descending, ties by embedding rank, then position
// The winner has no CLI rerank stage (the prototype measured one, `codex exec` over the top 20, as an optional slower stage; see pipelines/rerank.mjs).
import { prefilter } from "./prefilter.mjs";
import { genericQuestion, scoreItems } from "./questions.mjs";
import { TOP_N, fillFromEmbeddings } from "./rank.mjs";
import { SPEC } from "./spec.mjs";

/** The D-generic ranking inside the prefilter: scored items by probability, ties by embedding rank then position; refused items last. */
export async function dGenericRanking(ctx, pf) {
  const items = pf.candidates.map((idx) => ctx.corpus.items[idx]);
  const probs = await scoreItems(ctx, items, genericQuestion, "d-generic");
  const p = new Map();
  const refusedIdx = [];
  for (const idx of pf.candidates) {
    const v = probs.get(ctx.corpus.items[idx].id);
    if (v === null || v === undefined) refusedIdx.push(idx);
    else p.set(idx, v);
  }
  const scored = [...p.keys()].sort((a, b) => p.get(b) - p.get(a) || pf.embRank.get(a) - pf.embRank.get(b) || a - b);
  refusedIdx.sort((a, b) => pf.embRank.get(a) - pf.embRank.get(b));
  ctx.stats.refused = (ctx.stats.refused ?? 0) + refusedIdx.length;
  return { rank: new Map([...scored, ...refusedIdx].map((idx, k) => [idx, k + 1])), prob: p };
}

export const defaultPipeline = {
  name: "default",
  // Inject only what the judge also rates important: fusion decides the order, D-generic's probability decides whether to speak.
  gate: (entry, cfg) => Number.isFinite(entry.parts.d) && entry.parts.d >= cfg.promptThreshold,
  async run(ctx) {
    const pf = await prefilter(ctx);
    const dg = await dGenericRanking(ctx, pf);
    const k = ctx.mode === "prompt" ? SPEC.rrfKPrompt : SPEC.rrfK;
    const rows = pf.candidates.map((idx) => {
      const e = pf.embRank.get(idx);
      const b = pf.bm25Rank.get(idx);
      const d = dg.rank.get(idx);
      return { idx, e, b, d, rrf: SPEC.wEmbeddings / (k + e) + SPEC.wBm25 / (k + b) + SPEC.wDGeneric / (k + d) };
    });
    rows.sort((a, b) => b.rrf - a.rrf || a.e - b.e || a.idx - b.idx);
    const ranked = rows.slice(0, TOP_N).map((r) => ({
      id: ctx.corpus.items[r.idx].id,
      score: r.rrf,
      parts: { rrf: r.rrf, d: dg.prob.get(r.idx), dRank: r.d, emb: pf.cos.get(r.idx), embRank: r.e, bm25Rank: r.b, threadRank: pf.threadRank.get(r.idx) ?? null },
    }));
    return { ranked: fillFromEmbeddings(ranked, ctx.corpus, pf.emb, pf.cos) };
  },
};
