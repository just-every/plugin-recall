// One turn, one statement, whatever the file a copy of a rollout turn sits in (turn-identity.mjs): a Codex rollout turn is keyed by (host,
// session, time), so a resumed session written to a second rollout name (world B) and a .jsonl.zst copy in an index-only home added after an
// upgrade (world C) add no second id for a turn an earlier version read with another text. Within one pass, two copies of a turn read to two
// texts give one statement; a rollout archived in the same pass that backfills it is judged at its new path. Synthetic rollouts, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { PEEL_VERSION, stampPeel } from "../scripts/lib/transcripts/peel-backfill.mjs";
import { norm, sha1, textHash } from "../scripts/lib/text.mjs";
import { codexAgent, codexUser, writeTranscript } from "./transcript-builders.mjs";
import { tmpDir } from "./helpers.mjs";

const SESSION = "0190f000-c0c0-7000-8000-00000000c0b7";
const name = (stamp = "2026-09-05T10-00-00") => `rollout-${stamp}-${SESSION}.jsonl`;
const T = { browser: "2026-09-05T10:00:05.000Z", plain: "2026-09-05T10:01:00.000Z", gift: "2026-09-05T10:03:00.000Z" };
const meta = JSON.stringify({ timestamp: "2026-09-05T10:00:00.000Z", type: "session_meta", payload: { id: SESSION, timestamp: "2026-09-05T10:00:00.000Z", cwd: "/home/sam/projects/shop", originator: "Codex Desktop", cli_version: "0.50.0", source: "vscode", thread_source: "user" } });
const BROWSER = "# Browser comments:\n\n## User Comment 1\nTarget: button.checkout\nComment: make this button green\n\n## My request for Codex:\nAnd move the coupon field under the total";
const OLD_TEXT = "make this button green"; // what 0.3.x made of the browser turn
const NEW_TEXT = "make this button green And move the coupon field under the total";
const PLAIN = "Keep the totals right aligned on mobile too";
const LINES = [meta, codexUser(BROWSER, T.browser), codexAgent("Done."), codexUser(PLAIN, T.plain)];
const NOW = () => Date.parse("2026-10-01T00:00:00.000Z");
const statement = (text, ts, src) => ({ id: `codex-${sha1(`codex\u0000${ts}\u0000${norm(text)}`, 16)}`, text, ts, session_id: SESSION, repo: "shop", host: "codex", hash: textHash(text), src });
const stateOf = (file, lines, over = {}) => { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs, offset: st.size, lines, meta: { id: SESSION, cwd: "/home/sam/projects/shop", source: "vscode", thread_source: "user", originator: "Codex Desktop", timestamp: "2026-09-05T10:00:00.000Z" }, seenEvents: true, ...over }; };

function home() {
  const root = tmpDir("recall-turn-copies");
  const day = path.join(root, ".codex", "sessions", "2026", "09", "05");
  fs.mkdirSync(day, { recursive: true });
  const dataDir = path.join(root, "data");
  const store = createStore(dataDir);
  const run = (env = {}) => runIndex({ config: loadConfig({ RECALL_DATA: dataDir, ...env }), store, homeDir: root, env: {}, embed: false, now: NOW });
  const browserIds = () => new Set(store.loadStatements().filter((s) => s.ts === T.browser).map((s) => s.id));
  return { root, day, store, run, browserIds };
}

test("world B: a resumed session written to a second rollout name, both read by 0.3.x; the upgrade keeps one id for the turn", async () => {
  const w = home();
  const first = writeTranscript(name(), LINES, w.day);
  const second = writeTranscript(name("2026-09-05T10-02-00"), [...LINES, codexUser("Now add the gift card field next to the coupon", T.gift)], w.day);
  // what 0.3.x left: the browser turn under its old text (the second file's copy was a duplicate of it), no peel version in the states
  const old = statement(OLD_TEXT, T.browser, `${first}:L2`);
  w.store.appendStatements([old, statement(PLAIN, T.plain, `${first}:L4`), statement("Now add the gift card field next to the coupon", T.gift, `${second}:L5`)]);
  w.store.saveState({ files: { [first]: stateOf(first, 4), [second]: stateOf(second, 5) }, lastIndexAt: null });
  const report = await w.run();
  assert.equal(report.backfilled, 2);
  assert.equal(report.sameTurnOtherId, 1, "the second name's copy of the turn is the same turn");
  assert.deepEqual([...w.browserIds()], [old.id]);
  assert.equal(w.store.loadStatements().find((s) => s.id === old.id).text, NEW_TEXT, "the statement gets the current text under its id");
  const again = await w.run();
  assert.equal(again.added, 0);
  assert.deepEqual([...w.browserIds()], [old.id]);
});

test("world C: a .jsonl.zst copy in an index-only home added after the upgrade adds no second id", async () => {
  const w = home();
  const live = writeTranscript(name(), LINES, w.day);
  const old = statement(OLD_TEXT, T.browser, `${live}:L2`);
  w.store.appendStatements([old, statement(PLAIN, T.plain, `${live}:L4`)]);
  // an index already upgraded: the state is stamped, so the live rollout is not read again
  w.store.saveState({ files: { [live]: stampPeel(stateOf(live, 4)) }, lastIndexAt: null });
  const backup = path.join(w.root, ".codex_old", "archived_sessions");
  fs.mkdirSync(backup, { recursive: true });
  writeTranscript(`${name()}.zst`, LINES, backup);
  const report = await w.run({ RECALL_HOMES: JSON.stringify([{ path: path.join(w.root, ".codex_old"), kind: "codex" }]) });
  assert.equal(report.scanned, 1, "only the copy is read");
  assert.equal(report.sameTurnOtherId, 1);
  assert.equal(report.added, 0);
  assert.deepEqual([...w.browserIds()], [old.id]);
});

test("one pass, two copies of a turn read to two texts (one under the browser envelope, one bare): one statement", async () => {
  const w = home();
  writeTranscript(name(), LINES, w.day);
  writeTranscript(name("2026-09-05T10-02-00"), [meta, codexUser(OLD_TEXT, T.browser)], w.day);
  const report = await w.run();
  assert.equal(report.sameTurnOtherId, 1);
  assert.equal(w.browserIds().size, 1);
});

test("a rollout archived since the last pass and backfilled in the same pass is judged at its new path", async () => {
  const w = home();
  const live = writeTranscript(name(), LINES, w.day);
  const old = statement(OLD_TEXT, T.browser, `${live}:L2`);
  w.store.appendStatements([old, statement(PLAIN, T.plain, `${live}:L4`)]);
  w.store.saveState({ files: { [live]: stateOf(live, 4, { peel: PEEL_VERSION - 1 }) }, lastIndexAt: null });
  const archived = path.join(w.root, ".codex", "archived_sessions");
  fs.mkdirSync(archived, { recursive: true });
  fs.renameSync(live, path.join(archived, name()));
  const report = await w.run();
  assert.equal(report.sourcesMoved, 2);
  assert.equal(report.backfilled, 1);
  assert.equal(report.backfillLinesKept, 2);
  assert.deepEqual(w.store.loadStatements().map((s) => [s.id, s.text, s.src.replace(w.root, "~")]), [
    [old.id, NEW_TEXT, `~/.codex/archived_sessions/${name()}:L2`],
    [statement(PLAIN, T.plain, "").id, PLAIN, `~/.codex/archived_sessions/${name()}:L4`],
  ]);
});

test("world B as 0.4.0 left it (two ids for the turn: the old text on the first name, the new text on the second): the upgrade keeps one", async () => {
  const w = home();
  const first = writeTranscript(name(), LINES, w.day);
  const second = writeTranscript(name("2026-09-05T10-02-00"), LINES, w.day);
  const old = statement(OLD_TEXT, T.browser, `${first}:L2`);
  const fresh = statement(NEW_TEXT, T.browser, `${second}:L2`);
  w.store.appendStatements([old, statement(PLAIN, T.plain, `${first}:L4`), fresh]);
  w.store.saveState({ files: { [first]: { ...stateOf(first, 4), peel: 1 }, [second]: { ...stateOf(second, 4), peel: 1 } }, lastIndexAt: null });
  const report = await w.run();
  assert.equal(report.rejudged.retired, 1);
  assert.deepEqual([...w.browserIds()], [fresh.id], "the statement that already holds the current text stays; the old one is retired");
  assert.deepEqual(w.store.loadStatements().map((s) => s.text), [PLAIN, NEW_TEXT]);
});

test("two messages queued while the agent worked are written under one time: both are statements, and a copy of the file adds neither again", async () => {
  const w = home();
  const at = "2026-09-05T10:05:00.123Z";
  const queued = [meta, codexUser("This is the tenth time the upload has failed, find out why", at), codexUser("And stop leaving the retries for me to do", at)];
  const live = writeTranscript(name(), queued, w.day);
  await w.run();
  assert.deepEqual(w.store.loadStatements().map((s) => [s.text, s.ts_seq]), [["This is the tenth time the upload has failed, find out why", 0], ["And stop leaving the retries for me to do", 1]]);
  const backup = path.join(w.root, ".codex_old", "archived_sessions");
  fs.mkdirSync(backup, { recursive: true });
  writeTranscript(`${name("2026-09-05T11-00-00")}.zst`, queued, backup);
  const report = await w.run({ RECALL_HOMES: JSON.stringify([{ path: path.join(w.root, ".codex_old"), kind: "codex" }]) });
  assert.equal(report.duplicates, 2);
  assert.equal(w.store.loadStatements().length, 2);
  assert.ok(fs.existsSync(live));
});

test("an index of 0.4.0 (no ts_seq) upgraded: its rollout statements get their ts_seq, so a later copy of a shared-time pair adds no second id", async () => {
  const w = home();
  const at = "2026-09-05T10:05:00.123Z";
  const BR2 = BROWSER.replace("make this button green", "make the help link blue");
  const pair = [meta, codexUser(BROWSER, at), codexUser(BR2, at)];
  const live = writeTranscript(name(), pair, w.day);
  const a = statement(OLD_TEXT, at, `${live}:L2`);
  const b = statement("make the help link blue", at, `${live}:L3`);
  w.store.appendStatements([a, b]);
  w.store.saveState({ files: { [live]: { ...stateOf(live, 3), peel: 1 } }, lastIndexAt: null });
  await w.run();
  assert.deepEqual(w.store.loadStatements().map((s) => [s.id, s.ts_seq]), [[a.id, 0], [b.id, 1]]);
  const backup = path.join(w.root, ".codex_old", "archived_sessions");
  fs.mkdirSync(backup, { recursive: true });
  writeTranscript(`${name("2026-09-05T11-00-00")}.zst`, pair, backup);
  const report = await w.run({ RECALL_HOMES: JSON.stringify([{ path: path.join(w.root, ".codex_old"), kind: "codex" }]) });
  assert.equal(report.sameTurnOtherId, 2);
  assert.deepEqual(w.store.loadStatements().map((s) => s.id), [a.id, b.id]);
});

test("a rollout read on from where the last pass stopped goes on numbering the turns of the time it stopped at", async () => {
  const w = home();
  const at = "2026-09-05T10:05:00.123Z";
  const file = writeTranscript(name(), [meta, codexUser("This is the tenth time the upload has failed, find out why", at)], w.day);
  await w.run();
  fs.appendFileSync(file, `${codexUser("And stop leaving the retries for me to do", at)}\n`);
  const report = await w.run();
  assert.equal(report.added, 1);
  assert.deepEqual(w.store.loadStatements().map((s) => s.ts_seq), [0, 1]);
});
