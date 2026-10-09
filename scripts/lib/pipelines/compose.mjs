import { prefilter } from './prefilter.mjs';
import { sessionRoutes } from './sessions-routing.mjs';
import { hydeRanking } from './hyde.mjs';
import { durableProbabilities } from './durable.mjs';
import { genericQuestion, scoreItems } from './questions.mjs';
import { listwiseScores } from './listwise.mjs';
import { COMPOSE_SPEC, composeScore, inverseLogRank, blendCompose } from './compose-model.mjs';
import { TOP_N } from './rank.mjs';
import { defaultPipeline } from './default.mjs';

/** The channel union is made only from the shared, prefiltered eligible history. */
export function composeCandidates(eligible, pf, routes, hyde, durable, lean = false) {
  const constants = COMPOSE_SPEC.constants;
  return eligible.filter(idx =>
    (routes.nodeRank.get(idx) ?? Infinity) <= constants.sessionsTop ||
    pf.embRank.get(idx) <= constants.embeddingsTop ||
    pf.bm25Rank.get(idx) <= constants.bm25Top ||
    (!lean && ((hyde.rank.get(idx) ?? Infinity) <= constants.hydeTop ||
      (durable.get(idx) !== null && durable.get(idx) !== undefined && durable.get(idx) >= constants.durableThreshold))));
}

export async function composeLinear(ctx, lean = false) {
  const [pf, routes, hyde, durable] = await Promise.all([
    prefilter(ctx), sessionRoutes(ctx),
    lean ? null : hydeRanking(ctx),
    lean ? null : durableProbabilities(ctx),
  ]);
  const candidates = composeCandidates(ctx.eligible, pf, routes, hyde, durable, lean);
  const probabilities = await scoreItems(ctx, candidates.map(idx => ctx.corpus.items[idx]), genericQuestion, 'compose-generic', { packSize: 200 });
  const recency = [...ctx.eligible].sort((a, b) => ctx.corpus.items[b].micros - ctx.corpus.items[a].micros || a - b);
  const recencyRank = new Map(recency.map((idx, j) => [idx, j + 1]));
  const model = COMPOSE_SPEC.pipelines[lean ? 'compose-lean' : 'compose'];
  const rows = candidates.map(idx => {
    const item = ctx.corpus.items[idx];
    const d = probabilities.get(item.id);
    if (d === undefined) throw new Error(`Missing compose generic answer for ${item.id}`);
    const raw = {
      d, node: routes.nodeProbability.get(idx),
      embedding: inverseLogRank(pf.embRank.get(idx)), bm25: inverseLogRank(pf.bm25Rank.get(idx)),
      hyde: lean ? null : inverseLogRank(hyde.rank.get(idx)), durable: lean ? null : durable.get(idx),
      same_thread: Number(item.session_id === ctx.threadId), recency: inverseLogRank(recencyRank.get(idx)),
    };
    return { id: item.id, idx, linear: composeScore(raw, model), parts: {
      d, node: raw.node, emb: pf.cos.get(idx), embRank: pf.embRank.get(idx), bm25Rank: pf.bm25Rank.get(idx),
      hydeRank: lean ? null : (hyde.rank.get(idx) ?? null), durable: raw.durable,
      nodeRank: routes.nodeRank.get(idx) ?? null, recencyRank: recencyRank.get(idx),
    } };
  }).sort((a, b) => b.linear - a.linear || a.idx - b.idx);
  ctx.stats.composeCandidates = candidates.length;
  ctx.stats.refused = (ctx.stats.refused ?? 0) + rows.filter(row => row.parts.d === null).length;
  return rows;
}

export function makeComposePipeline(name, lean) {
  return {
    name, gate: defaultPipeline.gate,
    async run(ctx) {
      const linear = await composeLinear(ctx, lean);
      const head = linear.slice(0, COMPOSE_SPEC.constants.listwiseTop);
      const probabilities = await listwiseScores(ctx, head.map(row => ctx.corpus.items[row.idx]));
      const blended = blendCompose(head, probabilities, COMPOSE_SPEC.constants.listwiseWeight);
      const ordered = [...blended, ...linear.slice(head.length)];
      return { ranked: ordered.slice(0, TOP_N).map((row, j) => ({
        id: row.id, score: 1 / (j + 1),
        parts: { ...row.parts, linear: row.linear, listwise: row.listwise ?? null, blend: row.blend ?? null },
      })) };
    },
  };
}

export const composePipeline = makeComposePipeline('compose', false);
