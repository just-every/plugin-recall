// The conversation around a statement that came from a typed-prompt log (history.mjs): the other rows of its session, in order. A log holds
// what the person typed and nothing else, so every turn here is the owner's and there is never an assistant reply. Used for the card's context
// (the row before the statement) and for `recall show` (the rows around it). A row is shown as the indexer read it: envelopes peeled, a row that
// holds nothing of the person's (a bare slash command, an envelope, an Every Code Auto Drive submission) left out.
import { ownerTurnText } from "../cards/context-source.mjs";
import { norm } from "../text.mjs";
import { autoDriveLines } from "./auto-drive.mjs";
import { ExcerptError } from "./excerpt.mjs";
import { readHistoryRows } from "./history.mjs";

/** The judged rows of a log, by session (a row with no session id is a session of its own: it has no neighbours). `host`: the statement's. */
async function bySession(file, config, host) {
  const sessions = new Map();
  const byLine = new Map();
  const rows = await readHistoryRows(file);
  const autoDrive = host === "code" ? autoDriveLines(rows) : new Set();
  for (const row of rows) {
    const text = autoDrive.has(row.line) ? null : ownerTurnText(row.raw, config);
    const judged = { ...row, text };
    byLine.set(row.line, judged);
    if (text === null || !row.session_id) continue;
    if (!sessions.has(row.session_id)) sessions.set(row.session_id, []);
    sessions.get(row.session_id).push(judged);
  }
  return { sessions, byLine };
}

/** The statement's row and its session's rows, or null when line `line` is not the statement (the log changed since it was indexed). */
function locate(index, line, statementText) {
  const row = index.byLine.get(line);
  if (!row || row.text === null || norm(row.text) !== norm(statementText)) return null;
  const rows = row.session_id ? index.sessions.get(row.session_id) : [row];
  return { rows, at: rows.indexOf(row) };
}

/**
 * The card context of each target: the previous row of the same session as the owner message, no assistant message.
 * @param {{file: string, targets: {key: string, line: number, text: string}[], config: object, host?: string}} o
 * @returns {Promise<Map<string, {owner: string|null, assistant: null}|{mismatch: true}>>}
 */
export async function historyContexts({ file, targets, config, host }) {
  const index = await bySession(file, config, host);
  const out = new Map();
  for (const t of targets) {
    const found = locate(index, t.line, t.text);
    if (!found) { out.set(t.key, { mismatch: true }); continue; }
    const earlier = found.rows.slice(0, found.at).findLast((r) => norm(r.text) !== norm(t.text));
    out.set(t.key, { owner: earlier?.text ?? null, assistant: null });
  }
  return out;
}

/**
 * `recall show` for a statement from a typed-prompt log: `before` rows of its session before it, `after` rows after it.
 * @returns {Promise<{items: object[]}>} items as readExcerpt() returns them (owner turns only)
 * @throws {ExcerptError} when line `line` of the log is not the statement
 */
export async function readHistoryExcerpt({ file, line, statementText, before, after, config, host }) {
  const found = locate(await bySession(file, config, host), line, statementText);
  if (!found) throw new ExcerptError(`line ${line} of ${file} is not the recalled statement (the log is shorter than the index remembers, or it was rewritten since it was indexed)`);
  const { rows, at } = found;
  const items = rows.slice(Math.max(0, at - before), at + after + 1).map((r) => ({ type: "turn", role: "owner", kind: "history", ts: r.ts, line: r.line, text: r.text, recalled: r === rows[at] }));
  return { items };
}
