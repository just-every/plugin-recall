// One turn, one statement (turn-identity.mjs): a turn read again under newer owner-text rules can come out with other text and so another id.
// A candidate whose turn (host, session, time, and the same line of the same-named file) already has a statement under another id is not
// admitted: a same-named copy of a rollout in a backup home, a .zst rollout that changed and a file that shrank are all read from the start
// and must not add the second id. Different messages that share a time (a legacy rollout's turns all carry the session's start, a log's
// rows whole seconds) are different lines and are all kept. Synthetic rollouts, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { buildStatement, runIndex } from "../scripts/lib/indexer.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { stampPeel } from "../scripts/lib/transcripts/peel-backfill.mjs";
import { norm, sha1, textHash } from "../scripts/lib/text.mjs";
import { createTurnIndex, numberTimes, turnKeys } from "../scripts/lib/turn-identity.mjs";
import { codexAgent, codexUser, writeTranscript } from "./transcript-builders.mjs";
import { tmpDir } from "./helpers.mjs";

const SESSION = "0190f000-1d1d-7000-8000-00000000d001";
const T = ["2026-09-05T10:00:05.000Z", "2026-09-05T10:04:00.000Z", "2026-09-07T08:00:00.000Z"];
const meta = JSON.stringify({ timestamp: "2026-09-05T10:00:00.000Z", type: "session_meta", payload: { id: SESSION, timestamp: "2026-09-05T10:00:00.000Z", cwd: "/home/sam/projects/shop", originator: "Codex Desktop", cli_version: "0.50.0", source: "vscode", thread_source: "user" } });
const BROWSER = "# Browser comments:\n\n## User Comment 1\nTarget: a.help-link\nComment: make the help link open in a new tab\n\n## My request for Codex:\nAnd underline it on hover";
const NEW_TEXT = "make the help link open in a new tab And underline it on hover";
const OLD_TEXT = "make the help link open in a new tab";
const PLAIN = "Move the help link next to the search field in the header";
const LINES = [meta, codexUser(BROWSER, T[0]), codexAgent("Done."), codexUser(PLAIN, T[1])];
const NOW = () => Date.parse("2026-10-01T00:00:00.000Z");

/**
 * A HOME whose index holds what an earlier version made of the rollout (line 2 with its old text) and a stamped, current scan state:
 * nothing reads the file again unless it changes.
 */
function indexed({ name = `rollout-2026-09-05T10-00-00-${SESSION}.jsonl` } = {}) {
  const root = tmpDir("recall-turn-identity");
  const day = path.join(root, ".codex", "sessions", "2026", "09", "05");
  fs.mkdirSync(day, { recursive: true });
  const file = writeTranscript(name, LINES, day);
  const dataDir = path.join(root, "data");
  const store = createStore(dataDir);
  const statement = (text, ts, line) => ({ id: `codex-${sha1(`codex\u0000${ts}\u0000${norm(text)}`, 16)}`, text, ts, session_id: SESSION, repo: "shop", host: "codex", hash: textHash(text), src: `${file}:L${line}` });
  store.appendStatements([statement(OLD_TEXT, T[0], 2), statement(PLAIN, T[1], 4)]);
  const stat = fs.statSync(file);
  store.saveState({ files: { [file]: stampPeel({ size: stat.size, mtimeMs: stat.mtimeMs, offset: stat.size, lines: LINES.length, meta: { id: SESSION, cwd: "/home/sam/projects/shop", source: "vscode", thread_source: "user", originator: "Codex Desktop", timestamp: "2026-09-05T10:00:00.000Z" }, seenEvents: true }) }, lastIndexAt: null });
  const run = (env = {}) => {
    const config = loadConfig({ RECALL_DATA: dataDir, ...env });
    return runIndex({ config, store, homeDir: root, env: {}, embed: false, now: NOW });
  };
  return { root, day, file, name, store, run };
}
const texts = (store) => store.loadStatements().map((s) => s.text);

test("turnKeys: a rollout turn is (host, session, time, seq) whatever its file is called; without a seq, (host, session, time) and the line", () => {
  const R = "rollout-2026-01-01T00-00-00-0190f000-1d1d-7000-8000-00000000d00a.jsonl";
  const a = { id: "codex-a", host: "codex", session_id: "s", ts: "2026-01-01T00:00:00.000Z", ts_seq: 0, src: `/h1/.codex/sessions/${R}:L7` };
  const turn = "codex\u0000s\u00002026-01-01T00:00:00.000Z";
  assert.deepEqual(turnKeys(a), { exact: `${turn}\u0000#0`, loose: null, line: `${turn}\u00000190f000-1d1d-7000-8000-00000000d00a:L7` }, "the rollout is named by its session");
  assert.deepEqual(turnKeys({ ...a, ts_seq: undefined }), { exact: null, loose: turn, line: `${turn}\u00000190f000-1d1d-7000-8000-00000000d00a:L7` });
  assert.deepEqual(turnKeys({ ...a, src: "/h/.codex/history.jsonl:L3" }), { exact: null, loose: null, line: `${turn}\u0000history.jsonl:L3` });
  assert.equal(turnKeys({ ...a, src: "test" }), null);
  const turns = createTurnIndex([a]);
  assert.equal(turns.other({ ...a, id: "codex-b", src: `/backup/.codex/archived_sessions/${R}.zst:L7` }), "codex-a");
  assert.equal(turns.other({ ...a, id: "codex-b", src: `/h1/.codex/sessions/${R.replace("T00-00-00", "T09-00-00")}:L12` }), "codex-a", "a resumed session's second rollout name");
  assert.equal(turns.other({ ...a, id: "codex-a" }), null, "the same id is a duplicate, not another id");
  assert.equal(turns.other({ ...a, id: "codex-c", ts_seq: 1, src: a.src.replace(":L7", ":L9") }), null, "a second message written under the same time");
  const legacy = { ...a, ts_seq: undefined }; // a legacy rollout's turn: no seq, every turn at the session's start
  assert.equal(createTurnIndex([legacy]).other({ ...legacy, id: "codex-c", src: a.src.replace(":L7", ":L9") }), null, "a legacy turn on another line: another message");
  assert.equal(createTurnIndex([legacy]).other({ ...legacy, id: "codex-c" }), "codex-a", "a legacy turn on the same line of the same session's rollout: the same turn");
  assert.equal(turns.other({ ...a, id: "codex-d", ts: "2026-01-01T00:00:00.001Z" }), null, "another time: another turn");
  // a statement indexed before ts_seq: a candidate alone at its time is its turn when it is the only such statement
  const old = createTurnIndex([{ ...a, ts_seq: undefined }]);
  assert.equal(old.other({ ...a, id: "codex-e", src: `/backup/${R}.zst:L3` }, { alone: true }), "codex-a");
  assert.equal(old.other({ ...a, id: "codex-e", src: `/backup/${R}.zst:L3` }), null, "not alone at its time: not decided by the time");
  const two = createTurnIndex([{ ...a, ts_seq: undefined }, { ...a, id: "codex-f", ts_seq: undefined, src: a.src.replace(":L7", ":L9") }]);
  assert.equal(two.other({ ...a, id: "codex-e", src: `/backup/${R}.zst:L3` }, { alone: true }), null, "two statements share the time: ambiguous");
});

test("numberTimes: the turns of a file that share a time get 0, 1, ...; a file read on from an offset goes on counting", () => {
  const rows = [{ ts: "t1" }, { ts: "t2" }, { ts: "t2" }, { ts: "t3" }];
  const tail = numberTimes(rows);
  assert.deepEqual(rows.map((r) => [r.tsSeq, r.tsAlone]), [[0, true], [0, false], [1, false], [0, true]]);
  assert.deepEqual(tail, { ts: "t3", n: 1 });
  const more = [{ ts: "t3" }, { ts: "t4" }];
  assert.deepEqual(numberTimes(more, tail), { ts: "t4", n: 1 });
  assert.deepEqual(more.map((r) => [r.tsSeq, r.tsAlone]), [[1, false], [0, true]]);
});

test("a same-named copy of the rollout in an index-only backup home adds no second id for the turn the index already holds", async () => {
  const w = indexed();
  const backup = path.join(w.root, ".codex_backup", "sessions", "2026", "09", "05");
  fs.mkdirSync(backup, { recursive: true });
  writeTranscript(w.name, LINES, backup);
  const config = loadConfig({ RECALL_DATA: path.join(w.root, "data") });
  assert.equal(buildStatement({ raw: BROWSER, ts: T[0], host: "codex", session_id: SESSION, repo: "shop", src: "x:L2" }, config).statement.text, NEW_TEXT, "what the current rules make of line 2");
  const report = await w.run({ RECALL_HOMES: JSON.stringify([{ path: path.join(w.root, ".codex_backup"), kind: "codex" }]) });
  assert.equal(report.scanned, 1, "only the copy is read");
  assert.equal(report.sameTurnOtherId, 1);
  assert.equal(report.duplicates, 1, "the plain turn has the same id in both copies");
  assert.equal(report.added, 0);
  assert.deepEqual(texts(w.store), [OLD_TEXT, PLAIN]);
});

test("a .zst rollout that changes is read from the start: the turn keeps its statement, the new turn is added", async () => {
  const w = indexed({ name: `rollout-2026-09-05T10-00-00-${SESSION}.jsonl.zst` });
  writeTranscript(w.name, [...LINES, codexUser("Ship the header change behind the beta flag", T[2])], w.day);
  const report = await w.run();
  assert.equal(report.rescanned, 1);
  assert.equal(report.sameTurnOtherId, 1);
  assert.deepEqual(texts(w.store), [OLD_TEXT, PLAIN, "Ship the header change behind the beta flag"]);
});

test("a rollout that shrank is read from the start without a second id for its turns", async () => {
  const w = indexed();
  fs.writeFileSync(w.file, `${LINES.slice(0, 2).join("\n")}\n`);
  const report = await w.run();
  assert.equal(report.rescanned, 1);
  assert.equal(report.sameTurnOtherId, 1);
  assert.deepEqual(texts(w.store), [OLD_TEXT, PLAIN]);
});

test("different messages at one time are all kept: a legacy rollout's turns, and a log's rows of one second", async () => {
  const root = tmpDir("recall-turn-identity-time");
  const legacy = "0190f000-1d1d-7000-8000-00000000d002";
  const home = path.join(root, ".codex");
  const day = path.join(home, "sessions", "2025", "06", "10");
  fs.mkdirSync(day, { recursive: true });
  const item = (text) => JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  const asks = ["Why does the import skip rows with an empty date column?", "Treat an empty date as the first day of the month instead", "And log every row that was changed that way"];
  writeTranscript(`rollout-2025-06-10T09-00-00-${legacy}.jsonl`, [JSON.stringify({ id: legacy, timestamp: "2025-06-10T09:00:00.000Z", instructions: null }), JSON.stringify({ record_type: "state" }), ...asks.map(item)], day);
  const second = 1749546000;
  fs.writeFileSync(path.join(home, "history.jsonl"), [
    { session_id: legacy, ts: second, text: asks[0] },
    { session_id: "0190f000-1d1d-7000-8000-00000000d003", ts: second + 600, text: "Two rows of one session written in the same second, the first one" },
    { session_id: "0190f000-1d1d-7000-8000-00000000d003", ts: second + 600, text: "and the second one, which is another message all the same" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  const report = await runIndex({ config, store, homeDir: root, env: {}, embed: false, now: NOW });
  assert.equal(report.sameTurnOtherId, 0);
  const rows = store.loadStatements();
  assert.equal(rows.filter((s) => s.session_id === legacy).length, 3, "every legacy turn is dated with the session's start");
  assert.ok(new Set(rows.filter((s) => s.session_id === legacy).map((s) => s.ts)).size === 1);
  assert.equal(rows.filter((s) => s.session_id === "0190f000-1d1d-7000-8000-00000000d003").length, 2);
});
