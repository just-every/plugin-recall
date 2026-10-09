// The cross-validated sessions winner. Every fold chose S32 and the emb25 combiner; no parameters are fitted at query time.
import { defaultPipeline } from "./default.mjs";
import { genericQuestion, scoreItems } from "./questions.mjs";
import { TOP_N } from "./rank.mjs";
import { SESSION_SPEC } from "./sessions-nodes.mjs";
import { sessionRoutes } from "./sessions-routing.mjs";

/** Full eligible ranking, including refused/unexpanded leaves after all numeric-scored leaves. */
export function rankSessionItems(ctx, routing, probabilities) {
  const scored = [];
  const scoredIndices = new Set();
  for (const idx of routing.candidates) {
    const item = ctx.corpus.items[idx];
    const p = probabilities.get(item.id);
    if (p === undefined) throw new Error(`Missing session item score ${item.id}`);
    if (p === null) continue;
    const node = routing.nodeProbability.get(idx);
    if (node === null || node === undefined) throw new Error(`Cannot expand unscored session node for ${item.id}`);
    const embRank = routing.embRank.get(idx);
    const score = .75 * (p + node) / 2 + .25 / Math.log2(embRank + 1);
    scoredIndices.add(idx);
    scored.push({ id: item.id, score, parts: { d: p, node, nodeRank: routing.nodeRank.get(idx), emb: routing.cos.get(idx), embRank } });
  }
  scored.sort((a, b) => b.score - a.score || a.parts.embRank - b.parts.embRank);
  for (const { idx, score: cosine } of routing.emb) {
    if (scoredIndices.has(idx)) continue;
    const embRank = routing.embRank.get(idx);
    scored.push({
      id: ctx.corpus.items[idx].id, score: -1 - embRank / (routing.emb.length + 1),
      parts: { d: probabilities.get(ctx.corpus.items[idx].id) ?? undefined, node: routing.nodeProbability.get(idx), nodeRank: routing.nodeRank.get(idx) ?? null, emb: cosine, embRank },
    });
  }
  return scored;
}

export const sessionsPipeline = {
  name: "sessions",
  gate: defaultPipeline.gate,
  async run(ctx) {
    const routing = await sessionRoutes(ctx);
    const items = routing.candidates.map((idx) => ctx.corpus.items[idx]);
    const probabilities = await scoreItems(ctx, items, genericQuestion, "sessions-items", { packSize: SESSION_SPEC.packSize });
    const refused = [...probabilities.values()].filter((p) => p === null).length;
    ctx.stats.refused = (ctx.stats.refused ?? 0) + refused;
    ctx.stats.sessionItemRefusals = refused;
    return { ranked: rankSessionItems(ctx, routing, probabilities).slice(0, TOP_N) };
  },
};
