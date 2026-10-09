// The listwise questions, reused by P4 and the composition model. Values describe slots, not item IDs.
import { clip } from "../text.mjs";
import { itemLine } from "./questions.mjs";

export const LISTWISE_TEXT = "Which of these past owner statements is it most important for the assistant to know to handle the situation above correctly?";
/** @param {object} cfg the config: itemGist puts each statement's gist in its option */
export function listwiseQuestions(items, cfg = {}) {
  return [false, true].map((reverse) => ({
    type: "choice", name: `list_${+reverse}`, instructions: LISTWISE_TEXT,
    choices: (reverse ? [...items].reverse() : items).map((item, slot) => ({ value: `C${slot}`, description: cfg.itemGist ? itemLine(item, cfg) : clip(item.text, 260) })),
  }));
}

export async function listwiseScores(ctx, items) {
  if (!ctx.deps.scoreChoices) throw new Error("Decisions listwise pipeline requires deps.scoreChoices");
  const t0 = performance.now();
  const result = await ctx.deps.scoreChoices({ input: ctx.situation, questions: listwiseQuestions(items, ctx.cfg), label: "listwise" });
  ctx.stats.listwiseMs = (ctx.stats.listwiseMs ?? 0) + performance.now() - t0;
  ctx.stats.costUsd = (ctx.stats.costUsd ?? 0) + result.costUsd;
  ctx.stats.requests = (ctx.stats.requests ?? 0) + (result.requests ?? 1);
  ctx.stats.cachedRequests = (ctx.stats.cachedRequests ?? 0) + (result.cachedRequests ?? (result.cached ? 1 : 0));
  ctx.stats.cacheHits = (ctx.stats.cacheHits ?? 0) + (result.cacheHits ?? 0);
  ctx.stats.questions = (ctx.stats.questions ?? 0) + 2;
  if (result.answers.length !== 2) throw new Error("listwise requires two answers");
  const ps = result.answers.map((answer) => {
    if (answer.type !== "choice") throw new Error(`listwise answer ${answer.name}: ${answer.type}; cannot rank`);
    const p = new Map(answer.probabilities.map((v) => [v.value, v.probability]));
    if (p.size !== items.length || answer.probabilities.length !== items.length) throw new Error("invalid listwise option coverage");
    for (let i = 0; i < items.length; i++) {
      const n = p.get(`C${i}`);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error("invalid listwise probability");
    }
    return p;
  });
  return new Map(items.map((item, i) => [item.id, (ps[0].get(`C${i}`) + ps[1].get(`C${items.length - 1 - i}`)) / 2]));
}
