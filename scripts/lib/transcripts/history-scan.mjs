// The indexer's pass over one typed-prompt log (history.mjs). Incremental like a transcript: the scan state keeps (size, mtime, byte offset,
// line count) and a grown log is read from where the last pass stopped.
//
// A transcript is the authoritative copy of a turn, so a row is a candidate only when no transcript already yields that statement:
//   Codex, Every Code  the session has a rollout (sessions/ or archived_sessions/ of any home read) -> the row is skipped, whatever the
//                      rollout says (an exec or sub-agent rollout is not the owner's, and its rows are not either)
//   Claude Code        a transcript statement with the same normalized text in the same project -> the row is skipped (the caller
//                      decides that once the row is judged: it needs the statement's text)
//   Every Code /auto   the goal typed after /auto, in a session that has a rollout: the rollout holds no turn of it the person typed (Auto
//                      Drive sends the coordinator's "Primary Goal: <goal> ..." wrapper, which is not the person's), so the row is the goal's
//                      only copy and a candidate (`autoGoal`); the caller skips it when a rollout statement of the session has its text
// The youngest rows wait: a row written in the last HISTORY_SETTLE_MS may belong to a session whose transcript is not on disk yet, so the
// pass stops before it and the next pass reads it.
// An Every Code log holds its Auto Drive coordinator's prompts of 2025 (auto-drive.mjs): they are dropped, and the runs still on where the
// pass stopped (session -> time of its last row) are kept in the scan state (`autoDrive`) so a pass that starts mid-log still knows them.
import { repoOfSession } from "../repo-identity.mjs";
import { norm } from "../text.mjs";
import { AUTO_COMMAND, autoDriveTracker } from "./auto-drive.mjs";
import { isTempProjectDir } from "./claude.mjs";
import { claudeProjectDir, historyLine } from "./history.mjs";
import { scanLines } from "./lines.mjs";

export const HISTORY_SETTLE_MS = 10 * 60_000;

/**
 * @param {{file: string, size: number, mtimeMs: number}} f
 * @param {object|null} prev the file's scan state
 * @param {{kind: "claude"|"codex"|"code", rolloutSessions: Set<string>, tally: object, home: string, now?: number}} ctx home: the user's
 *   home folder (a Claude row's repo is read from its project path against it)
 * @returns {Promise<{out: object[], state: object}>} candidates shaped like a transcript's ({raw, ts, host, session_id, repo, src}), Claude
 *   ones with `claudeProject` (the project directory name the dedupe key needs)
 */
export async function scanHistoryFile(f, prev, { kind, rolloutSessions, tally, home, now = Date.now() }) {
  const out = [];
  const settleBefore = now - HISTORY_SETTLE_MS;
  let at = prev?.offset ?? 0;
  let stop = null; // where the pass stopped, before a row that must wait
  const autoDrive = kind === "code" ? autoDriveTracker(prev?.autoDrive) : null;
  const res = await scanLines(f.file, {
    offset: prev?.offset ?? 0,
    lineBase: prev?.lines ?? 0,
    onLine(line, lineNo) {
      const row = historyLine(line);
      if (row?.ts && Date.parse(row.ts) > settleBefore) { stop = { offset: at, lines: lineNo - 1 }; return false; }
      at += line.length + 1;
      if (!row) { tally.drop("history-unparsable"); return undefined; }
      if (autoDrive?.isSubmission(row)) { tally.drop("auto-drive"); return undefined; }
      const src = `${f.file}:L${lineNo}`;
      if (kind === "claude") {
        const projectDir = row.project ? claudeProjectDir(row.project) : null;
        if (projectDir && isTempProjectDir(projectDir)) { tally.drop("temp-cwd-session"); return undefined; }
        out.push({ raw: row.raw, ts: row.ts, host: "claude", session_id: row.session_id, repo: row.project ? repoOfSession({ cwd: row.project, home }) : null, src, claudeProject: projectDir });
        return undefined;
      }
      const autoGoal = kind === "code" && row.command === AUTO_COMMAND;
      if (rolloutSessions.has(row.session_id) && !autoGoal) { tally.drop("history-session-has-rollout"); return undefined; }
      out.push({ raw: row.raw, ts: row.ts, host: kind, session_id: row.session_id, repo: null, src, ...(autoGoal ? { autoGoal: true } : {}) });
      return undefined;
    },
  });
  const end = stop ?? res;
  const running = autoDrive?.running() ?? {};
  // pending: rows were left to settle, so the next pass reads this log again even when it has not changed
  return { out, state: { size: f.size, mtimeMs: f.mtimeMs, offset: end.offset, lines: end.lines, ...(stop ? { pending: true } : {}), ...(Object.keys(running).length ? { autoDrive: running } : {}) } };
}

/** The key that says a Claude statement was said in a project: the project directory name and the statement's normalized text. */
export const claudeStatementKey = (projectDir, text) => `${projectDir}\u0000${norm(text)}`;

/** The key that says a statement was said in a session (an Every Code rollout's, matched against an /auto goal row). */
export const sessionStatementKey = (sessionId, text) => `${sessionId}\u0000${norm(text)}`;
