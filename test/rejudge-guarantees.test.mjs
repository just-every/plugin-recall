// What the upgrade's re-judging (transcripts/rejudge.mjs) guarantees beyond a line's own verdict:
//   - a rollout the scanner now rejects whole (a session that is not a person's) has every statement retired, with the session verdict;
//   - two statements of one turn (two copies read to two texts by earlier rules) that the current rules read to one text leave one statement:
//     the first is rewritten, the second retired;
//   - the decisions are written before the scan state that stamps the file: a pass that dies in between re-judges the file next time.
// Synthetic rollouts and transcripts, hand-made indexes of earlier versions, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { PEEL_VERSION } from "../scripts/lib/transcripts/peel-backfill.mjs";
import { norm, sha1, textHash } from "../scripts/lib/text.mjs";
import { claudeUser, codexUser, writeTranscript } from "./transcript-builders.mjs";
import { tmpDir } from "./helpers.mjs";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const idOf = (host, ts, text) => `${host}-${sha1(`${host}\u0000${ts}\u0000${norm(text)}`, 16)}`;
const row = (host, text, ts, session_id, src) => ({ id: idOf(host, ts, text), text, ts, session_id, repo: "shop", host, hash: textHash(text), src });
const fileState = (file, lines, over = {}) => { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs, offset: st.size, lines, ...over }; };
const retired = (store) => (fs.existsSync(store.retiredFile) ? fs.readFileSync(store.retiredFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const metaOf = (id, payload) => JSON.stringify({ timestamp: "2026-09-05T10:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2026-09-05T10:00:00.000Z", cwd: "/home/sam/projects/shop", cli_version: "0.50.0", ...payload } });
const metaState = (id, payload) => ({ id, cwd: "/home/sam/projects/shop", git_url: null, source: null, thread_source: null, originator: null, timestamp: "2026-09-05T10:00:00.000Z", ...payload });

function codexHome(label) {
  const root = tmpDir(label);
  const day = path.join(root, ".codex", "sessions", "2026", "09", "05");
  fs.mkdirSync(day, { recursive: true });
  const dataDir = path.join(root, "data");
  const store = createStore(dataDir);
  const run = (o = {}) => runIndex({ config: loadConfig({ RECALL_DATA: dataDir }), store, homeDir: root, env: {}, embed: false, now: () => NOW, ...o });
  return { root, day, store, run };
}

for (const [kind, payload, reason] of [
  ["an exec session", { originator: "codex_exec", source: "exec", thread_source: "user" }, "exec-session"],
  ["a sub-agent session", { originator: "Codex Desktop", source: "vscode", thread_source: "subagent" }, "subagent-session"],
]) {
  test(`a rollout the scanner now rejects whole (${kind}): its statements are retired with the session verdict`, async () => {
    const w = codexHome("recall-rejudge-whole");
    const S = "0190f000-bf11-7000-8000-00000000bf21";
    const file = writeTranscript(`rollout-2026-09-05T10-00-00-${S}.jsonl`, [metaOf(S, payload), codexUser("Summarize the failing checkout tests and fix them", "2026-09-05T10:00:05.000Z"), codexUser("Then rerun the whole suite once", "2026-09-05T10:03:00.000Z")], w.day);
    const kept = [row("codex", "Summarize the failing checkout tests and fix them", "2026-09-05T10:00:05.000Z", S, `${file}:L2`), row("codex", "Then rerun the whole suite once", "2026-09-05T10:03:00.000Z", S, `${file}:L3`)];
    w.store.appendStatements(kept);
    // what an earlier version left: it read the session as the person's
    w.store.saveState({ files: { [file]: fileState(file, 3, { meta: metaState(S, payload), seenEvents: true, peel: 1 }) }, lastIndexAt: null });
    const report = await w.run();
    assert.equal(report.backfilled, 1);
    assert.deepEqual(retired(w.store).map((s) => [s.id, s.retired.reason]), kept.map((s) => [s.id, reason]));
    assert.deepEqual(w.store.loadStatements(), []);
    assert.equal(w.store.loadState().files[file].peel, PEEL_VERSION);
  });
}

test("two statements of one turn that earlier rules read to two texts, now read to one: one is rewritten, the other retired", async () => {
  const w = codexHome("recall-rejudge-two-held");
  const S = "0190f000-bf11-7000-8000-00000000bf22";
  const payload = { originator: "Codex Desktop", source: "vscode", thread_source: "user" };
  const ts = "2026-09-05T10:00:05.000Z";
  const raw = "# Browser comments:\n\n## User Comment 1\nTarget: button.checkout\nComment: make this button green\n\n## My request for Codex:\nAnd move the coupon field under the total";
  const lines = [metaOf(S, payload), codexUser(raw, ts)];
  const a = writeTranscript(`rollout-2026-09-05T10-00-00-${S}.jsonl`, lines, w.day);
  const b = writeTranscript(`rollout-2026-09-05T11-00-00-${S}.jsonl`, lines, w.day);
  // one copy kept the comment only, the other the request only: two texts, two ids for the one turn
  const held = [row("codex", "make this button green", ts, S, `${a}:L2`), row("codex", "And move the coupon field under the total", ts, S, `${b}:L2`)];
  w.store.appendStatements(held);
  const st = (f) => fileState(f, 2, { meta: metaState(S, payload), seenEvents: true, peel: 1 });
  w.store.saveState({ files: { [a]: st(a), [b]: st(b) }, lastIndexAt: null });
  const report = await w.run();
  assert.deepEqual([report.rejudged.rewritten, report.rejudged.retired, report.rejudged.retiredBy], [1, 1, { "turn-held-by-another-statement": 1 }]);
  const now = w.store.loadStatements();
  assert.equal(now.length, 1);
  assert.equal(now[0].text, "make this button green And move the coupon field under the total");
  assert.ok(held.some((s) => s.id === now[0].id), "the turn keeps one of its ids");
  assert.deepEqual(retired(w.store).map((s) => s.id), held.filter((s) => s.id !== now[0].id).map((s) => s.id));
});

test("the decisions are written before the scan state is saved: a pass that dies writing them leaves the file unstamped, the next applies them", async () => {
  const root = tmpDir("recall-rejudge-crash");
  const project = path.join(root, ".claude", "projects", "-home-sam-projects-shop");
  fs.mkdirSync(project, { recursive: true });
  const session = "5eee0000-0000-4000-8000-0000000000e1";
  const resume = "I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.";
  const file = writeTranscript(`${session}.jsonl`, [claudeUser("Use the shared money helper for every total on the checkout page", "2026-09-06T09:00:00.000Z"), claudeUser(resume, "2026-09-06T11:41:35.000Z")], project);
  const dataDir = path.join(root, "data");
  const store = createStore(dataDir);
  const kept = row("claude", "Use the shared money helper for every total on the checkout page", "2026-09-06T09:00:00.000Z", session, `${file}:L1`);
  const host = row("claude", resume, "2026-09-06T11:41:35.000Z", session, `${file}:L2`);
  store.appendStatements([kept, host]);
  store.saveState({ files: { [file]: fileState(file, 2, { peel: 1 }) }, lastIndexAt: null });
  let fail = true;
  const failing = { ...store, updateStatements: (change) => { if (fail) { fail = false; throw new Error("disk full"); } return store.updateStatements(change); } };
  const run = (s) => runIndex({ config: loadConfig({ RECALL_DATA: dataDir }), store: s, homeDir: root, env: {}, embed: false, now: () => NOW });
  await assert.rejects(run(failing), /disk full/);
  assert.equal(store.loadState().files[file].peel, 1, "the state was not stamped");
  assert.equal(store.loadStatements().length, 2);
  const report = await run(store);
  assert.equal(report.backfilled, 1);
  assert.deepEqual(retired(store).map((s) => [s.id, s.retired.reason]), [[host.id, "harness"]]);
  assert.deepEqual(store.loadStatements().map((s) => s.id), [kept.id]);
  assert.equal(store.loadState().files[file].peel, PEEL_VERSION);
});
