// `recall show <statement-id>`: the conversation around an indexed statement, read from the transcript the statement came from (or, for a
// statement from a typed-prompt log, the rows of its session around it). Reads only:
// no API call, nothing written except one turn-log line saying that an agent (or the owner) looked, which the monitor counts.
import fs from "node:fs";
import path from "node:path";
import { parseSrc } from "./cards/context-source.mjs";
import { formatExcerpt, viewOf } from "./show-format.mjs";
import { createStore } from "./store.mjs";
import { createTurnLog } from "./turn-log.mjs";
import { homeOfTranscript } from "./turn-meta.mjs";
import { ExcerptError, readExcerpt } from "./transcripts/excerpt.mjs";
import { isHistoryFile } from "./transcripts/history.mjs";
import { readHistoryExcerpt } from "./transcripts/history-context.mjs";

export const DEFAULT_BEFORE = 4;
export const DEFAULT_AFTER = 3;
/** Where a host puts the session id of the agent that runs a shell command, in the order tried. */
export const SESSION_ENV = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID"];

export class ShowError extends Error {
  constructor(message) { super(message); this.name = "ShowError"; }
}

/** The caller's session, if the environment says (null otherwise: a shell run by hand has none). */
export const callerSession = (env) => SESSION_ENV.map((k) => env[k]).find((v) => typeof v === "string" && v) ?? null;

/**
 * @param {{id: string, before?: number, after?: number, config: object, env?: object, cwd?: string, now?: () => Date, homedir?: string}} o
 * @returns {Promise<{view: object, text: string}>}
 * @throws {ShowError} an unknown id, a statement without a transcript source, a missing or rewritten transcript
 */
export async function showStatement({ id, before = DEFAULT_BEFORE, after = DEFAULT_AFTER, config, env = process.env, cwd = process.cwd(), now = () => new Date(), homedir }) {
  for (const [name, n] of [["--before", before], ["--after", after]]) if (!Number.isInteger(n) || n < 0 || n > 50) throw new ShowError(`${name} must be an integer from 0 to 50`);
  const statement = createStore(config.dataDir).loadStatements().find((s) => s.id === id);
  if (!statement) throw new ShowError(`no statement with id ${JSON.stringify(id)} in ${path.join(config.dataDir, "statements.jsonl")}`);
  const src = parseSrc(statement.src);
  if (!src) throw new ShowError(`statement ${id} has no transcript source (src is ${JSON.stringify(statement.src ?? null)})`);
  if (!fs.existsSync(src.file)) throw new ShowError(`the transcript of statement ${id} is gone: ${src.file} (it was moved, deleted or is not on this machine)`);
  let excerpt;
  try {
    // a statement from a typed-prompt log is shown with the rows of its session around it (a log has no replies)
    excerpt = isHistoryFile(src.file)
      ? await readHistoryExcerpt({ file: src.file, line: src.line, statementText: statement.text, before, after, config, host: statement.host })
      : await readExcerpt({ file: src.file, host: statement.host, line: src.line, statementText: statement.text, before, after, config });
  } catch (e) {
    if (e instanceof ExcerptError) throw new ShowError(`statement ${id}: ${e.message}`);
    throw e;
  }
  const view = viewOf({ statement, file: src.file, line: src.line, items: excerpt.items, home: homeOfTranscript(src.file, homedir), before, after });
  createTurnLog(config.dataDir, { now }).write({ event: "show", statement_id: id, cwd, project: path.basename(cwd.replace(/[\\/]+$/, "")) || null, session_id: callerSession(env), before, after });
  return { view, text: formatExcerpt(view, { homedir }) };
}
