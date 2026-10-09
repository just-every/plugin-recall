// The last conversation turns of a live session, read from the tail of its transcript: the prompt hook's situation (the previous owner
// message and the agent's last reply) and the stop-time layout. Text turns only: the owner's typed messages and the agent's text; tool
// calls, tool results, reasoning, sub-agent records and harness turns are not conversation. Reading is bounded to the last `maxBytes`
// of the file.
import fs from "node:fs";
import { norm } from "../text.mjs";

const RECALL_BLOCK = /<recall-context>[\s\S]*?<\/recall-context>/g;

const blocksText = (content, types) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => types.includes(b?.type)).map((b) => b.text ?? "").join("\n");
};

/** One Claude transcript record -> {role, text} or null. */
export function claudeConversationTurn(r) {
  if (r.isSidechain === true) return null;
  if (r.type === "assistant") {
    const text = blocksText(r.message?.content, ["text"]);
    return text.trim() ? { role: "assistant", text } : null;
  }
  if (r.type === "attachment") {
    const a = r.attachment;
    if (a?.type !== "queued_command" || a.origin?.kind !== "human") return null;
    const text = blocksText(a.prompt, ["text"]);
    return text.trim() ? { role: "user", text } : null;
  }
  if (r.type !== "user" || r.isMeta === true || r.isCompactSummary === true) return null;
  const content = r.message?.content;
  if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) return null;
  if (r.origin ? r.origin.kind !== "human" : r.entrypoint === "sdk-cli" || r.promptSource === "system" || r.turnOrigin === "sdk") return null;
  const text = blocksText(content, ["text"]).replace(RECALL_BLOCK, " ");
  return text.trim() ? { role: "user", text } : null;
}

/** One Codex / Every Code rollout record -> {role, text} or null. */
export function codexConversationTurn(r) {
  if (r.type !== "event_msg" || r.payload?.type !== "item_completed") return null;
  const item = r.payload.item;
  if (item?.type === "UserMessage") {
    const text = blocksText(item.content, ["text"]).replace(RECALL_BLOCK, " ");
    return text.trim() ? { role: "user", text } : null;
  }
  if (item?.type === "AgentMessage") {
    const text = (item.content ?? []).filter((b) => b?.type === "Text" || b?.type === "text").map((b) => b.text ?? "").join("\n");
    return text.trim() ? { role: "assistant", text } : null;
  }
  return null;
}

function readTail(file, maxBytes) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // starts mid-line
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Every conversation turn in the last `maxBytes` of the transcript, oldest first.
 * @param {{host: "claude"|"codex"|"code", file: string|null, maxBytes?: number}} o
 * @returns {{role: "user"|"assistant", text: string}[]}  [] when there is no readable transcript (Codex --ephemeral has none, and a
 *   Claude session's first prompt fires before its file exists)
 */
export function conversationTurns({ host, file, maxBytes = 4 * 1024 * 1024 }) {
  if (!file || !fs.existsSync(file)) return [];
  const parse = host === "claude" ? claudeConversationTurn : codexConversationTurn;
  const turns = [];
  for (const line of readTail(file, maxBytes)) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; } // a line cut at the tail window or still being written
    const t = parse(r);
    if (t) turns.push(t);
  }
  return turns;
}

/**
 * What the user was answering when they sent `currentPrompt`: the agent's last reply and the owner message before it. The host may already
 * have written the new prompt to the transcript, so a trailing owner turn equal to it is not "earlier".
 * @returns {{prevOwner: string|null, assistant: string|null}}
 */
export function priorContext(turns, currentPrompt) {
  const turnsBefore = [...turns];
  const last = turnsBefore[turnsBefore.length - 1];
  if (last?.role === "user" && norm(last.text) === norm(currentPrompt)) turnsBefore.pop();
  const lastOf = (role) => turnsBefore.findLast((t) => t.role === role)?.text ?? null;
  return { prevOwner: lastOf("user"), assistant: lastOf("assistant") };
}
