// Typed-prompt logs: <home>/history.jsonl. A host appends one row per prompt submitted at its prompt (a program's prompt, `codex exec` or
// `claude -p`, is never written there). Not every row is the person's: a host can submit a prompt through the same path, and Every Code did
// until late October 2025 (its Auto Drive coordinator's prompts and the auto-resolve loop's canned request: auto-drive.mjs, owner-filter.mjs);
// Every Code also records its own notices there as if typed (owner-filter.mjs). The log outlives the transcripts: Claude Code deletes
// transcripts after a retention period, rollouts get archived or deleted, a home is copied to a backup or another machine without its sessions.
//   Codex, Every Code  {session_id, ts, text}                                    ts in unix seconds
//   Claude Code        {display, pastedContents, timestamp, project, sessionId?} timestamp in ms; a paste shows in `display` as
//                      "[Pasted text #1 +5 lines]" and its text is pastedContents["1"].content; sessionId is absent in older rows
// A row starting with a slash command (`/plan add the export`, `/model`) keeps what was typed after the command, as a transcript keeps
// `<command-args>`; a bare command leaves nothing.
import path from "node:path";
import { scanLines } from "./lines.mjs";

export const HISTORY_FILE = "history.jsonl";

/** Is this file a typed-prompt log (a statement's src names it)? Transcripts are `<session>.jsonl` and `rollout-*.jsonl[.zst]`. */
export const isHistoryFile = (file) => path.basename(String(file)) === HISTORY_FILE;

const SLASH_COMMAND = /^\s*\/[a-z][\w:-]*(?=\s|$)/;
const PASTE_REF = /\[Pasted text #(\d+)(?: \+\d+ lines?)?\]/g;

/** The display text with every paste whose text the row kept put back in place (a paste stored elsewhere keeps its placeholder). */
function expandPastes(display, pasted) {
  if (!pasted || typeof pasted !== "object") return display;
  return display.replace(PASTE_REF, (ref, n) => {
    const p = pasted[n];
    return p?.type === "text" && typeof p.content === "string" ? p.content : ref;
  });
}

const isoOf = (ms) => {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

/**
 * One parsed history line, or null when it is not a row of either shape.
 * @returns {{session_id: string|null, ts: string|null, raw: string, project: string|null}|null}
 */
export function parseHistoryRow(record) {
  if (!record || typeof record !== "object") return null;
  if (typeof record.text === "string" && typeof record.session_id === "string") {
    return { session_id: record.session_id, ts: typeof record.ts === "number" ? isoOf(record.ts * 1000) : null, raw: record.text.replace(SLASH_COMMAND, ""), project: null };
  }
  if (typeof record.display === "string") {
    return {
      session_id: typeof record.sessionId === "string" && record.sessionId ? record.sessionId : null,
      ts: typeof record.timestamp === "number" ? isoOf(record.timestamp) : null,
      raw: expandPastes(record.display, record.pastedContents).replace(SLASH_COMMAND, ""),
      project: typeof record.project === "string" && record.project ? record.project : null,
    };
  }
  return null;
}

/** The slash command a row starts with (`/auto`), or null: what parseHistoryRow takes off the row's text. */
function rowCommand(record) {
  const typed = typeof record.text === "string" ? record.text : record.display;
  return SLASH_COMMAND.exec(typed)?.[0].trim() ?? null;
}

/** Parse one line (a Buffer or a string) to parseHistoryRow's row plus `command`; an unparsable line is null and the caller counts it. */
export function historyLine(line) {
  let record;
  try { record = JSON.parse(line.toString("utf8")); } catch { return null; }
  const row = parseHistoryRow(record);
  return row ? { ...row, command: rowCommand(record) } : null;
}

/** Every row of a history file with its 1-based line number, in file order. */
export async function readHistoryRows(file) {
  const rows = [];
  await scanLines(file, {
    onLine(line, lineNo) {
      const row = historyLine(line);
      if (row) rows.push({ ...row, line: lineNo });
    },
  });
  return rows;
}

/** The Claude Code project directory name of a working directory: every character that is not a letter or a digit becomes "-". */
export const claudeProjectDir = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
