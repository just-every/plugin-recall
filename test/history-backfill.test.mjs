// The one-time backfill (peel-backfill.mjs) covers the typed-prompt logs as well as the transcripts: an unchanged history.jsonl whose scan
// state records an older peel version is read once more from the start, the row that holds a statement keeps it, and a row that holds none is
// judged again. Synthetic log rows, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { buildStatement, runIndex } from "../scripts/lib/indexer.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { PEEL_VERSION } from "../scripts/lib/transcripts/peel-backfill.mjs";
import { tmpDir } from "./helpers.mjs";

test("backfill: an unchanged history.jsonl stamped with an older peel is read again; its rows without a statement are judged", async () => {
  const root = tmpDir("recall-history-backfill");
  const home = path.join(root, ".codex");
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "history.jsonl");
  const ts = Math.floor(Date.parse("2026-08-01T09:00:00.000Z") / 1000);
  const rows = [
    { session_id: "0190f000-4444-7000-8000-000000004401", ts, text: "Keep the invoice numbers stable across every export format" },
    { session_id: "0190f000-4444-7000-8000-000000004401", ts: ts + 60, text: "And print the export date in the footer of each page" },
  ];
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  const first = buildStatement({ raw: rows[0].text, ts: new Date(ts * 1000).toISOString(), host: "codex", session_id: rows[0].session_id, repo: null, src: `${file}:L1` }, config).statement;
  store.appendStatements([first]);
  const stat = fs.statSync(file);
  store.saveState({ files: { [file]: { size: stat.size, mtimeMs: stat.mtimeMs, offset: stat.size, lines: 2, peel: 0 } }, lastIndexAt: null });
  const report = await runIndex({ config, store, homeDir: root, env: {}, embed: false, now: () => Date.parse("2026-10-01T00:00:00.000Z") });
  assert.equal(report.backfilled, 1);
  assert.equal(report.backfillLinesKept, 1);
  assert.deepEqual(store.loadStatements().map((s) => [s.id === first.id, s.text]), [[true, rows[0].text], [false, rows[1].text]]);
  assert.equal(store.loadState().files[file].peel, PEEL_VERSION);
});
