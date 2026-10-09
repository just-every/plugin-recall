// The apply gate of one prompt line (the line's `applyGate` record): each survivor's probability and verdict, joined to the statement text.
// Pure: no DOM, no network, so the page and the tests share it.

/**
 * @param {object} line a prompt log line
 * @param {(id: string) => ({text: string, repo?: string|null, ts?: string}|null|undefined)} textOf the statement for an id (a candidate of the line, or a looked-up statement)
 * @returns {{id: string, p: number|null, pass: boolean, injected: boolean, verdict: string, row: object|null}[]} the survivors in the fused order the gate was given;
 *   verdict: "injected" | "passed, cut by k" | "below the bar" | "no answer"
 */
export function gateRows(line, textOf) {
  const gate = line?.applyGate;
  if (!Array.isArray(gate?.rows)) return [];
  const injected = new Set(line.injected ?? []);
  return gate.rows.map((r) => {
    const yes = injected.has(r.id);
    const verdict = yes ? "injected" : r.pass ? "passed, cut by k" : r.p === null ? "no answer" : "below the bar";
    return { id: r.id, p: r.p, pass: r.pass === true, injected: yes, verdict, row: textOf(r.id) ?? null };
  });
}

/** One sentence on what the gate did on this turn, or null when it did not run. */
export function gateSummary(line) {
  const g = line?.applyGate;
  if (!g || typeof g.survivors !== "number") return null;
  const refused = g.refused ? `, ${g.refused} without an answer` : "";
  return `${g.survivors} surviving ${g.survivors === 1 ? "statement" : "statements"} asked; ${g.passed ?? 0} at ${g.threshold} or more${refused}; ${g.selected ?? (line.injected ?? []).length} injected.`;
}
