// Per-case conversation context of `recall eval`: {project, prior:[{role, text}]} lets a case build the v2 prompt-time situation (the same
// function the hook uses) from what a transcript would have given it.
import { priorContext } from "./transcripts/tail.mjs";
import { contextSituation, PROMPT_HEAD } from "./situations.mjs";

const ROLES = { user: "user", owner: "user", assistant: "assistant" };

export function validateContext(context, caseId) {
  const bad = (m) => { throw new Error(`case ${caseId}: context ${m}`); };
  if (context === undefined) return;
  if (context === null || typeof context !== "object" || Array.isArray(context)) bad("must be an object {project, prior}");
  if (!(context.project === undefined || context.project === null || (typeof context.project === "string" && context.project))) bad("project must be a repo name, null or absent");
  if (!(context.prior === undefined || Array.isArray(context.prior))) bad("prior must be an array of {role, text}");
  for (const [i, t] of (context.prior ?? []).entries()) {
    if (!t || !(t.role in ROLES) || typeof t.text !== "string" || !t.text.trim()) bad(`prior[${i}] must be {role: user|owner|assistant, text: a non-empty string}`);
  }
}

/** The owner's message of a prompt-mode case: the bare query, or the OWNER line of the prompt situation. Anything else is not a prompt message. */
export function ownerMessageOf(query, caseId) {
  const q = String(query);
  if (!/^\s*SITUATION\b/.test(q)) return q;
  const prefix = `${PROMPT_HEAD}\n\nOWNER: `;
  if (!q.startsWith(prefix)) throw new Error(`case ${caseId}: the query is a situation that is not the prompt-time layout, so the v2 situation cannot be built from it`);
  return q.slice(prefix.length);
}

/**
 * The situation a case is retrieved with: with queryContext on, a prompt-mode case that carries `context` gets the v2 situation; every
 * other case keeps its query (the retrieval core wraps a bare text in v1's layout).
 */
export function caseQuery(c, cfg) {
  if (!cfg.queryContext || c.mode !== "prompt" || !c.context) return c.query;
  const turns = (c.context.prior ?? []).map((t) => ({ role: ROLES[t.role], text: t.text }));
  const ownerText = ownerMessageOf(c.query, c.case_id);
  const { prevOwner, assistant } = priorContext(turns, ownerText);
  return contextSituation({ project: c.context.project ?? null, prevOwner, assistant, ownerText });
}
