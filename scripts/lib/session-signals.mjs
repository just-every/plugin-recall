// Readers for the on-disk evidence of WHO is driving a session. Nothing here decides; headless.mjs does. See docs/hosts.md section 6 for
// the real lines these were written against.
//   Claude Code: the newest real user record of the session transcript carries `entrypoint` (sdk-cli | sdk-ts | sdk-py for programmatic
//                runs, claude-desktop / cli / ... otherwise), `turnOrigin` (human | sdk | task_notification ...), `origin.kind` and
//                `promptSource`. The transcript may not exist yet at the first UserPromptSubmit of a session.
//   Codex / Every Code: line 1 of the rollout is session_meta {originator, source, thread_source}.
import fs from "node:fs";
import { firstLine } from "./transcripts/lines.mjs";
import { isSessionMeta, parseSessionMeta } from "./transcripts/codex.mjs";

const TAIL_BYTES = 1_000_000;

/** The signals of one Claude transcript record, or null if it is not a real user record (tool result, meta, sidechain, other types). */
export function claudeUserSignals(r) {
  if (r?.type !== "user" || r.isMeta === true || r.isSidechain === true) return null;
  if (Array.isArray(r.message?.content) && r.message.content.some((b) => b?.type === "tool_result")) return null;
  return {
    entrypoint: typeof r.entrypoint === "string" ? r.entrypoint : null,
    turnOrigin: typeof r.turnOrigin === "string" ? r.turnOrigin : null,
    promptSource: typeof r.promptSource === "string" ? r.promptSource : null,
    originKind: typeof r.origin?.kind === "string" ? r.origin.kind : null,
    timestamp: typeof r.timestamp === "string" ? r.timestamp : null,
  };
}

/**
 * The newest real user record in a Claude transcript (read from the last ~1 MB), or null when the file does not exist yet or holds none.
 * Any other read error throws: the caller fails closed and logs it.
 */
export function lastClaudeUser(file) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.allocUnsafe(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const lines = buf.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // the first line of a tail read is cut
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"type":"user"') || line.includes('"type":"tool_result"')) continue;
      let r = null;
      try { r = JSON.parse(line); } catch { continue; } // a line still being written
      const sig = claudeUserSignals(r);
      if (sig) return sig;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** session_meta of a Codex / Every Code rollout: {id, cwd, source, thread_source, originator, timestamp}, or null if line 1 is not one. */
export async function rolloutMeta(file) {
  const first = await firstLine(file);
  if (!first || !isSessionMeta(first)) return null;
  return parseSessionMeta(first);
}
