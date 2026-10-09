// Codex (and Every Code) rollouts: <home>/sessions/YYYY/MM/DD/rollout-<ts>-<thread uuid>.jsonl[.zst].
// Whose session is it: session_meta (line 1) says. Interactive human sessions are thread_source "user" with source vscode/cli/...;
// source "exec" (codex exec) is a program's prompt, thread_source "subagent" (source is an object) is an agent's brief: neither is mined.
// What the user typed: the clean signal is event_msg/item_completed with item.type "UserMessage" (what the UI treats as a user turn).
// Older rollouts (and Every Code's) have no such events; their `response_item` user messages are polluted with AGENTS.md, environment
// context and envelopes, so they are only used when a file has no UserMessage events at all, and ownerText() peels what is left.
// The oldest rollouts have no session_meta at all (codex-legacy.mjs): a bare header line, then bare response items.
import { legacyItem, legacyVerdict } from "./codex-legacy.mjs";

export { parseLegacyHeader } from "./codex-legacy.mjs";

const META = Buffer.from('"type":"session_meta"');
const USER_EVENT = Buffer.from('"UserMessage"');
const ROLE_USER = Buffer.from('"role":"user"');

/**
 * Is this session one a person typed into? `reason` says why not. A legacy session (no session_meta) is decided by `typedSessions`, the
 * session ids the homes' history.jsonl rows name (codex-legacy.mjs).
 * @param {object|null} meta parseSessionMeta() or parseLegacyHeader()
 * @param {{typedSessions?: Set<string>}} [o]
 */
export function sessionVerdict(meta, { typedSessions } = {}) {
  if (!meta || typeof meta !== "object") return { mine: false, reason: "no-session-meta" };
  if (meta.legacy === true) return legacyVerdict(meta, typedSessions);
  if (meta.thread_source === "subagent" || (meta.source && typeof meta.source === "object")) return { mine: false, reason: "subagent-session" };
  if (meta.source === "exec" || meta.originator === "codex_exec") return { mine: false, reason: "exec-session" };
  return { mine: true, reason: null };
}

export const isSessionMeta = (line) => line.indexOf(META) >= 0;

export function parseSessionMeta(line) {
  const r = JSON.parse(line.toString("utf8"));
  if (r?.type !== "session_meta") return null;
  const p = r.payload ?? {};
  return { id: p.id ?? null, cwd: p.cwd ?? null, git_url: p.git?.repository_url ?? null, source: p.source ?? null, thread_source: p.thread_source ?? null, originator: p.originator ?? null, timestamp: p.timestamp ?? r.timestamp ?? null };
}

/**
 * One line of a rollout. Returns {kind: "event"|"fallback", raw, ts} for a candidate user turn, or null (ts null for a legacy rollout's turn).
 * @param {Buffer} line
 */
export function codexTurn(line, tally) {
  const event = line.indexOf(USER_EVENT) >= 0;
  if (!event && line.indexOf(ROLE_USER) < 0) return null;
  let r;
  try { r = JSON.parse(line.toString("utf8")); } catch { tally.drop("unparsable"); return null; }
  if (event && r.type === "event_msg" && r.payload?.type === "item_completed" && r.payload.item?.type === "UserMessage") {
    const raw = (r.payload.item.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
    return raw ? { kind: "event", raw, ts: r.timestamp ?? null } : null;
  }
  if (r.type === "response_item" && r.payload?.type === "message" && r.payload.role === "user") {
    const raw = (r.payload.content ?? []).filter((b) => b?.type === "input_text" || b?.type === "text").map((b) => b.text).join("\n");
    return raw ? { kind: "fallback", raw, ts: r.timestamp ?? r.payload.timestamp ?? null } : null;
  }
  // a legacy rollout's bare item: no time of its own (the caller dates it with the session's start)
  const item = legacyItem(r);
  if (item?.type === "message" && item.role === "user") {
    const raw = (item.content ?? []).filter((b) => b?.type === "input_text" || b?.type === "text").map((b) => b.text).join("\n");
    return raw ? { kind: "fallback", raw, ts: null } : null;
  }
  return null;
}

/** The session id a rollout file is named after (`rollout-<time>-<session uuid>.jsonl[.zst]`). */
export const rolloutSessionId = (file) => String(file).split(/[\\/]/).pop().replace(/\.jsonl(\.zst)?$/, "").slice(-36);
