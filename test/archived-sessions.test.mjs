// Codex and Every Code archive a thread by moving its rollout from sessions/YYYY/MM/DD/ to archived_sessions/. Both directories are read, and
// a rollout that moves, or sits in both, never duplicates a statement, changes an id, orphans a card or is scanned again as new: ids do not
// depend on the path, the scan state and the statements' src follow the file (transcripts/rollout-moves.mjs). Synthetic rollouts, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appendCards, cardsPath, loadCards } from "../scripts/lib/cards/cards-file.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { showStatement } from "../scripts/lib/show.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { listTranscripts } from "../scripts/lib/transcripts/files.mjs";
import { pickRolloutCopies } from "../scripts/lib/transcripts/rollout-moves.mjs";
import { createTally } from "../scripts/lib/transcripts/tally.mjs";
import { codexAgent, codexUser, writeTranscript } from "./transcript-builders.mjs";
import { tmpDir } from "./helpers.mjs";

const SESSION = "0190f000-9999-7000-8000-00000000b001";
const NAME = `rollout-2026-09-21T08-00-00-${SESSION}.jsonl`;
const meta = (id = SESSION) => JSON.stringify({ timestamp: "2026-09-21T08:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2026-09-21T08:00:00.000Z", cwd: "/home/sam/projects/ledger-cli", originator: "codex_cli_rs", cli_version: "0.160.1", source: "cli", thread_source: "user" } });
const LINES = [meta(), codexUser("Group the ledger report by month and then by account", "2026-09-21T08:01:00.100Z"), codexAgent("Done: the report is grouped by month, then account."), codexUser("Keep the totals row at the bottom of every month group", "2026-09-21T08:03:00.100Z")];

function world(kind = ".codex") {
  const root = tmpDir("recall-archive");
  const home = path.join(root, kind);
  const live = path.join(home, "sessions", "2026", "09", "21");
  const archive = path.join(home, "archived_sessions");
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(archive, { recursive: true });
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  const run = (o = {}) => runIndex({ config, store, homeDir: root, env: {}, embed: false, ...o });
  return { root, home, live, archive, config, store, run };
}

test("listTranscripts: a Codex or Every Code home lists sessions/ and archived_sessions/", () => {
  for (const kind of [".codex", ".code"]) {
    const w = world(kind);
    writeTranscript(NAME, LINES, w.live);
    writeTranscript(`rollout-2026-09-01T08-00-00-0190f000-9999-7000-8000-00000000b002.jsonl`, [meta("0190f000-9999-7000-8000-00000000b002")], w.archive);
    const files = listTranscripts(w.home, kind.slice(1)).map((f) => path.relative(w.home, f.file)).sort();
    assert.deepEqual(files, ["archived_sessions/rollout-2026-09-01T08-00-00-0190f000-9999-7000-8000-00000000b002.jsonl", `sessions/2026/09/21/${NAME}`]);
  }
});

test("archived rollouts are indexed like live ones, and the dry run counts them as their own source", async () => {
  const w = world();
  writeTranscript(NAME, LINES, w.archive);
  const dry = await w.run({ dryRun: true });
  assert.deepEqual(dry.bySource, { [`${w.home}|archived`]: { statements: 2, added: 2 } });
  const report = await w.run();
  assert.equal(report.added, 2);
  assert.ok(w.store.loadStatements().every((s) => s.src.startsWith(path.join(w.archive, NAME))));
});

test("a rollout archived after it was indexed: same ids, no duplicate, no rescan, the card stays attached, src and show follow the file", async () => {
  const w = world();
  const live = writeTranscript(NAME, LINES, w.live);
  await w.run();
  const before = w.store.loadStatements();
  assert.equal(before.length, 2);
  appendCards(cardsPath(w.config.dataDir), [{ id: before[0].id, kind: "preference", scope: "repo", scope_repo: null, gist: "grouping the ledger report", model: "haiku", at: "2026-09-21T09:00:00.000Z", gist_source: "transcript" }]);

  const moved = path.join(w.archive, NAME);
  fs.renameSync(live, moved); // what archiving a thread does: same name, same bytes, same mtime
  const after = await w.run();
  assert.equal(after.added, 0);
  assert.equal(after.duplicates, 0, "the moved file was not read again");
  assert.equal(after.scanned, 0);
  assert.equal(after.skippedUnchanged, 1);
  assert.equal(after.rescanned, 0);
  assert.equal(after.sourcesMoved, 2);
  const rows = w.store.loadStatements();
  assert.deepEqual(rows.map((s) => s.id), before.map((s) => s.id), "ids never depend on the path");
  assert.deepEqual(rows.map((s) => s.src), before.map((s) => s.src.replace(live, moved)));
  const state = w.store.loadState().files;
  assert.ok(state[moved] && !state[live], "the scan state moved with the file");
  assert.equal(loadCards(cardsPath(w.config.dataDir)).get(rows[0].id).gist, "grouping the ledger report", "cards are keyed by statement id");
  const shown = await showStatement({ id: rows[1].id, config: w.config, env: {}, cwd: w.root, homedir: w.root });
  assert.match(shown.text, /source: ~\/\.codex\/archived_sessions\//);

  // the archived thread is resumed and grows: only the new turn is read
  fs.appendFileSync(moved, `${codexUser("Add a CSV export of the grouped report", "2026-09-22T10:00:00.100Z")}\n`);
  const grown = await w.run();
  assert.deepEqual([grown.added, grown.duplicates, grown.rescanned], [1, 0, 0]);
});

test("a rollout in both sessions/ and archived_sessions/ is read once; the copy the scan state knows wins after that", async () => {
  const w = world();
  writeTranscript(NAME, LINES, w.live);
  writeTranscript(NAME, LINES, w.archive);
  const first = await w.run();
  assert.equal(first.added, 2);
  assert.equal(first.duplicates, 0, "one copy is scanned, not both");
  assert.equal(first.excluded["rollout-copy"], 1);
  assert.equal(w.store.loadStatements().length, 2);
  const second = await w.run();
  assert.deepEqual([second.added, second.scanned, second.excluded["rollout-copy"]], [0, 0, 1]);
  // pickRolloutCopies on its own: no state, the larger copy, then the live one
  const files = listTranscripts(w.home, "codex");
  fs.appendFileSync(path.join(w.archive, NAME), `${codexUser("One more turn only the archived copy has", "2026-09-22T11:00:00.100Z")}\n`);
  const grownFiles = listTranscripts(w.home, "codex");
  assert.equal(pickRolloutCopies(files, { files: {} }, createTally())[0].file, path.join(w.live, NAME), "same size: the live copy");
  assert.equal(pickRolloutCopies(grownFiles, { files: {} }, createTally())[0].file, path.join(w.archive, NAME), "the larger copy");
});

test("a rollout of one home never takes the scan state of another home's rollout of the same name", async () => {
  const w = world();
  const other = path.join(w.root, ".codex_other");
  fs.mkdirSync(path.join(other, "sessions", "2026", "09", "21"), { recursive: true });
  const config = loadConfig({ RECALL_DATA: path.join(w.root, "data"), RECALL_HOMES: other });
  const store = createStore(config.dataDir);
  const otherFile = writeTranscript(NAME, LINES, path.join(other, "sessions", "2026", "09", "21"));
  await runIndex({ config, store, homeDir: w.root, env: {}, embed: false });
  fs.rmSync(otherFile);
  writeTranscript(NAME, LINES, w.archive);
  const report = await runIndex({ config, store, homeDir: w.root, env: {}, embed: false });
  assert.equal(report.sourcesMoved, 0);
  assert.equal(report.scanned, 1, "the new home's copy is read as its own file");
  assert.equal(report.duplicates, 2, "and its statements are the ones already indexed");
});
