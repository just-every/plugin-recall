// What the Codex and Every Code typed-prompt logs (history.mjs) say about the sessions of the homes read: which sessions a person typed into
// (a legacy rollout's verdict, codex-legacy.mjs), what was typed in each (an Every Code rollout's turns, code-rollout.mjs), and the time each
// home's log spans. Read once per pass, and only when a rollout needs it.
//
// A typed row is matched to a rollout turn on the whole text, whitespace collapsed. Every Code writes a long paste to its log as
// `[Pasted Content <n> chars]` and sends the pasted text itself to the model, so a placeholder matches any text in its place.
import { norm } from "../text.mjs";
import { autoDriveLines } from "./auto-drive.mjs";
import { readHistoryRows } from "./history.mjs";

const PASTE_PLACEHOLDER = /\[Pasted Content \d+ chars\]/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A typed row's text as a matcher of a turn's normalized text, or null when the row holds no text (a bare slash command). */
export function typedMatcher(raw) {
  const text = norm(raw);
  if (!text) return null;
  const parts = text.split(PASTE_PLACEHOLDER);
  if (parts.length === 1) return (turn) => turn === text;
  const re = new RegExp(`^${parts.map((p) => escapeRe(p)).join("[\\s\\S]*")}$`);
  return (turn) => re.test(turn);
}

/** Is a rollout turn's raw text one of these typed rows (typedMatcher)? */
export const isTypedTurn = (raw, matchers) => {
  const turn = norm(raw);
  return matchers.some((m) => m(turn));
};

/**
 * @param {{home: {dir: string, kind: string}, f: {file: string}}[]} histories the typed-prompt logs of the homes read
 * @returns {Promise<{sessions: Map<string, Function[]>, spans: Map<string, {first: number, last: number}>}>} sessions: every session a
 *   Codex or Every Code log names, with matchers for its typed rows (an Every Code Auto Drive submission is not one: auto-drive.mjs);
 *   spans: per home directory, the times (ms) of its log's first and last rows
 */
export async function readTypedLogs(histories) {
  const sessions = new Map();
  const spans = new Map();
  for (const { home, f } of histories) {
    if (home.kind === "claude") continue;
    const rows = await readHistoryRows(f.file);
    const autoDrive = home.kind === "code" ? autoDriveLines(rows) : new Set();
    let first = Infinity;
    let last = -Infinity;
    for (const r of rows) {
      const t = Date.parse(r.ts);
      if (Number.isFinite(t)) { first = Math.min(first, t); last = Math.max(last, t); }
      if (!r.session_id) continue;
      if (!sessions.has(r.session_id)) sessions.set(r.session_id, []);
      const m = autoDrive.has(r.line) ? null : typedMatcher(r.raw);
      if (m) sessions.get(r.session_id).push(m);
    }
    if (last >= first) spans.set(home.dir, { first, last });
  }
  return { sessions, spans };
}
