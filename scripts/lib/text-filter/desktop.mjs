// The envelopes the desktop apps write around what a person typed. Each peel keeps the person's words, removes the app's, and says whether it
// fired (the index counts its statements by peel).
//
// Codex app (desktop and IDE). A turn is the context the app attached, as top-level sections, then the app's own heading
// `## My request for Codex:` (`## My request:` in earlier versions) and what was typed under it:
//   # Files mentioned by the user:            ## <name>: <path>, per attached file or screenshot
//   # Applications mentioned by the user:     an <appshot> of a window's accessibility tree
//   # In app browser: / # In app browser (IAB):   "The user has the in-app browser open with 1 tab.", "Current URL: ..."
//   # Selected text:                          ## Selection N, text selected in a reply or a file
//   # Response annotations:                   a <response-annotations> JSON block of a reply's selected text
//   # Review findings:                        ## Finding N (<file>:<lines>), a review's findings
//   # Browser comments: / # Diff comments:    ## Comment N (or User Comment N): File:, Lines:, Target:, ... and `Comment:` <what was written>
//   <in-app-browser-context>                  the same browser state as a block that says of itself it is not part of the request
// Only two things in it are the person's: what is under the request heading, and the `Comment:` of each browser or diff comment. (The review
// command's turn, `## Code review guidelines:` ... `## My request for Codex:`, is the app's from end to end, its request included: one canned
// line in 21 of the 22 measured; owner-filter.mjs drops it.)
//
// Claude desktop app. A reply to a passage of an earlier message arrives as `<!-- reply -->` (`<!-- reply 2 -->`, or `<!-- attach -->` for an
// attached passage), the passage as `>` quoted lines, then what was typed; a turn can carry several. The markers and the quoted lines are the
// app's and the agent's; every other line is the person's.

const APP_SECTION = /^\s*(?:#+\s*(?:files (?:mentioned|pasted) by the user|applications mentioned by the user|response annotations|browser comments|diff comments|selected text|review findings|in app browser(?:\s*\(iab\))?)(?!\w)|<in-app-browser-context\b)/i;
const APP_REQUEST = /#+\s*my request(?: for codex)?:\s*/i;
const REQUEST_FIRST = /^\s*#+\s*my request(?: for codex)?:/i;
const COMMENT_SECTION = /^\s*#+\s*(?:browser|diff) comments:/im;
const COMMENT = /\bcomment:[ \t]*([\s\S]*?)(?=\s*(?:#{1,6}\s|$))/gi;

/** A turn that starts with one of the Codex app's context sections (and so is the app's envelope, request or not). */
export const startsWithAppSection = (text) => APP_SECTION.test(text);

/**
 * The Codex app's envelope taken off: every comment written in it, then the request. A turn without the envelope is returned as it is, and so
 * is an envelope with nothing of the person's in it (no request, no comment): the harness rules drop that one as `envelope`.
 * @returns {{text: string, peeled: boolean}}
 */
export function peelAppEnvelope(text) {
  if (!APP_SECTION.test(text) && !REQUEST_FIRST.test(text)) return { text, peeled: false };
  const request = APP_REQUEST.exec(text);
  const context = request ? text.slice(0, request.index) : text;
  const said = COMMENT_SECTION.test(context) ? [...context.matchAll(COMMENT)].map((m) => m[1].trim()).filter(Boolean) : [];
  if (request) said.push(text.slice(request.index + request[0].length).trim());
  if (!request && !said.length) return { text, peeled: false };
  return { text: said.join("\n"), peeled: true };
}

const QUOTE_MARKER = /^\s*<!--\s*(?:attach|reply(?:\s+\d+)?)\s*-->\s*$/i;
const QUOTED = /^\s*>/;

/**
 * The Claude desktop app's quote-reply taken off: the markers and the quoted block after each are dropped, every other line is kept. Only a
 * turn whose first line is such a marker is touched, and only the quoted lines right after a marker go (a `>` the person typed further down
 * stays).
 * @returns {{text: string, peeled: boolean}}
 */
export function peelQuoteReply(text) {
  const lines = String(text).split("\n");
  if (!QUOTE_MARKER.test(lines.find((l) => l.trim()) ?? "")) return { text, peeled: false };
  const kept = [];
  let quoting = false;
  for (const line of lines) {
    if (QUOTE_MARKER.test(line)) { quoting = true; continue; }
    if (quoting && (QUOTED.test(line) || !line.trim())) continue;
    quoting = false;
    kept.push(line);
  }
  return { text: kept.join("\n"), peeled: true };
}
