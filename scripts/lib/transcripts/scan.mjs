// The indexer's pass over one transcript file: the candidate owner turns it holds (from the scan state's offset on) and its new scan state.
//   claude  <home>/projects/<encoded cwd>/<session>.jsonl
//   codex   <home>/{sessions,archived_sessions}/**/rollout-*.jsonl[.zst] (Every Code the same): interactive sessions only. A legacy rollout
//           (no session_meta) is decided by the typed-prompt logs and dated with its session's start (codex-legacy.mjs). An Every Code
//           rollout's user turns are decided against the typed-prompt logs too (code-rollout.mjs); a turn that must wait for its log row stops
//           the pass before it (`pending` in the scan state), and the next pass reads on from there.
// A candidate is {raw, ts, host, session_id, repo, src} (plus `tsSeq` and `tsAlone` for a rollout turn that is not a legacy one: turn-identity.mjs); a Claude one also carries `claudeProject`, its project directory name (the key a
// Claude history row is matched with).
import path from "node:path";
import { repoFromProjectDir } from "../repo-of-dir.mjs";
import { repoOfSession } from "../repo-identity.mjs";
import { claudeTurn, isTempProjectDir } from "./claude.mjs";
import { codexTurn, isSessionMeta, parseLegacyHeader, parseSessionMeta, rolloutSessionId, sessionVerdict } from "./codex.mjs";
import { codeTurnVerdict } from "./code-rollout.mjs";
import { numberTimes } from "../turn-identity.mjs";
import { firstLine, scanLines } from "./lines.mjs";

/** @param {{tally: object, home: string}} ctx */
export async function scanClaudeFile(f, prev, ctx) {
  const session_id = path.basename(f.file, ".jsonl");
  const projectDir = path.basename(path.dirname(f.file));
  if (isTempProjectDir(projectDir)) {
    ctx.tally.drop("temp-cwd-session");
    return { out: [], state: { size: f.size, mtimeMs: f.mtimeMs, offset: f.size, lines: 0, skip: "temp-cwd-session" } };
  }
  const repo = repoFromProjectDir(projectDir);
  const out = [];
  const res = await scanLines(f.file, {
    offset: prev?.offset ?? 0,
    lineBase: prev?.lines ?? 0,
    onLine(line, lineNo) {
      const turn = claudeTurn(line, ctx.tally);
      // a project directory the disk cannot decode (a deleted worktree) leaves no repo: the turn's own cwd names it
      if (turn) out.push({ raw: turn.raw, ts: turn.ts, host: "claude", session_id, repo: repo ?? repoOfSession({ cwd: turn.cwd, home: ctx.home }), src: `${f.file}:L${lineNo}`, claudeProject: projectDir });
    },
  });
  return { out, state: { size: f.size, mtimeMs: f.mtimeMs, offset: res.offset, lines: res.lines } };
}

/** The session of a rollout from its first line: session_meta, else a legacy header, else null. */
async function rolloutMeta(file, zst) {
  const first = await firstLine(file, { zst });
  if (!first) return null;
  if (isSessionMeta(first)) return parseSessionMeta(first);
  return parseLegacyHeader(first);
}

/**
 * @param {"codex"|"code"} kind
 * @param {{tally: object, home: string, typedLogs: () => Promise<object>, agentHome: string, now: number}} ctx typedLogs: what the homes'
 *   typed-prompt logs say (typed-rows.mjs readTypedLogs), asked for only when a legacy or an Every Code rollout needs it; agentHome: the
 *   directory of the home the rollout is in
 */
export async function scanCodexFile(f, kind, prev, ctx) {
  const zst = f.file.endsWith(".zst");
  const meta = prev?.meta ?? await rolloutMeta(f.file, zst);
  if (!meta) { ctx.tally.drop("no-session-meta"); return { out: [], state: { size: f.size, mtimeMs: f.mtimeMs, offset: f.size, lines: 0, skip: "no-session-meta" } }; }
  const verdict = sessionVerdict(meta, meta.legacy ? { typedSessions: (await ctx.typedLogs()).sessions } : {});
  if (!verdict.mine) {
    ctx.tally.drop(verdict.reason);
    return { out: [], state: { size: f.size, mtimeMs: f.mtimeMs, offset: f.size, lines: 0, meta, skip: verdict.reason } };
  }
  const host = kind;
  const session_id = meta.id ?? rolloutSessionId(f.file);
  const repo = repoOfSession({ cwd: meta.cwd, gitUrl: meta.git_url ?? null, home: ctx.home });
  const events = [];
  const fallback = [];
  let seenEvents = prev?.seenEvents ?? false;
  let at = zst ? 0 : prev?.offset ?? 0; // byte offset of the line being read: where a pass that must wait stops
  const res = await scanLines(f.file, {
    zst,
    offset: prev?.offset ?? 0,
    lineBase: prev?.lines ?? 0,
    onLine(line, lineNo) {
      const start = at;
      at += line.length + 1;
      const turn = codexTurn(line, ctx.tally);
      if (!turn) return;
      // a legacy rollout's records carry no time: its turns are dated with the session's start
      const row = { raw: turn.raw, ts: meta.legacy ? meta.timestamp : turn.ts, host, session_id, repo, src: `${f.file}:L${lineNo}` };
      if (turn.kind === "event") { seenEvents = true; events.push(row); } else fallback.push({ row, start, lineNo });
    },
  });
  if (fallback.length && seenEvents) ctx.tally.drop("response-item-superseded-by-user-message-event");
  let end = res;
  const turns = seenEvents ? events : fallback.map((x) => x.row);
  // the turns of the file that share a time are numbered (turn-identity.mjs); a legacy rollout's all share its session's start
  let tsTail = meta.legacy ? null : numberTimes(turns, prev?.tsTail);
  let out = turns;
  if (kind === "code" && !seenEvents && fallback.length) {
    const typed = await ctx.typedLogs();
    out = [];
    for (const { row, start, lineNo } of fallback) {
      const v = codeTurnVerdict(row, { typed, home: ctx.agentHome, now: ctx.now });
      if (v === "wait") {
        end = { offset: start, lines: lineNo - 1, pending: true };
        const i = turns.indexOf(row);
        tsTail = i > 0 ? { ts: turns[i - 1].ts, n: turns[i - 1].tsSeq + 1 } : prev?.tsTail ?? null;
        break;
      }
      if (v === "keep") out.push(row);
      else ctx.tally.drop(v);
    }
  }
  return { out, state: { size: f.size, mtimeMs: f.mtimeMs, offset: end.offset, lines: end.lines, meta, seenEvents, ...(tsTail ? { tsTail } : {}), ...(end.pending ? { pending: true } : {}) } };
}
