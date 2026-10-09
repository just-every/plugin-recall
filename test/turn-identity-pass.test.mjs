// One turn, one statement within a single pass, whatever order the pass reads the copies of a turn in (turn-identity.mjs, rejudge.mjs):
//   - an upgrade that stamps `ts_seq` on the statements of a rollout puts them in the pass's turn index, so a copy whose turns sit at other
//     lines (a resumed session written to a second rollout name) and share their time (queued messages) adds no second id when it comes later;
//     when it comes first, the statement it added gives way to the held one, so the turn keeps its older id either way;
//   - a statement of 0.4.0 (no `ts_seq`) whose rollout is gone is still the turn of a copy that is alone at its time (the loose match);
//   - a rollout that stops before a waiting turn goes on numbering, on the next pass, from the turns it admitted.
// Synthetic rollouts, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { norm, sha1, textHash } from "../scripts/lib/text.mjs";
import { codexAgent, codexUser, writeTranscript } from "./transcript-builders.mjs";
import { tmpDir } from "./helpers.mjs";

const SESSION = "0190f000-c0c0-7000-8000-00000000c1a1";
const name = (stamp) => `rollout-${stamp}-${SESSION}.jsonl`;
const metaLine = (id) => JSON.stringify({ timestamp: "2026-09-05T10:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2026-09-05T10:00:00.000Z", cwd: "/home/sam/projects/shop", originator: "Codex Desktop", cli_version: "0.50.0", source: "vscode", thread_source: "user" } });
const metaState = (id) => ({ id, cwd: "/home/sam/projects/shop", source: "vscode", thread_source: "user", originator: "Codex Desktop", timestamp: "2026-09-05T10:00:00.000Z" });
const browser = (comment, request) => `# Browser comments:\n\n## User Comment 1\nTarget: button.checkout\nComment: ${comment}\n\n## My request for Codex:\n${request}`;
const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const idOf = (host, ts, text) => `${host}-${sha1(`${host}\u0000${ts}\u0000${norm(text)}`, 16)}`;
const statement = (text, ts, src, host = "codex", session_id = SESSION) => ({ id: idOf(host, ts, text), text, ts, session_id, repo: "shop", host, hash: textHash(text), src });
const stateOf = (file, lines, over = {}) => { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs, offset: st.size, lines, meta: metaState(SESSION), seenEvents: true, ...over }; };
const setMtime = (file, iso) => { const t = new Date(iso); fs.utimesSync(file, t, t); };

// two messages queued under one time, each under the browser envelope; 0.4.0 kept only the comment of each
const AT = "2026-09-05T10:05:00.123Z";
const PAIR = [
  { raw: browser("make this button green", "And move the coupon field under the total"), old: "make this button green", now: "make this button green And move the coupon field under the total" },
  { raw: browser("make the help link blue", "And put it next to the logo"), old: "make the help link blue", now: "make the help link blue And put it next to the logo" },
];

function pairWorld(copyFirst) {
  const root = tmpDir("recall-turn-pass");
  const day = path.join(root, ".codex", "sessions", "2026", "09", "05");
  fs.mkdirSync(day, { recursive: true });
  const original = writeTranscript(name("2026-09-05T10-00-00"), [metaLine(SESSION), ...PAIR.map((p) => codexUser(p.raw, AT))], day);
  // the resumed session's second rollout: the same turns, at other lines
  const resumed = writeTranscript(name("2026-09-05T11-00-00"), [metaLine(SESSION), codexAgent("Resumed the session."), ...PAIR.map((p) => codexUser(p.raw, AT))], day);
  setMtime(original, copyFirst ? "2026-09-05T12:00:00Z" : "2026-09-05T11:00:00Z");
  setMtime(resumed, copyFirst ? "2026-09-05T11:00:00Z" : "2026-09-05T12:00:00Z");
  const store = createStore(path.join(root, "data"));
  const held = PAIR.map((p, i) => statement(p.old, AT, `${original}:L${i + 2}`));
  store.appendStatements(held);
  store.saveState({ files: { [original]: stateOf(original, 3, { peel: 1 }) }, lastIndexAt: null });
  const run = () => runIndex({ config: loadConfig({ RECALL_DATA: path.join(root, "data") }), store, homeDir: root, env: {}, embed: false, concurrency: 1, now: () => NOW });
  return { store, held, run };
}

for (const copyFirst of [false, true]) {
  test(`an upgrade stamps a shared-time pair and a resumed copy at other lines is read in the same pass (${copyFirst ? "copy first" : "original first"}): one id per turn, the old one`, async () => {
    const w = pairWorld(copyFirst);
    const report = await w.run();
    assert.equal(report.backfilled, 1);
    assert.deepEqual(w.store.loadStatements().map((s) => [s.id, s.text, s.ts_seq]), w.held.map((s, i) => [s.id, PAIR[i].now, i]));
    const again = await w.run();
    assert.equal(again.added, 0);
    assert.equal(w.store.loadStatements().length, 2);
  });
}

test("a statement of 0.4.0 whose rollout is gone is the turn of a copy at another line that is alone at its time: no second id", async () => {
  const root = tmpDir("recall-turn-loose");
  const day = path.join(root, ".codex", "sessions", "2026", "09", "05");
  fs.mkdirSync(day, { recursive: true });
  const ts = "2026-09-05T10:01:00.456Z";
  const gone = path.join(day, name("2026-09-05T10-00-00"));
  const store = createStore(path.join(root, "data"));
  const old = statement(PAIR[0].old, ts, `${gone}:L2`);
  store.appendStatements([old]);
  writeTranscript(name("2026-09-05T11-00-00"), [metaLine(SESSION), codexAgent("Resumed the session."), codexUser(PAIR[0].raw, ts), codexUser("Then run the checkout tests again", "2026-09-05T10:02:00.000Z")], day);
  const report = await runIndex({ config: loadConfig({ RECALL_DATA: path.join(root, "data") }), store, homeDir: root, env: {}, embed: false, now: () => NOW });
  assert.equal(report.sameTurnOtherId, 1);
  assert.deepEqual(store.loadStatements().map((s) => s.text), [PAIR[0].old, "Then run the checkout tests again"]);
});

// ---- Every Code: a queued pair whose second message waits for its typed row ----
const CODE_SESSION = "0190e000-ee00-7000-8000-00000000ee31";
const codeMeta = JSON.stringify({ timestamp: "2026-09-30T23:58:00.000Z", type: "session_meta", payload: { id: CODE_SESSION, timestamp: "2026-09-30T23:58:00.000Z", cwd: "/home/sam/projects/shop", originator: "codex_cli_rs", cli_version: "0.4.0", source: "cli", thread_source: "user" } });
const codeUser = (text, ts) => JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

test("a rollout that stops before a waiting turn of a shared time numbers it, next pass, after the turns it admitted; a copy adds no second id", async () => {
  const root = tmpDir("recall-turn-wait-seq");
  const home = path.join(root, ".code");
  const day = path.join(home, "sessions", "2026", "09", "30");
  fs.mkdirSync(day, { recursive: true });
  const at = new Date(NOW - 60_000).toISOString(); // young: a turn the log does not vouch for yet waits
  const first = "Rename the export button to Download on every page";
  const second = "And keep the old label in the tooltip for a release";
  const lines = [codeMeta, codeUser(first, at), codeUser(second, at)];
  writeTranscript(`rollout-2026-09-30T23-58-00-${CODE_SESSION}.jsonl`, lines, day);
  const log = path.join(home, "history.jsonl");
  const sec = Math.floor(Date.parse(at) / 1000);
  fs.writeFileSync(log, `${JSON.stringify({ session_id: CODE_SESSION, ts: sec - 2, text: first })}\n`);
  const dataDir = path.join(root, "data");
  const store = createStore(dataDir);
  const run = (now, env = {}) => runIndex({ config: loadConfig({ RECALL_DATA: dataDir, ...env }), store, homeDir: root, env: {}, embed: false, now: () => now });
  await run(NOW);
  assert.deepEqual(store.loadStatements().map((s) => [s.text, s.ts_seq]), [[first, 0]], "the second message waits for its row");
  fs.appendFileSync(log, `${JSON.stringify({ session_id: CODE_SESSION, ts: sec - 1, text: second })}\n`);
  await run(NOW + 60_000);
  assert.deepEqual(store.loadStatements().map((s) => [s.text, s.ts_seq]), [[first, 0], [second, 1]]);
  const backup = path.join(root, ".code_old", "archived_sessions");
  fs.mkdirSync(backup, { recursive: true });
  writeTranscript(`rollout-2026-09-30T23-58-00-${CODE_SESSION}.jsonl.zst`, lines, backup);
  const report = await run(NOW + 120_000, { RECALL_HOMES: JSON.stringify([{ path: path.join(root, ".code_old"), kind: "code" }]) });
  assert.equal(report.added, 0);
  assert.equal(report.duplicates, 2);
  assert.deepEqual(store.loadStatements().map((s) => s.ts_seq), [0, 1]);
});

// ---- legacy rollouts: every turn carries the session's start, so they are told apart by their line, never numbered ----
test("a legacy rollout's turns carry no ts_seq: a second rollout of the session that lacks the first turn adds its own turn, not a merge", async () => {
  const root = tmpDir("recall-turn-legacy");
  const home = path.join(root, ".codex");
  const day = path.join(home, "sessions", "2025", "09", "03");
  fs.mkdirSync(day, { recursive: true });
  const L = "0190e000-3333-7000-8000-00000000f0a1";
  const header = JSON.stringify({ id: L, timestamp: "2025-09-03T10:15:00.123Z", instructions: "Synthetic project instructions.", cwd: "/home/sam/projects/ledger-cli", model: "gpt-5" });
  const item = (text) => JSON.stringify({ type: "message", id: null, role: "user", content: [{ type: "input_text", text }] });
  const [u1, u2, u3] = ["Why does the balance command print negative zero for empty accounts?", "Then make the report command round to cents", "And add a test for the empty ledger case"];
  writeTranscript(`rollout-2025-09-03T10-15-00-${L}.jsonl`, [header, item(u1), item(u2)], day);
  writeTranscript(`rollout-2025-09-03T11-15-00-${L}.jsonl`, [header, JSON.stringify({ record_type: "state" }), item(u2), item(u3)], day);
  fs.writeFileSync(path.join(home, "history.jsonl"), `${JSON.stringify({ session_id: L, ts: 1756894600, text: u1 })}\n`);
  const store = createStore(path.join(root, "data"));
  const report = await runIndex({ config: loadConfig({ RECALL_DATA: path.join(root, "data") }), store, homeDir: root, env: {}, embed: false, concurrency: 1, now: () => NOW });
  assert.equal(report.sameTurnOtherId, 0);
  assert.deepEqual(store.loadStatements().map((s) => [s.text, s.ts_seq]).sort(), [[u1, undefined], [u2, undefined], [u3, undefined]].sort());
});
