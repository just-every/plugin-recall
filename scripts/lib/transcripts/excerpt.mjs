// The conversation around one indexed statement, read from the transcript its `src` ("<file>:L<line>") names, for `recall show`.
// One streaming pass (both hosts, .jsonl and .jsonl.zst): the turns before the statement are held in a bounded buffer, the turns after it
// are read until `after` of them have been seen, then the scan stops. A "turn" is one owner message or one assistant text message; the
// tool calls between turns are kept as groups of tool names (the calls themselves are never shown). The owner's turns follow the indexer's
// rules (claudeTurn / codexTurn + judgeOwnerText), the assistant's are text only, and a sub-agent's sidechain records are not read at all.
import { codexContextTurn, ownerTurnText } from "../cards/context-source.mjs";
import { norm } from "../text.mjs";
import { claudeTurn } from "./claude.mjs";
import { legacyItem } from "./codex-legacy.mjs";
import { claudeConversationTurn } from "./tail.mjs";
import { scanLines } from "./lines.mjs";
import { createTally } from "./tally.mjs";

const RECALL_BLOCK = /<recall-context>[\s\S]*?<\/recall-context>/g;
const CLAUDE_ASSISTANT = Buffer.from('"type":"assistant"');
const CODEX_TURN = [Buffer.from('"AgentMessage"'), Buffer.from('"UserMessage"'), Buffer.from('"type":"message"')];
const CODEX_CALL = Buffer.from('_call"');
const KEEP_TURNS = 600; // held before the statement; the buffer only has to outlast Codex's duplicate (event + response_item) turns

export class ExcerptError extends Error {
  constructor(message) { super(message); this.name = "ExcerptError"; }
}

/** The tool a Codex response_item call record stands for, or null when the record is not a call. */
function codexToolName(r) {
  const p = r.type === "response_item" ? r.payload : legacyItem(r); // a legacy rollout's call has no payload wrapper
  if (typeof p?.type !== "string" || !p.type.endsWith("_call")) return null;
  if (p.type === "local_shell_call") return "shell";
  if (p.type === "web_search_call") return "web_search";
  return typeof p.name === "string" && p.name ? p.name : p.type.replace(/_call$/, "");
}

const claudeToolNames = (r) => (Array.isArray(r.message?.content) ? r.message.content.filter((b) => b?.type === "tool_use").map((b) => b.name ?? "tool") : []);

/**
 * Parse one transcript line into what it adds to the conversation.
 * @returns {{turn?: {role: string, text: string, kind: string, ts: string|null}, tools?: string[]}|null}
 */
function parseLine(host, line, config, tally) {
  if (host === "claude") {
    if (line.indexOf(CLAUDE_ASSISTANT) >= 0) {
      let r;
      try { r = JSON.parse(line.toString("utf8")); } catch { return null; }
      if (r.type === "assistant") {
        if (r.isSidechain === true) return null;
        const text = claudeConversationTurn(r);
        const tools = claudeToolNames(r);
        if (!text && !tools.length) return null;
        return { ...(text ? { turn: { role: "assistant", text: text.text, kind: "claude", ts: r.timestamp ?? null } } : {}), ...(tools.length ? { tools } : {}) };
      }
    }
    const turn = claudeTurn(line, tally);
    return turn ? { turn: { role: "user", text: turn.raw, kind: "claude", ts: turn.ts } } : null;
  }
  const maybeTurn = CODEX_TURN.some((b) => line.indexOf(b) >= 0);
  const maybeCall = line.indexOf(CODEX_CALL) >= 0;
  if (!maybeTurn && !maybeCall) return null;
  let r;
  try { r = JSON.parse(line.toString("utf8")); } catch { return null; }
  const tool = maybeCall ? codexToolName(r) : null;
  if (tool) return { tools: [tool] };
  const t = maybeTurn ? codexContextTurn(r) : null;
  if (!t) return null;
  // The conversation events are the clean copy of a turn; a response_item message is the older rollouts' only copy (and a polluted twin of the event in newer ones).
  return { turn: { role: t.role, text: t.text, kind: r.type === "event_msg" ? "event" : "fallback", ts: r.timestamp ?? r.payload?.timestamp ?? null } };
}

/** Keep each owner turn only if it is the owner's (envelopes peeled); an assistant turn as it is. */
function judged(turn, config) {
  if (turn.role === "assistant") return turn;
  const text = ownerTurnText(String(turn.text).replace(RECALL_BLOCK, " "), config);
  return text === null ? null : { ...turn, text };
}

/**
 * @param {{file: string, host: "claude"|"codex"|"code", line: number, statementText: string, before: number, after: number, config: object}} o
 * @returns {Promise<{items: object[]}>} items in order: {type:"turn", role:"owner"|"assistant", ts, line, text, recalled} and {type:"tools", names}
 * @throws {ExcerptError} when line `line` of the file is not the owner's statement (a different file, or the transcript changed since it was indexed)
 */
export async function readExcerpt({ file, host, line: target, statementText, before, after, config }) {
  const tally = createTally();
  const items = []; // {type:"turn", kind, ...} | {type:"tools", names}
  let turnsHeld = 0;
  let targetItem = null;
  let afterSeen = 0;
  const push = (item) => {
    if (item.type === "tools" && items.at(-1)?.type === "tools") { items.at(-1).names.push(...item.names); return; }
    items.push(item);
    if (item.type === "turn") turnsHeld++;
    // before the statement, hold a bounded window
    while (!targetItem && turnsHeld > KEEP_TURNS) { if (items.shift().type === "turn") turnsHeld--; }
  };

  await scanLines(file, {
    zst: file.endsWith(".zst"),
    onLine(buf, lineNo) {
      if (lineNo > target && !targetItem) return false; // passed the statement's line without finding it
      const parsed = parseLine(host, buf, config, tally);
      if (!parsed) return undefined;
      const turn = parsed.turn ? judged(parsed.turn, config) : null;
      if (lineNo === target) {
        if (!turn || turn.role !== "user" || norm(turn.text) !== norm(statementText)) return false;
        targetItem = { type: "turn", role: "owner", kind: turn.kind, ts: turn.ts, line: lineNo, text: turn.text, recalled: true };
        push(targetItem);
        return after === 0 ? false : undefined;
      }
      // after the statement only its own copy of each turn counts (Codex writes a turn twice: as an event and as a response_item)
      if (turn && !(targetItem && turn.kind !== targetItem.kind)) {
        push({ type: "turn", role: turn.role === "user" ? "owner" : "assistant", kind: turn.kind, ts: turn.ts, line: lineNo, text: turn.text, recalled: false });
        if (targetItem && ++afterSeen >= after) {
          if (parsed.tools) push({ type: "tools", names: parsed.tools }); // a Claude record's text comes before its tool calls
          return false;
        }
      }
      if (parsed.tools) push({ type: "tools", names: parsed.tools });
      return undefined;
    },
  });

  if (!targetItem) throw new ExcerptError(`line ${target} of ${file} is not the recalled statement (the transcript is shorter than the index remembers, or it was rewritten since it was indexed)`);

  // Keep one copy of each turn: the target's kind (the other copy of a Codex turn is its twin), then the tool groups that touch each other merge.
  const kept = [];
  for (const item of items) {
    if (item.type === "turn" && item.kind !== targetItem.kind) continue;
    if (item.type === "tools" && kept.at(-1)?.type === "tools") { kept.at(-1).names.push(...item.names); continue; }
    kept.push(item);
  }
  const at = kept.indexOf(targetItem);
  // `before` turns before the statement (the tool group just in front of the earliest one stays out), `after` after it (a trailing group stays in)
  let from = at;
  for (let seen = 0; from > 0 && seen < before; from--) if (kept[from - 1].type === "turn") seen++;
  const first = kept.slice(from, at);
  while (first.length && first[0].type === "tools") first.shift();
  return { items: [...first, ...kept.slice(at)] };
}
