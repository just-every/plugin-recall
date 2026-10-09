import { prefilter } from "./prefilter.mjs";
import { scoreItems } from "./questions.mjs";
import { makeSessionNodes, SESSION_SPEC } from "./sessions-nodes.mjs";

/** Score every root, without leaf scoring. Shared by sessions and compose within one query. */
export async function sessionRoutes(ctx) {
  if (ctx.memo.sessionRoutes) return ctx.memo.sessionRoutes;
  const run = (async () => {
    const { emb, embRank, cos } = await prefilter(ctx);
    const nodes = makeSessionNodes(ctx.corpus, ctx.eligible, embRank);
    const probabilities = await scoreItems(ctx, nodes, (n) => ({ name: n.id, instructions: n.instructions }), "sessions-nodes", { packSize: SESSION_SPEC.packSize });
    const scored = nodes.map((n) => {
      const p = probabilities.get(n.id);
      if (p === undefined) throw new Error(`Missing session node score ${n.id}`);
      return { ...n, p };
    });
    const validNodes = scored.filter((n) => n.p !== null);
    validNodes.sort((a, b) => b.p - a.p || a.embRank - b.embRank || a.id.localeCompare(b.id));
    const selectedNodes = validNodes.slice(0, SESSION_SPEC.topNodes);
    const nodeProbability = new Map(scored.flatMap((n) => n.indices.map((idx) => [idx, n.p])));
    const nodeRank = new Map(validNodes.flatMap((n, k) => n.indices.map((idx) => [idx, k + 1])));
    const candidates = selectedNodes.flatMap((n) => n.indices);
    const refused = nodes.length - validNodes.length;
    ctx.stats.refused = (ctx.stats.refused ?? 0) + refused;
    ctx.stats.sessionNodes = nodes.length;
    ctx.stats.sessionNodeRefusals = refused;
    ctx.stats.sessionExpandedNodes = selectedNodes.length;
    ctx.stats.sessionCandidates = candidates.length;
    return { nodes: scored, validNodes, selectedNodes, nodeProbability, nodeRank, candidates, emb, embRank, cos };
  })();
  ctx.memo.sessionRoutes = run;
  return run;
}
