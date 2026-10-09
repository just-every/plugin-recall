// Codex rollouts written before `session_meta` existed (Codex CLI of mid 2025). Line 1 is a bare header {id, timestamp, instructions, cwd?,
// model?, git?}; then `{"record_type":"state"}` markers and bare response items ({type:"message", role, content}, {type:"function_call", name,
// ...}) with no `payload` wrapper and no timestamp of their own.
//
// Whose session it is: the file cannot say (no source, no originator, no thread source). The home's typed-prompt log can: the TUI appends
// every prompt submitted at it to history.jsonl under the session id, and `codex exec` never does. So a legacy rollout is the owner's when its
// session id appears in a history.jsonl of a home being read, and a program's otherwise. Measured on one archive of 324 legacy rollouts: the
// 275 whose session is in its history.jsonl hold 1,143 of the 1,151 user messages; the other 49 hold 8, every one a brief a program wrote.
// When: every turn is dated with the session's start (the header's timestamp), the only time the file records.

/** Is this record a legacy rollout header (line 1 of a rollout with no session_meta)? */
const isLegacyHeaderRecord = (r) => Boolean(r) && typeof r === "object" && r.type === undefined && r.record_type === undefined && r.payload === undefined
  && typeof r.id === "string" && r.id !== "" && typeof r.timestamp === "string";

/** The session of a legacy rollout from its line 1, shaped like parseSessionMeta's result with `legacy: true`; null for any other line. */
export function parseLegacyHeader(line) {
  let r;
  try { r = JSON.parse(line.toString("utf8")); } catch { return null; }
  if (!isLegacyHeaderRecord(r)) return null;
  return { id: r.id, cwd: typeof r.cwd === "string" ? r.cwd : null, git_url: r.git?.repository_url ?? null, source: null, thread_source: null, originator: null, timestamp: r.timestamp, legacy: true };
}

/** A legacy bare response item (no payload wrapper): the record itself, or null for anything else. */
export const legacyItem = (r) => (r && typeof r.type === "string" && r.payload === undefined && r.record_type === undefined && r.timestamp === undefined ? r : null);

/** Is a legacy session the owner's? `typedSessions` are the session ids of the history.jsonl rows of the homes read. */
export const legacyVerdict = (meta, typedSessions) => (typedSessions?.has(meta.id) ? { mine: true, reason: null } : { mine: false, reason: "legacy-not-typed" });
