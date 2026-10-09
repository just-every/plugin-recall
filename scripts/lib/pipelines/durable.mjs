export { DURABILITY_TEXT, DURABILITY_CLIP } from '../durable-store.mjs';

/** Queries only read the offline index, including during cold cache benchmarks. */
export async function durableProbabilities(ctx) {
  if (ctx.memo.durable) return ctx.memo.durable;
  const run = (async () => {
    if (!ctx.deps.loadDurable) throw new Error('compose requires an offline durability index; run recall index --durable first');
    const items = ctx.eligible.map(idx => ctx.corpus.items[idx]);
    const probabilities = await ctx.deps.loadDurable(items);
    const out = new Map();
    for (const idx of ctx.eligible) {
      const item = ctx.corpus.items[idx];
      const p = probabilities.get(item.id);
      if (p !== null && (!Number.isFinite(p) || p < 0 || p > 1)) throw new Error(`Missing or invalid offline durability for ${item.id}`);
      out.set(idx, p);
    }
    return out;
  })();
  ctx.memo.durable = run;
  return run;
}
