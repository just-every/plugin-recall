// Pipeline "default+rerank": the default fusion's top 20 reordered by the prototype's listwise judgement from a codex CLI worker
// (on your own CLI login; routed through router.mjs). A listwise call takes many seconds, so this
// is an experiment arm, not a hook pipeline. No eligible home, a timeout or a malformed answer THROWS: the order is never faked.
import { defaultPipeline } from "./default.mjs";
import { TOP_N } from "./rank.mjs";
import { clip } from "../text.mjs";

export const RERANK_N = 20;
export const RERANK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["order"],
  properties: { order: { type: "array", items: { type: "string" } } },
};
export const candidateLabel = (k) => `m${String(k + 1).padStart(2, "0")}`;

/** The prototype's cliPrompt, including the 260-character statement clip. */
export function rerankPrompt(query, items) {
  const lines = items.map((it, i) => `[${candidateLabel(i)}] ${clip(it.text, 260)}`).join("\n");
  return `You help an AI coding agent decide which of its owner's past statements matter right now.

${query}

CANDIDATE PAST OWNER STATEMENTS (${items.length}, in no particular order):
${lines}

Task: rank ALL ${items.length} candidates from most to least important for the agent to know in order to handle the situation above correctly. A statement is important when it is an instruction, constraint, correction or preference of the owner that applies to what the agent is doing or about to do and that the agent could otherwise get wrong. Judge only from the texts above.
Return JSON {"order": [...]} listing every candidate id (${candidateLabel(0)} to ${candidateLabel(items.length - 1)}) exactly once, most important first.`;
}

export function validateOrder(order, n) {
  const labels = new Map(Array.from({ length: n }, (_, i) => [candidateLabel(i), i]));
  if (!Array.isArray(order) || order.length !== n || new Set(order).size !== n || order.some((id) => !labels.has(id))) {
    throw new Error(`invalid CLI rerank ordering: expected each of ${n} candidate labels exactly once`);
  }
  return order.map((id) => labels.get(id));
}

export const rerankPipeline = {
  name: "default+rerank",
  gate: defaultPipeline.gate,
  async run(ctx) {
    if (!ctx.deps.rerank) throw new Error("pipeline default+rerank needs deps.rerank (a CLI worker); none is configured");
    const base = (await defaultPipeline.run(ctx)).ranked;
    const head = base.slice(0, RERANK_N);
    const byId = new Map(ctx.corpus.items.map((it) => [it.id, it]));
    const t0 = performance.now();
    const order = await ctx.deps.rerank({ prompt: rerankPrompt(ctx.situation, head.map((h) => byId.get(h.id))), schema: RERANK_SCHEMA, n: head.length, kind: "codex" });
    ctx.stats.rerankMs = performance.now() - t0;
    const picked = validateOrder(order, head.length).map((i) => head[i]);
    const top = picked.length;
    const ranked = picked.map((h, k) => ({ id: h.id, score: top - k, parts: { ...h.parts, rerankRank: k + 1 } }));
    return { ranked: [...ranked, ...base.slice(RERANK_N).map((h, k) => ({ ...h, score: -1 - k }))].slice(0, TOP_N) };
  },
};

/** P3 uses the same implementation; retain the existing public name for compatibility. */
export const codexPipeline = { ...rerankPipeline, name: "default+codex" };
