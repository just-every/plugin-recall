// Every Code's Auto Drive in its typed-prompt log (transcripts/auto-drive.mjs): until late October 2025 the coordinator's prompts were written
// there as if typed. Every row of a session after its /auto row and dated before the cutoff is dropped; the /auto row keeps the goal the
// person typed; rows from the cutoff on, other sessions, and Codex logs are untouched. The scan state carries the sessions a run started in,
// so a later pass over the same log still knows them; cards and `recall show` leave the same rows out. Synthetic rows, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { showStatement } from "../scripts/lib/show.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { AUTO_DRIVE_PERSISTED_BEFORE, autoDriveLines, autoDriveTracker } from "../scripts/lib/transcripts/auto-drive.mjs";
import { historyContexts } from "../scripts/lib/transcripts/history-context.mjs";
import { historyLine } from "../scripts/lib/transcripts/history.mjs";
import { tmpDir } from "./helpers.mjs";

const RUN = "0190e000-ad00-7000-8000-00000000ad01"; // a session that starts an Auto Drive run in September 2025
const PLAIN = "0190e000-ad00-7000-8000-00000000ad02"; // a session of the same days without one
const LATE = "0190e000-ad00-7000-8000-00000000ad03"; // a run started after the cutoff: nothing of it was persisted, every row is typed
const SEP = Date.parse("2025-09-20T09:00:00.000Z") / 1000;
const NOV = Date.parse("2025-11-04T09:00:00.000Z") / 1000;
const NOW = () => Date.parse("2026-10-01T00:00:00.000Z");

const ROWS = [
  { session_id: RUN, ts: SEP, text: "Before the run: keep the invoice numbers stable across exports please" },
  { session_id: RUN, ts: SEP + 60, text: "/auto rework the invoice exporter so it streams rows instead of buffering them" },
  { session_id: RUN, ts: SEP + 95, text: "Primary goal: rework the invoice exporter to stream rows. Plan first, then implement in small steps." },
  { session_id: RUN, ts: SEP + 400, text: "/review" },
  { session_id: RUN, ts: SEP + 700, text: "Focus files: `src/export/stream.ts`, `src/export/csv.ts`. Add a regression test for the 10k row case." },
  { session_id: PLAIN, ts: SEP + 800, text: "In the plain session: the export button should stay disabled while a file is generated" },
  { session_id: RUN, ts: SEP + 900, text: "That last change broke the totals row, please look at it again before going on" },
  { session_id: LATE, ts: NOV, text: "/auto tidy the ledger module and keep its public functions unchanged" },
  { session_id: LATE, ts: NOV + 300, text: "After the cutoff a row in a run session is the person again, typed while it ran" },
  { session_id: RUN, ts: NOV + 600, text: "Weeks later in the same session: the streaming exporter is fine, ship it" },
];
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const parsed = (rows) => rows.map((r, i) => ({ ...historyLine(JSON.stringify(r)), line: i + 1 }));

function world({ kind = ".code", rows = ROWS } = {}) {
  const root = tmpDir("recall-auto-drive");
  const home = path.join(root, kind);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "history.jsonl"), jsonl(rows));
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  return { root, home, config, store, file: path.join(home, "history.jsonl"), run: (o = {}) => runIndex({ config, store, homeDir: root, env: {}, embed: false, now: NOW, ...o }) };
}

test("autoDriveTracker: after a session's /auto row, its rows dated before the cutoff are submissions; the /auto row, other sessions and later rows are not", () => {
  assert.equal(AUTO_DRIVE_PERSISTED_BEFORE, Date.parse("2025-10-23T00:00:00.000Z"));
  assert.equal(historyLine(JSON.stringify(ROWS[1])).command, "/auto");
  assert.equal(historyLine(JSON.stringify(ROWS[0])).command, null);
  assert.deepEqual([...autoDriveLines(parsed(ROWS))], [3, 4, 5, 7], "the coordinator's prompts, and the slash command and the interjection inside the run: the log does not mark the run's end");
  // a pass that starts mid-log gets the run's sessions from the scan state
  const later = autoDriveTracker({ [RUN]: (SEP + 700) * 1000 });
  assert.equal(later.isSubmission(parsed(ROWS)[6]), true);
  assert.equal(later.isSubmission(parsed(ROWS)[9]), false, "dated after the cutoff");
  assert.equal(autoDriveTracker().isSubmission({ session_id: RUN, ts: null, command: null }), false);
});

test("Every Code history: Auto Drive submissions are not statements; the goal typed after /auto is; the scan state keeps the run's session", async () => {
  const w = world();
  const report = await w.run();
  const texts = w.store.loadStatements().map((s) => s.text);
  assert.deepEqual(texts, [
    "Before the run: keep the invoice numbers stable across exports please",
    "rework the invoice exporter so it streams rows instead of buffering them",
    "In the plain session: the export button should stay disabled while a file is generated",
    "tidy the ledger module and keep its public functions unchanged",
    "After the cutoff a row in a run session is the person again, typed while it ran",
    "Weeks later in the same session: the streaming exporter is fine, ship it",
  ]);
  assert.equal(report.excluded["auto-drive"], 4);
  assert.deepEqual(w.store.loadState().files[w.file].autoDrive, { [RUN]: (SEP + 900) * 1000 });
});

test("Every Code history: a row appended later to a run session (dated before the cutoff) is still a submission", async () => {
  const w = world({ rows: ROWS.slice(0, 3) });
  await w.run();
  assert.equal(w.store.loadStatements().length, 2);
  fs.appendFileSync(w.file, jsonl([{ session_id: RUN, ts: SEP + 1200, text: "Next step: wire the streaming writer into the CLI and remove the buffered path entirely" }]));
  const again = await w.run();
  assert.equal(again.scanned, 1);
  assert.equal(again.added, 0);
  assert.equal(again.excluded["auto-drive"], 1);
});

test("a Codex log is not Every Code: a row after an /auto row there is a statement like any other", async () => {
  const w = world({ kind: ".codex" });
  const report = await w.run();
  assert.equal(report.excluded["auto-drive"], undefined);
  assert.ok(w.store.loadStatements().some((s) => s.text.startsWith("Primary goal: rework the invoice exporter")));
});

test("cards and recall show leave Auto Drive submissions out of an Every Code statement's session", async () => {
  const w = world();
  await w.run();
  const goal = w.store.loadStatements().find((s) => s.text.startsWith("rework the invoice exporter"));
  const { view } = await showStatement({ id: goal.id, before: 3, after: 3, config: w.config, env: {}, cwd: w.root, homedir: w.root });
  assert.deepEqual(view.items.map((it) => it.line), [1, 2, 10], "the rows of the run session that the person typed");
  const weeks = w.store.loadStatements().find((s) => s.text.startsWith("Weeks later"));
  const ctx = await historyContexts({ file: w.file, config: w.config, host: "code", targets: [{ key: "k", line: 10, text: weeks.text }] });
  assert.deepEqual(ctx.get("k"), { owner: "rework the invoice exporter so it streams rows instead of buffering them", assistant: null });
});
