// First stage of the tuned default pipeline: the full embedding, BM25 and same-thread rankings of the eligible history, and the prefilter that the
// Decisions stage scores: embeddings top 150 UNION BM25 top 60 UNION the 30 newest same-thread statements (about 200 items).
// Reference: the research prototype's `recall`. Positions are indices into the corpus, which is sorted by
// (time, id), so "ties by position" is "ties by time". The BM25 top 60 is taken as the reference takes it, whatever the scores.
import { clip } from "../text.mjs";
import { rankByBm25, rankByEmbedding } from "../corpus.mjs";
import { SPEC } from "./spec.mjs";

/** Memoised per context so every stage of one query embeds it and ranks once. */
export async function prefilter(ctx) {
  if (ctx.memo.prefilter) return ctx.memo.prefilter;
  const run = (async () => {
    const t0 = performance.now();
    const qvec = await ctx.deps.embedQuery(clip(ctx.situation, SPEC.embeddingTextClip));
    const emb = rankByEmbedding(ctx.corpus, ctx.eligible, qvec);
    const bm25 = rankByBm25(ctx.corpus, ctx.eligible, ctx.situation);
    // same thread, newest first (ties: later position first); `eligible` is ascending in (time, id)
    const thread = ctx.threadId == null ? [] : [...ctx.eligible].reverse().filter((i) => ctx.corpus.items[i].session_id === ctx.threadId);
    const embRank = new Map(emb.map((r, k) => [r.idx, k + 1]));
    const cos = new Map(emb.map((r) => [r.idx, r.score]));
    const bm25Rank = new Map(bm25.map((r, k) => [r.idx, k + 1]));
    const threadRank = new Map(thread.map((idx, k) => [idx, k + 1]));
    const candidates = [...new Set([...emb.slice(0, SPEC.embeddingsTop).map((r) => r.idx), ...bm25.slice(0, SPEC.bm25Top).map((r) => r.idx), ...thread.slice(0, SPEC.sameThreadTop)])].sort((a, b) => a - b);
    ctx.stats.prefilterMs = performance.now() - t0;
    ctx.stats.prefilterSize = candidates.length;
    return { emb, bm25, embRank, cos, bm25Rank, threadRank, candidates };
  })();
  ctx.memo.prefilter = run;
  return run;
}
