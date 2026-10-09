// Read the complete transcript, including compressed rollouts: a tail window can miss the last boundary.
// Position, not timestamp, determines which side a statement occupies (Claude summary timestamps can go backwards).
import { buildStatement } from "../indexer.mjs";
import { tsMicros } from "../text.mjs";
import { claudeTurn } from "./claude.mjs";
import { codexTurn } from "./codex.mjs";
import { compactionCarryOver } from "./carry-over.mjs";
import { compactionMarker } from "./compaction.mjs";
import { scanLines } from "./lines.mjs";
import { createTally } from "./tally.mjs";

export async function transcriptVisibility({ file, host, sessionId, config, decisionTs, onMarker = () => {} }) {
  const tally = createTally();
  const events = [], fallback = [], markers = [];
  let seenEvents = false;
  let carryOver = { textHashes: [], uuids: [] };
  let summaryAnchorUuid = null;
  const decision = decisionTs ? tsMicros(decisionTs) : Infinity;
  await scanLines(file, {
    zst: file.endsWith(".zst"),
    onLine(line, lineNo) {
      // Avoid decoding multi-MB tool outputs unless they mention a marker or an owner-turn discriminator.
      if (["compact_boundary", "isCompactSummary", '"compacted"'].some((s) => line.includes(s))) {
        const record = JSON.parse(line.toString("utf8"));
        const kind = compactionMarker(record, host);
        if (kind) {
          onMarker({ kind, line: lineNo, raw: line });
          if (tsMicros(record.timestamp) <= decision) {
            // Only the summary belonging to the last explicit boundary shares its preserved UUIDs.
            const pairedSummary = kind === "isCompactSummary" && markers.at(-1)?.kind === "compact_boundary"
              && summaryAnchorUuid && record.uuid === summaryAnchorUuid;
            if (!pairedSummary) carryOver = compactionCarryOver(record, host, config);
            summaryAnchorUuid = kind === "compact_boundary" ? record.compactMetadata?.preservedMessages?.anchorUuid : null;
            markers.push({ kind, line: lineNo, ts: record.timestamp });
          }
          return;
        }
      }
      const turn = host === "claude" ? claudeTurn(line, tally) : codexTurn(line, tally);
      if (!turn) return;
      if (turn.kind === "event") { seenEvents = true; fallback.length = 0; }
      if (turn.kind === "fallback" && seenEvents) return;
      const row = { ...turn, host, session_id: sessionId, repo: null, src: `${file}:L${lineNo}` };
      (turn.kind === "fallback" ? fallback : events).push({ row, uuid: turn.uuid ?? null, line: lineNo });
    },
  });
  // Match the indexer's UserMessage precedence even if every event is rejected by ownerText.
  const turns = (events.length ? events : fallback).flatMap(({ row, line, uuid }) => {
    const { statement } = buildStatement(row, config);
    return statement ? [{ statement, line, uuid }] : [];
  });
  return { boundary: markers.at(-1) ?? null, markers, turns, carryOver };
}
