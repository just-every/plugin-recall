import { defaultPipeline } from "./default.mjs";
import { listwiseScores } from "./listwise.mjs";

export const listwisePipeline = {
  name: "default+listwise",
  gate: defaultPipeline.gate,
  async run(ctx) {
    const base = (await defaultPipeline.run(ctx)).ranked;
    const head = base.slice(0, 24);
    const ps = await listwiseScores(ctx, head.map((h) => ctx.corpus.items[ctx.corpus.byId.get(h.id)]));
    const position = new Map(head.map((h, i) => [h.id, i]));
    head.sort((a, b) => ps.get(b.id) - ps.get(a.id) || position.get(a.id) - position.get(b.id));
    return { ranked: [...head, ...base.slice(24)].map((h, i) => ({
      ...h, score: base.length - i, parts: { ...h.parts, ...(ps.has(h.id) ? { listwise: ps.get(h.id) } : {}) },
    })) };
  },
};
