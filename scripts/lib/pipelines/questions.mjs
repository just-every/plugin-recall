// The Decisions questions. The D-generic question and layout are the research prototype's: a "transposed" pack puts ONE shared input (the situation) in
// the request and one predicate per past statement (the statement in the question text). Questions are independent in the API, so
// packing never changes an answer. With itemGist (v2) each statement line says what was going on when it was said (its card's gist).
import { clip } from "../text.mjs";
import { SPEC } from "./spec.mjs";

export const ITEM_CLIP = SPEC.itemClip; // chars of a past statement placed in a question

/** The D-generic question, word for word. */
export const GENERIC_TEXT = "Is this past owner statement important for handling the situation above correctly?";
/**
 * The line that shows one past statement to the judge: the prototype's `Past owner statement: "<text>"`, or with itemGist
 * `Past owner statement (said while <gist>): "<text>"`. A statement without a card cannot be shown that way: loud, never the v1 line.
 */
export function itemLine(item, cfg) {
  if (!cfg?.itemGist) return `Past owner statement: "${clip(item.text, ITEM_CLIP)}"`;
  if (!item.card) throw new Error(`itemGist needs a card for statement ${item.id}; run recall enrich, or pass --cards`);
  return `Past owner statement (said while ${item.card.gist}): "${clip(item.text, ITEM_CLIP)}"`;
}
export const genericQuestion = (item, ctx) => ({ name: item.id, instructions: `${itemLine(item, ctx?.cfg)}\n${GENERIC_TEXT}` });

/**
 * Score each item against the situation. The API resolves cached questions before packing the misses (32 requests concurrently).
 * @returns {Promise<Map<string, number|null>>} item id -> probability (null = the API refused that question)
 */
export async function scoreItems(ctx, items, questionOf, label, { packSize = SPEC.packSize } = {}) {
  const t0 = performance.now();
  const r = await ctx.deps.scorePredicates({ input: ctx.situation, questions: items.map((it) => questionOf(it, ctx)), label, packSize });
  ctx.stats.decisionsMs = (ctx.stats.decisionsMs ?? 0) + (performance.now() - t0);
  ctx.stats.requests = (ctx.stats.requests ?? 0) + (r.requests ?? 1);
  ctx.stats.cachedRequests = (ctx.stats.cachedRequests ?? 0) + (r.cachedRequests ?? (r.cached ? 1 : 0));
  ctx.stats.cacheHits = (ctx.stats.cacheHits ?? 0) + (r.cacheHits ?? 0);
  ctx.stats.costUsd = (ctx.stats.costUsd ?? 0) + r.costUsd;
  ctx.stats.questions = (ctx.stats.questions ?? 0) + items.length;
  return new Map(items.map((it, j) => [it.id, r.probabilities[j]]));
}
