// The "situation": the one shared input of every Decisions question of a query, and the text that is embedded and BM25-ranked.
// Layouts are the measured ones of the research prototype (see docs/x3-pipeline.json, query).
import { plainProse } from "./plain-prose.mjs";
import { clip } from "./text.mjs";

export const STOP_HEAD = "SITUATION (conversation so far, newest last):";
export const PROMPT_HEAD = "SITUATION (the owner's latest message, before the agent has acted):";
export const TURN_CLIP = 500;
export const LATEST_CLIP = 1500;
// v2 prompt-time situation (queryContext): the project, the previous owner message, the last assistant reply, then the new message.
// The two earlier parts are prose only (no fenced code, tool output, file dumps or URLs: plain-prose.mjs) and short; v2.0 clipped the reply to
// 800 characters of whatever it held, and the Decisions API refused far more questions with it (about 25 times as many in one measurement).
export const PREV_OWNER_CLIP = 300;
export const ASSISTANT_CLIP = 400;

/** UserPromptSubmit: only the owner's message exists yet. */
export const promptSituation = (ownerText) => `${PROMPT_HEAD}\n\nOWNER: ${clip(ownerText, LATEST_CLIP)}`;

/**
 * v2 prompt time (queryContext): what the agent was in the middle of when the owner wrote the new message. A part that does not exist (the
 * first message of a session has no earlier owner message or reply, or one that was only code or links) is left out, never invented.
 * @param {{project: string|null, prevOwner?: string|null, assistant?: string|null, ownerText: string}} o
 */
export function contextSituation({ project, prevOwner = null, assistant = null, ownerText }) {
  const earlier = plainProse(prevOwner);
  const reply = plainProse(assistant);
  const parts = [
    ...(project ? [`PROJECT: ${project}`] : []),
    ...(earlier ? [`OWNER (earlier): ${clip(earlier, PREV_OWNER_CLIP)}`] : []),
    ...(reply ? [`ASSISTANT: ${clip(reply, ASSISTANT_CLIP)}`] : []),
    `OWNER (latest message, before the agent has acted): ${clip(ownerText, LATEST_CLIP)}`,
  ];
  return `${STOP_HEAD}\n\n${parts.join("\n\n")}`;
}

/**
 * The conversation layout of the research prototype: the last (up to) two conversation turns before the agent's final message, then the message.
 * @param {{role: "user"|"assistant", text: string}[]} turns older first; only the last two are used
 */
export function stopSituation(turns, assistantText) {
  const tail = turns.slice(-2).map((t) => `${t.role === "user" ? "OWNER" : "ASSISTANT"}: ${clip(t.text, TURN_CLIP)}`);
  return `${STOP_HEAD}\n\n${[...tail, `ASSISTANT (latest message): ${clip(assistantText, LATEST_CLIP)}`].join("\n\n")}`;
}

/**
 * The situation of a query. A query that already starts with SITUATION (an eval case, the prototype's own layout) is used as is; a bare text is
 * wrapped in the layout of its mode.
 */
export function situationOf(query, mode) {
  const q = String(query);
  if (/^\s*SITUATION\b/.test(q)) return q;
  return mode === "stop" ? stopSituation([], q) : promptSituation(q);
}
