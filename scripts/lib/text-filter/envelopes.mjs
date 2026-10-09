// Envelopes that wrap what a person typed, and the peeling that takes them off. A transcript turn is rarely the bare sentence: hosts and
// harnesses add system reminders, command wrappers, attachment headers, browser-comment headers and dictation wrappers around it, and the
// desktop apps their own (desktop.mjs). Peeling keeps the person's words and removes the envelope; it never drops a turn (that is the job of
// harness.mjs and the profiles).
import { peelAppEnvelope, peelQuoteReply } from "./desktop.mjs";

/** Collapse whitespace so the same request typed twice hashes to one id. */
export function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// Removed whole, in this order.
const STRIP_BLOCKS = [
  // A fenced block pasted into a turn (an agent's report, a diff, a page of output): the sentence around it is the person's, the fence is not.
  // A turn that is nothing but a fence falls to the length floor.
  /```[\s\S]*?```/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi,
  /<command-message>[\s\S]*?<\/command-message>/gi,
  /<command-name>[\s\S]*?<\/command-name>/gi,
  /<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi,
  /<environment_context>[\s\S]*?<\/environment_context>/gi,
  /<user_instructions>[\s\S]*?<\/user_instructions>/gi,
  // The running transcript a realtime (voice) turn carries beside the sentence just said: the delta repeats the person's fragments
  // interleaved with the assistant's replies, so kept, it reads as the model's words in their mouth. The closer is optional: the delta is
  // always last, and a turn cut short by a length bound loses it. It goes first so the wrapper peel below finds a matched pair.
  /<transcript_delta>[\s\S]*?(?:<\/transcript_delta>|$)/gi,
  // The name of the realtime pipe that produced the turn.
  /<source>[\s\S]*?<\/source>/gi,
  // Codex's ambient UI state (which tabs the in-app browser has open). The block says of itself that it is not part of the request; the
  // request follows it under `## My request:`, which ENVELOPE_HEAD peels.
  /<in-app-browser-context\b[\s\S]*?<\/in-app-browser-context>/gi,
  // Text selected out of an earlier reply and handed back as JSON: the model's own prose quoted to itself.
  /<response-annotations>[\s\S]*?<\/response-annotations>/gi,
  // Every Code's multi-agent commands (`/plan`, `/code`, `/solve` of its 2025 versions) expanded into a long prompt for the agents; the
  // person's task is what follows its last heading (`Task to plan:`, `Coding task to perform:`, `Problem to solve:`).
  /^\s*(?:Create a comprehensive plan by leveraging multiple|Perform a coding task with multiple LLMs|Solve a complicated problem by starting multiple agents)\b[\s\S]*?\n(?:Task to plan|Coding task to perform|Problem to solve):[ \t]*/i,
];

// Unwrapped: the inner text is kept. `<command-args>` carries what the person typed after a slash command.
const UNWRAP = [
  /<command-args>([\s\S]*?)<\/command-args>/gi,
  /<realtime_delegation>([\s\S]*?)<\/realtime_delegation>/gi,
];

const IMAGE_NOTE = /the next image is untrusted page evidence[\s\S]*?(?:marked by comment marker \d+\.|$)/gi;
// The attachment tag itself, wherever it sits: a path, not a sentence.
const ATTACHMENT_TAG = /<image\b[^>]*>\s*(?:<\/image>)?/gi;

// The same wrappers with one half missing (a turn cut by a length bound keeps the opener and loses the closer). Only the head and the tail
// are stripped, and only these tag names: a loose `<input>` mid-sentence is the person writing about a form field.
const WRAPPER_TAGS = "realtime_delegation|input|command-args|transcription|dictation";
const WRAPPER_HEAD = new RegExp(`^\\s*<(?:${WRAPPER_TAGS})>\\s*`, "i");
const WRAPPER_TAIL = new RegExp(`\\s*</(?:${WRAPPER_TAGS})>\\s*$`, "i");

/**
 * Peel every envelope off a raw turn: the normalized text that is left, and the desktop-app peels that fired ("codex-app-envelope",
 * "quote-reply"), which the index counts its statements by.
 * @returns {{text: string, peeled: string[]}}
 */
export function peel(raw) {
  let text = String(raw ?? "");
  const peeled = [];
  for (const pattern of UNWRAP) text = text.replace(pattern, (_, inner) => `\n${inner}\n`);
  for (const pattern of STRIP_BLOCKS) text = text.replace(pattern, " ");
  // A quote reply loses its markers and quoted lines while the turn still has its lines.
  const quote = peelQuoteReply(text);
  if (quote.peeled) { text = quote.text; peeled.push("quote-reply"); }
  // The Codex app's envelope comes off before anything else looks at the turn, so a heading rule does not read its sections as a brief.
  const app = peelAppEnvelope(text);
  if (app.peeled) { text = app.text; peeled.push("codex-app-envelope"); }
  // The attachment envelope is unwrapped, not dropped: a screenshot plus a question is one of the most useful turns there is.
  text = text.replace(ATTACHMENT_TAG, " ").replace(IMAGE_NOTE, " ");
  text = normalize(text);
  // A wrapper can nest (`<realtime_delegation> <input>`): peel until the text starts and ends with the person's own sentence.
  for (let more = true; more;) {
    const before = text;
    text = normalize(text.replace(WRAPPER_HEAD, "").replace(WRAPPER_TAIL, ""));
    more = text !== before;
  }
  return { text, peeled };
}
