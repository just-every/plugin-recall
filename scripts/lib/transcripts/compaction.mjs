// Structural markers observed in real transcripts; quoted marker text in a tool result is not a boundary.
// Claude emits a boundary and a summary; either proves compaction when the other is absent.
export function compactionMarker(record, host) {
  if (host === "claude") {
    if (record.isSidechain === true) return null;
    if (record.type === "system" && record.subtype === "compact_boundary") return "compact_boundary";
    if (record.type === "user" && record.isCompactSummary === true) return "isCompactSummary";
    return null;
  }
  if (record.type === "compacted") return "compacted";
  return null;
}
