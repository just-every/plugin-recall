// Where a hook firing came from, recorded on every turn log line so the monitor (and `jq`) can say which home, project and transcript a
// turn belongs to. Pure functions of the parsed hook input; nothing here reads the disk.
import os from "node:os";
import path from "node:path";

/**
 * The agent home a transcript lives in, as "~/<dot-dir>" (for example "~/.claude", "~/.codex_work", "~/.code"), found by matching the
 * transcript path against the user's home dir. null when there is no transcript path, it is outside the home dir, or its first segment under
 * the home dir is not a dot-directory.
 */
export function homeOfTranscript(transcriptPath, homedir = os.homedir()) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  const rel = path.relative(homedir, transcriptPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0];
  return first.startsWith(".") && first.length > 1 ? `~/${first}` : null;
}

/** The fields every turn log line carries about its origin. `input` is parseHookInput()'s result. */
export function turnMeta(input, { homedir = os.homedir() } = {}) {
  const cwd = input.cwd ?? null;
  return {
    host: input.host,
    turn_key: input.turn_key ?? null,
    home: homeOfTranscript(input.transcript_path, homedir),
    cwd,
    project: cwd ? path.basename(cwd.replace(/[\\/]+$/, "")) || null : null,
    transcript: input.transcript_path ?? null,
  };
}
