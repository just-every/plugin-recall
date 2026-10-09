// The apply gate: a second Decisions predicate over the statements that survived everything else (D-generic at the injection bar, every
// eligibility rule, noRepeat, hubs, duplicates), in their fused order. Experiment x10 found that "does this statement apply to the task being
// done now, not just the same topic?" separates useful cards from misleading ones far better than D-generic's probability does (AUC 0.75 against 0.53).
// The survivors are reranked by that probability and the first k at `applyThreshold` or more are injected. This is a precision gate:
// a refused or unanswered question cannot pass, and when the stage cannot answer (deadline, cap, API error) the caller injects nothing.
//
// The question and the statement line are x10's `apply@g` exactly (experiments/x10-usefulness-gate/scripts/questions.mjs): the situation
// is the request input, and the predicate is `Past owner statement (said while <gist>): "<text>"` + newline + the question.
import { itemLine, scoreItems } from "./pipelines/questions.mjs";
import { SPEC } from "./pipelines/spec.mjs";
import { situationOf } from "./situations.mjs";

/** The question, word for word as x10 scored it. */
export const APPLY_TEXT = "Does this past owner statement apply to the task the assistant is doing right now, not just the same topic?";
/** The gate always shows the card's gist (D-generic does not: its itemGist stays off). */
const WITH_GIST = Object.freeze({ itemGist: true });
/** The most survivors a turn-log line records (the ranked list holds 50, so this is every survivor in practice). */
export const GATE_LOG_MAX = 50;

/** The predicate for one surviving statement (a corpus item that carries its card). The name is x10's `<id>|apply@g`. */
export const applyQuestion = (item) => ({ name: `${item.id}|apply@g`, instructions: `${itemLine(item, WITH_GIST)}\n${APPLY_TEXT}` });

/** A probability that may pass: a number the API answered. A refusal (null) or a missing answer (undefined) is not one. */
const answered = (p) => typeof p === "number" && Number.isFinite(p);

/**
 * Ask the apply question for every survivor in one request (at most 200 questions per request; more are packed), then select.
 * @param {{entries: {id: string}[], corpus: object, situation: string, deps: {scorePredicates: Function}, k: number, threshold: number, stats?: object}} o
 *   entries    the survivors in their fused order; each one's corpus item must carry its card
 *   situation  the situation text the hook built for D-generic
 *   stats      receives questions, requests, cacheHits, costUsd, decisionsMs, and refused (the survivors without a probability)
 * @returns {Promise<{picked: object[], rows: {id: string, p: number|null, pass: boolean}[]}>} picked: the entries that pass, best probability first,
 *   at most k (ties keep the fused order); rows: every survivor in the fused order with its probability (null = refused or unanswered) and whether it passed
 *   the threshold (before the k cut)
 */
export async function applyGate({ entries, corpus, situation, deps, k, threshold, stats = {} }) {
  const items = entries.map((e) => corpus.items[corpus.byId.get(e.id)]);
  // The statement line carries the card's gist, so a statement without a card cannot be asked about: unanswered, it cannot pass. (With the card
  // filter on every eligible statement has a card; this is only the v1 settings with the gate switched on.)
  const askable = items.filter((it) => it.card);
  const probs = askable.length ? await scoreItems({ deps, situation: situationOf(situation, "prompt"), stats }, askable, applyQuestion, "apply-gate", { packSize: SPEC.maxQuestionsPerRequest }) : new Map();
  const rows = entries.map((e, i) => {
    const p = probs.get(items[i].id);
    return { entry: e, id: e.id, p: answered(p) ? p : null, pass: answered(p) && p >= threshold, order: i };
  });
  stats.refused = rows.filter((r) => r.p === null).length;
  const picked = rows.filter((r) => r.pass).sort((a, b) => b.p - a.p || a.order - b.order).slice(0, k).map((r) => r.entry);
  return { picked, rows: rows.map(({ id, p, pass }) => ({ id, p, pass })) };
}

/** The turn-log record of one gate run: the settings, the counts and each survivor's probability (3 decimals) and verdict. Bounded. */
export function gateRecord({ rows, picked, threshold, k, stats, ms }) {
  return {
    threshold, k, survivors: rows.length, passed: rows.filter((r) => r.pass).length, selected: picked.length, refused: stats.refused ?? 0,
    questions: stats.questions ?? 0, requests: stats.requests ?? 0, cachedRequests: stats.cachedRequests ?? 0, cacheHits: stats.cacheHits ?? 0,
    costUsd: stats.costUsd ?? 0, ms: Math.round(ms),
    rows: rows.slice(0, GATE_LOG_MAX).map((r) => ({ id: r.id, p: r.p === null ? null : Math.round(r.p * 1000) / 1000, pass: r.pass })),
  };
}
