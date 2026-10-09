// Pipeline "embeddings": cosine top-k of the eligible history against the situation's embedding. The baseline every other pipeline is
// measured against (the prototype's "embeddings": the query is clip(situation, 6000)).
import { prefilter } from "./prefilter.mjs";
import { TOP_N } from "./rank.mjs";

export const embeddingsPipeline = {
  name: "embeddings",
  // Injection gate: the cosine itself (there is no judge to ask).
  gate: (entry, cfg) => entry.parts.emb >= cfg.embThreshold,
  async run(ctx) {
    const pf = await prefilter(ctx);
    const ranked = pf.emb.slice(0, TOP_N).map((r, k) => ({ id: ctx.corpus.items[r.idx].id, score: r.score, parts: { emb: r.score, embRank: k + 1 } }));
    return { ranked };
  },
};
