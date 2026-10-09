// The per-turn JSONL log: <dataDir>/logs/turns-YYYY-MM-DD.jsonl, one line per hook invocation, holding the query, the
// candidates with their scores, and what was injected or returned. Failures are written here at level "error" AND to stderr.
import fs from "node:fs";
import path from "node:path";

export function createTurnLog(dir, { now = () => new Date() } = {}) {
  const logDir = path.join(dir, "logs");
  return {
    write(entry) {
      const ts = now().toISOString();
      fs.mkdirSync(logDir, { recursive: true });
      const line = JSON.stringify({ ts, level: "info", ...entry });
      fs.appendFileSync(path.join(logDir, `turns-${ts.slice(0, 10)}.jsonl`), `${line}\n`);
      if (entry.level === "error") process.stderr.write(`[recall ERROR] ${entry.event ?? ""} ${entry.error ?? entry.reason ?? ""}\n`);
      return ts;
    },
  };
}

/** Per-session state of the prompt hook: the ids of the statements already injected in the session (noRepeat). */
export function createTurnState(dir) {
  const file = (session) => path.join(dir, "turns", `${String(session).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  return {
    read(session) {
      let text;
      try { text = fs.readFileSync(file(session), "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
      try { return JSON.parse(text); } catch { throw new Error(`session state ${file(session)} is not valid JSON`); }
    },
    write(session, state) {
      const f = file(session);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, f);
    },
  };
}
