// Which transcript files exist under a home. Never follows a symlink out, skips dot-directories,
// and never opens anything forbiddenPath() names (secrets, .ssh, auth.json, .credentials.json, .env, anything containing "token").
import fs from "node:fs";
import path from "node:path";
import { forbiddenPath } from "../text-filter/secrets.mjs";

const CLAUDE_FILE = /\.jsonl$/;
const CODEX_FILE = /^rollout-.*\.jsonl(\.zst)?$/;

function walk(root, match, { depth }) {
  const found = [];
  const visit = (dir, left) => {
    if (left < 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (forbiddenPath(full)) continue;
      if (entry.isDirectory()) visit(full, left - 1);
      else if (entry.isFile() && match.test(entry.name)) {
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        found.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  visit(root, depth);
  return found;
}

/**
 * Transcript files of one home, oldest first. Claude sub-agent transcripts (`.../subagents/...`) are not the user's and are not listed. A
 * Codex or Every Code home keeps live rollouts in sessions/YYYY/MM/DD/ and archived threads in archived_sessions/; both are listed (a rollout
 * in both places is listed twice: rollout-moves.mjs keeps one).
 */
export function listTranscripts(home, kind) {
  if (kind === "claude") {
    return walk(path.join(home, "projects"), CLAUDE_FILE, { depth: 7 })
      .filter((f) => !f.file.includes(`${path.sep}subagents${path.sep}`))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  }
  return [...walk(path.join(home, "sessions"), CODEX_FILE, { depth: 6 }), ...walk(path.join(home, "archived_sessions"), CODEX_FILE, { depth: 6 })]
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** Is this rollout in a home's archive (archived_sessions/) rather than its live sessions/? */
export const isArchivedRollout = (file) => String(file).includes(`${path.sep}archived_sessions${path.sep}`);

/** The typed-prompt log of a home (<home>/history.jsonl) as {file, size, mtimeMs}, or null when there is none. */
export function historyLog(home) {
  const file = path.join(home, "history.jsonl");
  if (forbiddenPath(file)) return null;
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? { file, size: stat.size, mtimeMs: stat.mtimeMs } : null;
  } catch { return null; }
}
