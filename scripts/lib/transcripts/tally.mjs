/** Counts dropped items by reason so an index run can be argued with: every dropped item is counted, none silently. */
export function createTally() {
  const counts = {};
  return {
    counts,
    drop(reason) { counts[reason] = (counts[reason] ?? 0) + 1; },
    merge(other) { for (const [k, v] of Object.entries(other)) counts[k] = (counts[k] ?? 0) + v; },
  };
}
