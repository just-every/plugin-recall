// What the monitor shows about the memory index, read-only: the statement count and its split by host (by tailing statements.jsonl), the time
// of the last index run (state/last-index.json), and a lookup of statement text by id for the Stop audit's candidates.
import fs from "node:fs";
import path from "node:path";
import { createTailer } from "./tailer.mjs";

const TEXT_MAX = 600;

export function createIndexInfo(dataDir) {
  const rows = new Map();
  const byHost = {};
  let lastIndex = null;
  let lastIndexMtime = 0;

  const clear = () => { rows.clear(); for (const k of Object.keys(byHost)) delete byHost[k]; };
  const tailer = createTailer(path.join(dataDir, "statements.jsonl"), {
    onLine(r) {
      if (typeof r?.id !== "string" || rows.has(r.id)) return;
      rows.set(r.id, { id: r.id, text: String(r.text ?? "").slice(0, TEXT_MAX), ts: r.ts ?? null, repo: r.repo ?? null, host: r.host ?? null, session_id: r.session_id ?? null, src: r.src ?? null });
      const h = r.host ?? "unknown";
      byHost[h] = (byHost[h] ?? 0) + 1;
    },
    onReset: clear,
  });
  const lastIndexFile = path.join(dataDir, "state", "last-index.json");

  function readLastIndex() {
    let st;
    try { st = fs.statSync(lastIndexFile); } catch (e) { if (e.code === "ENOENT") { const had = lastIndex !== null; lastIndex = null; lastIndexMtime = 0; return had; } throw e; }
    if (st.mtimeMs === lastIndexMtime) return false;
    lastIndexMtime = st.mtimeMs;
    try {
      const r = JSON.parse(fs.readFileSync(lastIndexFile, "utf8"));
      lastIndex = { at: r.at ?? null, added: r.added ?? null, durationMs: r.durationMs ?? null, homes: Array.isArray(r.homes) ? r.homes.length : null, costUsd: r.embedding?.costUsd ?? null };
    } catch { lastIndex = null; lastIndexMtime = 0; } // being rewritten: read it again on the next poll
    return true;
  }

  return {
    /** @returns {boolean} whether anything changed */
    poll() {
      const n = tailer.poll();
      return readLastIndex() || n > 0;
    },
    summary: () => ({ statements: rows.size, byHost: { ...byHost }, lastIndex }),
    statements: (ids) => ids.map((id) => rows.get(id)).filter(Boolean),
  };
}
