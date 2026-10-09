// The one-time backfill (transcripts/peel-backfill.mjs): an index built before the 0.4.0 peels has scan states without a peel version, and an
// unchanged file is never read again, so the turns those peels now keep would never reach it. A file whose state has no (or an older) peel
// version is read once more from the start; a line that holds a statement keeps it (same id, no second statement); a line that held none is
// judged again; the state is stamped and the file is not read again while unchanged. Synthetic rollouts and a hand-made 0.3.1 index.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { buildStatement, runIndex } from "../scripts/lib/indexer.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { PEEL_VERSION, needsPeelBackfill, stampPeel } from "../scripts/lib/transcripts/peel-backfill.mjs";
import { norm, sha1, textHash } from "../scripts/lib/text.mjs";
import { codexAgent, codexUser, writeTranscript } from "./transcript-builders.mjs";
import { tmpDir } from "./helpers.mjs";

const SESSION = "0190f000-bf11-7000-8000-00000000bf01";
const NAME = `rollout-2026-09-05T10-00-00-${SESSION}.jsonl`;
const T = ["2026-09-05T10:00:05.000Z", "2026-09-05T10:02:00.000Z", "2026-09-05T10:04:00.000Z", "2026-09-06T09:00:00.000Z"];
const meta = JSON.stringify({ timestamp: "2026-09-05T10:00:00.000Z", type: "session_meta", payload: { id: SESSION, timestamp: "2026-09-05T10:00:00.000Z", cwd: "/home/sam/projects/shop", originator: "Codex Desktop", cli_version: "0.50.0", source: "vscode", thread_source: "user" } });
// the 0.3.1 peel kept only the comment of this turn; 0.4.0 keeps the comment and the request
const BROWSER = "# Browser comments:\n\n## User Comment 1\nTarget: button.checkout\nComment: make the pay button blue\n\n## My request for Codex:\nAnd put the coupon field under the order total";
// 0.3.1 threw this turn away whole; 0.4.0 peels the app's section off and keeps the request
const ENVELOPE = "# Files mentioned by the user:\n\n## report.ts: /home/sam/projects/shop/src/report.ts\n\n## My request for Codex:\nUse the totals helper from report.ts instead of summing the rows inline";
const PLAIN = "Keep the order totals right aligned on small screens too";
const LINES = [meta, codexUser(BROWSER, T[0]), codexAgent("Done."), codexUser(ENVELOPE, T[1]), codexUser(PLAIN, T[2])];

/** A HOME with the rollout, and the index 0.3.1 left: statements for lines 2 (the old text) and 5, a scan state with no peel version. */
function upgraded() {
  const root = tmpDir("recall-backfill");
  const day = path.join(root, ".codex", "sessions", "2026", "09", "05");
  fs.mkdirSync(day, { recursive: true });
  const file = writeTranscript(NAME, LINES, day);
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  const old = "make the pay button blue";
  const oldStatement = { id: `codex-${sha1(`codex\u0000${T[0]}\u0000${norm(old)}`, 16)}`, text: old, ts: T[0], session_id: SESSION, repo: "shop", host: "codex", hash: textHash(old), src: `${file}:L2` };
  const plain = buildStatement({ raw: PLAIN, ts: T[2], host: "codex", session_id: SESSION, repo: "shop", src: `${file}:L5` }, config).statement;
  store.appendStatements([oldStatement, plain]);
  const stat = fs.statSync(file);
  store.saveState({ files: { [file]: { size: stat.size, mtimeMs: stat.mtimeMs, offset: stat.size, lines: LINES.length, meta: { id: SESSION }, seenEvents: true } }, lastIndexAt: null });
  const run = (o = {}) => runIndex({ config, store, homeDir: root, env: {}, embed: false, now: () => Date.parse("2026-10-01T00:00:00.000Z"), ...o });
  return { root, file, config, store, run, oldStatement, plain };
}

test("peel version: a state without one (or an older one) needs the backfill; a new state is stamped", () => {
  assert.equal(needsPeelBackfill(undefined), false, "no state: a first read, not a backfill");
  assert.equal(needsPeelBackfill({ size: 1 }), true);
  assert.equal(needsPeelBackfill({ size: 1, peel: PEEL_VERSION - 1 }), true);
  assert.equal(needsPeelBackfill(stampPeel({ size: 1 })), false);
});

test("backfill: an unchanged file indexed by 0.3.1 is read once more; the line it threw away is admitted, the lines it kept keep their statements", async () => {
  const w = upgraded();
  const report = await w.run();
  assert.equal(report.backfilled, 1);
  assert.equal(report.scanned, 1);
  assert.equal(report.backfillLinesKept, 2, "lines 2 and 5 hold statements");
  assert.equal(report.added, 1);
  const rows = w.store.loadStatements();
  assert.deepEqual(rows.map((s) => [s.text, s.src.split(":L")[1]]), [
    ["make the pay button blue And put the coupon field under the order total", "2"],
    [PLAIN, "5"],
    ["Use the totals helper from report.ts instead of summing the rows inline", "4"],
  ], "line 2 keeps its id and gets the text the current rules make of it: no second statement for the same turn");
  assert.equal(rows[0].id, w.oldStatement.id);
  assert.equal(w.store.loadState().files[w.file].peel, PEEL_VERSION);
  const again = await w.run();
  assert.equal(again.scanned, 0, "stamped: an unchanged file is not read again");
  assert.equal(again.skippedUnchanged, 1);
});

test("backfill of a file that also grew: the old lines as above, the new ones like any new turn", async () => {
  const w = upgraded();
  fs.appendFileSync(w.file, `${codexUser(BROWSER.replace("blue", "green"), T[3])}\n`);
  const report = await w.run();
  assert.equal(report.backfilled, 1);
  assert.deepEqual(w.store.loadStatements().slice(2).map((s) => s.text), [
    "Use the totals helper from report.ts instead of summing the rows inline",
    "make the pay button green And put the coupon field under the order total",
  ]);
});

test("a fresh index of the same file reads every line with the current peels (what the backfill leaves alone is the earlier version's)", async () => {
  const w = upgraded();
  const dry = await w.run({ dryRun: true });
  assert.equal(dry.statements, 3);
  assert.equal(dry.vsIndex.removed, 1, "the old text of line 2 is not what the current rules make of it");
  assert.equal(dry.idStability.removedSourcePresent, 1);
});
