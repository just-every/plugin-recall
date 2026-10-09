// Claude Code transcripts: <home>/projects/<encoded cwd>/<session>.jsonl.
// A human-typed turn is `type:"user"`, not a sidechain, not meta, `origin.kind:"human"` (Claude 2.1.28x). Everything else shaped like a
// user turn is not the user: tool results, task notifications, peer messages, skill bodies, `claude -p` prompts (origin absent,
// entrypoint sdk-cli). Older transcripts have no `origin`; those fall back to the text rules (ownerText decides the rest).
// A message typed while the agent was working is NOT a user record: it is an `attachment` of type `queued_command` with
// origin.kind "human" (easy to miss, see docs/hosts.md section 3.1).

const USER = Buffer.from('"type":"user"');
const QUEUED = Buffer.from('"queued_command"');
const TOOL_RESULT = Buffer.from('"type":"tool_result"');

/**
 * Claude Code names a session's project directory after its cwd. A session run in a temp directory (`/private/var/folders/.../T/...`,
 * `/private/tmp/...`) is a program's worker (a tool's judge or caption call, a worker in a scratchpad), not a person at a keyboard.
 * Measured on one developer's homes: 432 user turns in such directories, 1 of them origin human ("hi").
 */
export const isTempProjectDir = (name) => /^-(private-)?(var-folders|tmp)-/.test(String(name));

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  return null;
};

/**
 * @param {Buffer} line
 * @param {{drop: (reason: string) => void}} tally
 * @returns {{raw: string, ts: string|null, via: "typed"|"queued", cwd: string|null}|null} the user's raw turn, or null (counted in the tally when it was a candidate)
 */
export function claudeTurn(line, tally) {
  const queued = line.indexOf(QUEUED) >= 0;
  if (!queued) {
    if (line.indexOf(USER) < 0) return null;
    if (line.indexOf(TOOL_RESULT) >= 0) { tally.drop("tool-result"); return null; }
  }
  let r;
  try { r = JSON.parse(line.toString("utf8")); } catch { tally.drop("unparsable"); return null; }
  if (r.isSidechain === true) { tally.drop("sidechain"); return null; }
  if (r.type === "attachment") {
    const a = r.attachment;
    if (a?.type !== "queued_command") return null;
    if (a.origin?.kind !== "human") { tally.drop(`queued-${a.origin?.kind ?? "no-origin"}`); return null; }
    const raw = textOf(a.prompt);
    return raw ? { raw, ts: r.timestamp ?? a.timestamp ?? null, via: "queued", uuid: r.uuid ?? null, cwd: r.cwd ?? null } : null;
  }
  if (r.type !== "user") return null;
  if (r.isCompactSummary === true) { tally.drop("compact-summary"); return null; }
  if (r.isMeta === true) { tally.drop("harness"); return null; }
  const content = r.message?.content;
  if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) { tally.drop("tool-result"); return null; }
  if (r.origin) {
    if (r.origin.kind !== "human") { tally.drop(`origin-${r.origin.kind}`); return null; }
  } else if (r.entrypoint === "sdk-cli" || r.promptSource === "system" || r.turnOrigin === "sdk") {
    // No origin: older transcripts. A program's prompt says so itself (entrypoint sdk-cli, promptSource system, turnOrigin sdk: found on
    // `claude -p` workers, tools' captions and judges, "Reply with exactly: ok" probes); anything else is left to ownerText().
    tally.drop("programmatic");
    return null;
  }
  const raw = textOf(content);
  if (!raw) return null;
  return { raw, ts: r.timestamp ?? null, via: "typed", uuid: r.uuid ?? null, cwd: r.cwd ?? null };
}
