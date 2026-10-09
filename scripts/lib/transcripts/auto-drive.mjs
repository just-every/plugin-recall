// Every Code's Auto Drive in a typed-prompt log (history.mjs). `/auto <goal>` starts a coordinator model that writes each next prompt and
// submits it to the session through the same path as a typed one. Until its commit a228dfc9e8 "skip persisting Auto Drive submissions"
// (2025-10-22 08:09 +1000) Every Code appended those submissions to <home>/history.jsonl as if the person had typed them: one Auto Drive
// run leaves dozens of rows ("Primary goal: ...", "Focus files: ...", "Orient yourself to this repository ...").
//
// Auto Drive's end is not in the log: stopping it persists nothing, and nothing the log holds marks a return to typed input. A run goes on
// from turn to turn, so a coordinator prompt follows the previous row of its session by the time the agent's turn took; a person who comes
// back to a session after the run has ended does so after an idle gap. Measured on one ~/.code log (202 sessions with rows after an /auto row
// before the cutoff, 1,731 such rows; gap to the session's previous row: median 2 min 23 s, 90th percentile 31 min, 99th 7 h 10 min): rows in
// a coordinator's voice ("Repo root: ...", "Worktree: ...", "Target file: ...") come up to 2 h 49 min after the previous row (an agent's
// turn under Auto Drive can take that long), and none 3 hours or more after it; every row 3 hours or more after it reads as the person's.
// So a session's run is on from its /auto row until a typed row comes AUTO_DRIVE_IDLE_MS or more after the session's previous row; that row
// and every later row of the session (up to its next /auto row) are the person's. A slash command after the gap is kept but does not end the
// run: the run can go on after one (measured: a `/review` after 4 h was followed by five more coordinator prompts). A row inside a run that
// carries Every Code's attachment placeholder (`[image: ...]`) is the person's: a coordinator prompt never attaches an image (measured: 14 such
// rows among the run rows, all of them the person's). It keeps the run on. The other rows of a run before the gap are submissions, the
// person's interjections among them included: timing cannot tell them apart (about 1 in 5 of the dropped rows that hold words read as the
// person's), and the 2025 sessions have no rollouts whose turn ends could. The /auto row itself is kept, as what was typed after the command is
// the person's goal. Rows from the cutoff on are the person's again (a build with the fix persists typed rows only).
export const AUTO_DRIVE_PERSISTED_BEFORE = Date.parse("2025-10-23T00:00:00.000Z");
/** A typed row this long after its session's previous row ends the session's Auto Drive run. */
export const AUTO_DRIVE_IDLE_MS = 3 * 3_600_000;

export const AUTO_COMMAND = "/auto";
// Every Code's placeholder for an image attached to a prompt (the typed-prompt log keeps it in the row's text).
const IMAGE_ATTACHED = /\[image: [^\]\n]*\]/i;

/**
 * Tracks, in log order, the sessions whose Auto Drive run (started before the cutoff) is on.
 * @param {Record<string, number>} [running] what earlier passes left on (the log's scan state keeps it): session -> time (ms) of its last row
 */
export function autoDriveTracker(running = {}) {
  const runs = new Map(Object.entries(running));
  return {
    /**
     * Is this row an Auto Drive submission? Rows must come in log order. `command` is the slash command the row starts with (history.mjs).
     * @param {{session_id: string|null, ts: string|null, command: string|null, raw?: string}} row
     */
    isSubmission({ session_id, ts, command, raw = "" }) {
      const t = Date.parse(ts);
      if (!session_id || !(t < AUTO_DRIVE_PERSISTED_BEFORE)) return false;
      if (command === AUTO_COMMAND) { runs.set(session_id, t); return false; }
      const last = runs.get(session_id);
      if (last === undefined) return false;
      const idle = t - last >= AUTO_DRIVE_IDLE_MS;
      if (idle && !command) { runs.delete(session_id); return false; }
      runs.set(session_id, t);
      return !idle && !IMAGE_ATTACHED.test(raw);
    },
    /** The runs that are on, for the scan state: session -> time (ms) of its last row. */
    running: () => Object.fromEntries(runs),
  };
}

/** The line numbers of the Auto Drive submissions among a whole log's rows (readHistoryRows, in file order). */
export function autoDriveLines(rows) {
  const tracker = autoDriveTracker();
  const lines = new Set();
  for (const r of rows) if (tracker.isSubmission(r)) lines.add(r.line);
  return lines;
}
