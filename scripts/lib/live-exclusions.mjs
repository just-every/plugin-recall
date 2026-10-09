// Translate live context into the same excludeIds contract used by eval. Retrieval's eligibleIndices remains the single gate.
import { carriedStatementIds, visibilityTextHash } from "./transcripts/carry-over.mjs";
import fs from "node:fs";
import { norm, tsMicros } from "./text.mjs";
import { transcriptVisibility } from "./transcripts/visibility.mjs";

export function visibleStatementIds({ corpus, sessionId, visibility, currentPrompt }) {
  const hidden = new Set();
  const visible = carriedStatementIds(visibility?.turns ?? [], visibility?.carryOver);
  const carriedHashes = new Set(visibility?.carryOver?.textHashes);
  if (visibility?.boundary) {
    for (const { statement, line } of visibility.turns) {
      (line < visibility.boundary.line ? hidden : visible).add(statement.id);
    }
  }
  const boundaryTime = visibility?.boundary ? tsMicros(visibility.boundary.ts) : null;
  // The index can retain history that the host has removed from the file. Its timestamp locates it relative to the boundary;
  // for records still in the transcript, position wins (including preserved/replayed records with older timestamps).
  for (const it of corpus.items) {
    if (it.session_id === sessionId && (boundaryTime === null || carriedHashes.has(visibilityTextHash(it.text)) || (!hidden.has(it.id) && tsMicros(it.ts) >= boundaryTime))) visible.add(it.id);
    if (currentPrompt && norm(it.text) === norm(currentPrompt)) visible.add(it.id);
  }
  return visible;
}

export async function liveExclusions({ corpus, input, config, decisionTs, currentPrompt }) {
  let visibility = null;
  // Claude's first prompt fires before its transcript exists. Missing transcript means no proven boundary.
  if (input.transcript_path) {
    let exists = true;
    try { fs.statSync(input.transcript_path); } catch (e) {
      if (e.code !== "ENOENT") throw e;
      exists = false;
    }
    if (exists) visibility = await transcriptVisibility({ file: input.transcript_path, host: input.host, sessionId: input.session_id, config, decisionTs });
  }
  return visibleStatementIds({ corpus, sessionId: input.session_id, visibility, currentPrompt });
}
