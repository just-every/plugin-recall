// Whose words the user turns of an Every Code rollout are. Every Code writes no UserMessage events, so every `response_item` user message is
// a candidate (codex.mjs), and the rollout gives no sign of who wrote one: an Auto Drive coordinator's prompt, an auto-review or auto-resolve
// turn and an agent's brief have the same record shape, role and content blocks as a typed prompt, with no field, wrapper or event that marks
// them (measured over every rollout of one Every Code home: 190 rollouts, 1,328 user messages). The home's typed-prompt log does say: the TUI
// appends what the person submits at its prompt, and since late October 2025 nothing else (auto-drive.mjs). So, per turn:
//   - its session is named by a typed-prompt log: the turn is kept only when its text is one of the session's typed rows (typed-rows.mjs)
//     ("code-turn-not-typed" otherwise);
//   - its session is named by no log, and its own home's log was being written before and after it: nobody typed in the session (an agent's
//     or a review's session) ("code-session-not-typed");
//   - its session is named by no log, and the turn is outside the time its home's log spans (or the home keeps no log: a copy without it,
//     history persistence switched off): the log cannot say, and the turn is a candidate like any rollout turn;
//   - a turn younger than HISTORY_SETTLE_MS that the log does not vouch for yet waits: its row may not be written yet.
import { HISTORY_SETTLE_MS } from "./history-scan.mjs";
import { isTypedTurn } from "./typed-rows.mjs";

/**
 * @param {{session_id: string, ts: string|null, raw: string}} turn
 * @param {{typed: {sessions: Map<string, Function[]>, spans: Map<string, {first: number, last: number}>}, home: string, now: number}} o
 *   home: the directory of the Every Code home the rollout is in
 * @returns {"keep"|"wait"|"code-turn-not-typed"|"code-session-not-typed"}
 */
export function codeTurnVerdict({ session_id, ts, raw }, { typed, home, now }) {
  const t = Date.parse(ts);
  const young = Number.isFinite(t) && now - t < HISTORY_SETTLE_MS;
  const rows = typed.sessions.get(session_id);
  if (rows) {
    if (isTypedTurn(raw, rows)) return "keep";
    return young ? "wait" : "code-turn-not-typed";
  }
  const span = typed.spans.get(home);
  if (span && span.first <= t && t <= span.last) return "code-session-not-typed";
  if (span && t > span.last && young) return "wait";
  return "keep";
}
