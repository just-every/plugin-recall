// The context a statement was said in: the assistant message and the owner message before it, read from the transcript the statement came
// from (its `src`, "<file>:L<line>", both hosts, .jsonl and .jsonl.zst). Only what comes BEFORE the statement is read, never a later turn.
//
// Where the context comes from, recorded on the card as gist_source:
//   transcript       the statement's own src line (live index)
//   index            a statement of a contract corpus (no src) matched to the live index by host + normalized text + time, then its src
//   prior-statement  no readable transcript: the previous owner statement of the same session in the statement set, no assistant reply
//   none             nothing came before it
// An Every Code rollout's user turns are owner messages only when the indexer's rule says they are (code-owner.mjs): a response item user
// turn that is not one of its session's typed rows (an Auto Drive coordinator's prompt, a host's canned request) is never the previous owner
// message.
import fs from "node:fs";
import { filterOptions, judgeOwnerText } from "../owner-filter.mjs";
import { norm, tsMicros } from "../text.mjs";
import { legacyItem } from "../transcripts/codex-legacy.mjs";
import { isSessionMeta, parseSessionMeta, rolloutSessionId } from "../transcripts/codex.mjs";
import { codeTurnVerdict } from "../transcripts/code-rollout.mjs";
import { claudeConversationTurn, codexConversationTurn } from "../transcripts/tail.mjs";
import { scanLines } from "../transcripts/lines.mjs";

const SRC = /^(.*):L(\d+)$/;
/** "<file>:L<line>" -> {file, line}, or null for anything else (the tests' "test", a corpus row's missing src). */
export function parseSrc(src) {
  const m = typeof src === "string" ? SRC.exec(src) : null;
  return m ? { file: m[1], line: Number(m[2]) } : null;
}

const BLOCK_TYPES = ["input_text", "output_text", "text"];
const blocksText = (content) => (Array.isArray(content) ? content.filter((b) => BLOCK_TYPES.includes(b?.type)).map((b) => b.text ?? "").join("\n") : "");

/**
 * One Codex / Every Code record -> {role, text} or null. The rollout's conversation events first; older rollouts have none of them for a
 * user turn, so a `response_item` message is accepted too (its envelopes are peeled or rejected by judgeOwnerText later).
 */
export function codexContextTurn(r) {
  const turn = codexConversationTurn(r);
  if (turn) return turn;
  // a response item, or a legacy rollout's bare item (no payload wrapper: codex-legacy.mjs)
  const item = r.type === "response_item" ? r.payload : legacyItem(r);
  if (item?.type !== "message" || !["user", "assistant"].includes(item.role)) return null;
  const text = blocksText(item.content);
  return text.trim() ? { role: item.role, text } : null;
}

const CLAUDE_USER = Buffer.from('"type":"user"');
const CLAUDE_ASSISTANT = Buffer.from('"type":"assistant"');
const CLAUDE_QUEUED = Buffer.from('"queued_command"');
const TEXT_BLOCK = Buffer.from('"type":"text"');
const TOOL_RESULT = Buffer.from('"type":"tool_result"');
const CODEX_MESSAGE = [Buffer.from('"AgentMessage"'), Buffer.from('"UserMessage"'), Buffer.from('"type":"message"')];

/** Cheap byte test: could this line be a conversation turn? Saves decoding multi-MB tool outputs. */
function maybeTurn(host, line) {
  if (host === "claude") {
    if (line.indexOf(CLAUDE_ASSISTANT) >= 0) return line.indexOf(TEXT_BLOCK) >= 0;
    if (line.indexOf(CLAUDE_QUEUED) >= 0) return true;
    return line.indexOf(CLAUDE_USER) >= 0 && line.indexOf(TOOL_RESULT) < 0;
  }
  return CODEX_MESSAGE.some((b) => line.indexOf(b) >= 0);
}

/** The text of a user turn as the user typed it (envelopes peeled, secrets redacted), or null when it was not the user's. */
export function ownerTurnText(text, config) {
  const judged = judgeOwnerText(text, filterOptions(config, 1));
  return judged.text ?? null;
}

/**
 * One pass over a transcript, taking a snapshot of the context just before each target line.
 * @param {{file: string, host: "claude"|"codex"|"code", targets: {key: string, line: number, text: string}[], config: object,
 *          codeOwner?: {typed: object, home: string|null, now: number}}} o
 *   `text` is the statement itself; it is checked against the turn on its line. `codeOwner` (code-owner.mjs): for an Every Code rollout, a
 *   response item user turn counts as an owner message only when codeTurnVerdict keeps it.
 * @returns {Promise<Map<string, {owner: string|null, assistant: string|null}|{mismatch: true}>>} key -> context. A key is absent when the file
 *   has no such line (shorter than the index remembers).
 */
export async function scanContexts({ file, host, targets, config, codeOwner = null }) {
  const parse = host === "claude" ? claudeConversationTurn : codexContextTurn;
  const byLine = new Map(targets.map((t) => [t.line, t]));
  const last = Math.max(...targets.map((t) => t.line));
  const out = new Map();
  const owners = []; // the last few owner messages, newest last
  let assistant = null;
  let session = codeOwner ? rolloutSessionId(file) : null;
  await scanLines(file, {
    zst: file.endsWith(".zst"),
    onLine(line, lineNo) {
      if (codeOwner && lineNo === 1 && isSessionMeta(line)) session = parseSessionMeta(line)?.id ?? session;
      const target = byLine.get(lineNo);
      let turn = null;
      let record = null;
      if (target || maybeTurn(host, line)) {
        try { record = JSON.parse(line.toString("utf8")); } catch { record = null; }
        turn = record ? parse(record) : null;
      }
      const judged = turn?.role === "user" ? ownerTurnText(turn.text, config) : null;
      // the turn on the statement's own line is the statement; any other must also be a turn the person typed (code-owner.mjs)
      const ownerText = judged !== null && !target && codeOwner && record?.type === "response_item"
        && codeTurnVerdict({ session_id: session, ts: record.timestamp ?? null, raw: turn.text }, codeOwner) !== "keep" ? null : judged;
      if (target) {
        // The statement's own line: confirm it is the statement, then snapshot everything before it. Codex writes one message as an event
        // and as a response item, so an earlier owner message equal to the statement is its twin, not an earlier message.
        if (ownerText !== null && norm(ownerText) === norm(target.text)) {
          const earlier = owners.findLast((t) => norm(t) !== norm(target.text)) ?? null;
          out.set(target.key, { owner: earlier, assistant });
        } else out.set(target.key, { mismatch: true });
      }
      if (turn?.role === "assistant") assistant = turn.text;
      else if (ownerText !== null) { owners.push(ownerText); if (owners.length > 4) owners.shift(); }
      return lineNo >= last ? false : undefined;
    },
  });
  return out;
}

/**
 * The previous owner statement of the same session before `statement`, from a statement set (no assistant reply is known).
 * @param {Map<string, object[]>} bySession session_id -> statements sorted by time
 */
export function priorStatement(bySession, statement) {
  const list = bySession.get(statement.session_id) ?? [];
  const at = tsMicros(statement.ts);
  let prev = null;
  for (const s of list) {
    if (s.id === statement.id) continue;
    if (tsMicros(s.ts) < at) prev = s; else break;
  }
  return prev;
}

export const groupBySession = (statements) => {
  const m = new Map();
  for (const s of statements) {
    if (!m.has(s.session_id)) m.set(s.session_id, []);
    m.get(s.session_id).push(s);
  }
  for (const list of m.values()) list.sort((a, b) => tsMicros(a.ts) - tsMicros(b.ts) || (a.id < b.id ? -1 : 1));
  return m;
};

/** A key for matching a corpus statement to the live index: host + normalized text + time. */
export const matchKey = (s) => `${s.host}\u0000${norm(s.text)}\u0000${tsMicros(s.ts)}`;

export const fileExists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
