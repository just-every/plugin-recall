// Every Code rollouts against the typed-prompt logs (code-rollout.mjs, typed-rows.mjs), in the cases the first tests left open: a session of
// 2025 whose log holds Auto Drive's submissions (they are no typed rows, so the rollout's coordinator turn is dropped while the goal typed on
// the /auto row is kept), a young turn of a session no log names that comes after the log's last row (it waits, and is decided once the log
// has moved past it), and the goal typed after /auto in a session whose rollout holds only Auto Drive's "Primary Goal:" wrapper (indexed from
// the log row, once). Synthetic rollouts and logs, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { HISTORY_SETTLE_MS } from "../scripts/lib/transcripts/history-scan.mjs";
import { stampPeel } from "../scripts/lib/transcripts/peel-backfill.mjs";
import { writeTranscript } from "./transcript-builders.mjs";
import { tmpDir } from "./helpers.mjs";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const OTHER = "0190e000-c0de-7000-8000-00000000c0f0";
const meta = (id, ts) => JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, timestamp: ts, cwd: "/home/sam/projects/web-app", originator: "code_cli_rs", cli_version: "0.0.0", source: "cli", model_provider: null } });
const user = (text, ts) => JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

function home() {
  const root = tmpDir("recall-code-gates");
  const dir = path.join(root, ".code");
  fs.mkdirSync(dir, { recursive: true });
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  const rollout = (id, stamp, lines) => {
    const day = path.join(dir, "sessions", ...stamp.slice(0, 10).split("-"));
    fs.mkdirSync(day, { recursive: true });
    return writeTranscript(`rollout-${stamp}-${id}.jsonl`, lines, day);
  };
  const run = (now = NOW) => runIndex({ config, store, homeDir: root, env: {}, embed: false, now: () => now });
  return { root, dir, store, rollout, run, log: path.join(dir, "history.jsonl") };
}
const textsOf = (store) => store.loadStatements().map((s) => [s.text, s.src.includes("history.jsonl") ? "log" : "rollout"]);

test("a 2025 session: the log's Auto Drive rows are no typed rows, so the rollout's coordinator turn is dropped; the /auto goal is kept once", async () => {
  const w = home();
  const S = "0190e000-c0de-7000-8000-00000000c011";
  const goal = "make the report faster for large accounts";
  const coordinator = `Primary Goal: ${goal}\n\nPlan first, then implement in small steps and verify each one.`;
  fs.writeFileSync(w.log, jsonl([
    { session_id: OTHER, ts: sec("2025-08-31T09:00:00Z"), text: "an earlier session of the same home, so the log spans the run" },
    { session_id: S, ts: sec("2025-09-01T09:00:00Z"), text: `/auto ${goal}` },
    { session_id: S, ts: sec("2025-09-01T09:00:30Z"), text: coordinator },
    { session_id: OTHER, ts: sec("2025-09-02T09:00:00Z"), text: "a later row of another session typed the next morning" },
  ]));
  w.rollout(S, "2025-09-01T09-00-00", [meta(S, "2025-09-01T09:00:00.000Z"), user(goal, "2025-09-01T09:00:01.000Z"), user(coordinator, "2025-09-01T09:00:31.000Z")]);
  const report = await w.run();
  assert.equal(report.excluded["code-turn-not-typed"], 1, "the coordinator's turn");
  assert.equal(report.excluded["auto-drive"], 1, "the coordinator's log row");
  const texts = textsOf(w.store).filter(([t]) => !t.includes("session"));
  assert.deepEqual(texts, [[goal, "rollout"]], "the goal is the rollout's typed turn, and its log row adds no second statement");
  assert.equal(report.excluded["history-in-transcript"], 1);
});

test("a young turn of a session no log names, after the log's last row, waits; once the log has moved past it, it is dropped", async () => {
  const w = home();
  const U = "0190e000-c0de-7000-8000-00000000c012";
  fs.writeFileSync(w.log, jsonl([{ session_id: OTHER, ts: Math.floor((NOW - 3_600_000) / 1000), text: "typed an hour ago in another session of this home" }]));
  const young = new Date(NOW - 120_000).toISOString();
  const file = w.rollout(U, "2026-09-30T23-58-00", [meta(U, young), user("Context: repo web-app. Review the unstaged changes and report findings only", young)]);
  const first = await w.run();
  assert.equal(w.store.loadState().files[file].pending, true);
  assert.equal(w.store.loadState().files[file].lines, 1, "the pass stopped before the young turn");
  assert.equal(textsOf(w.store).filter(([, src]) => src === "rollout").length, 0);
  assert.equal(first.excluded["code-session-not-typed"], undefined);
  fs.appendFileSync(w.log, jsonl([{ session_id: OTHER, ts: Math.floor((NOW + 60_000) / 1000), text: "typed a minute later in the other session again" }]));
  const second = await w.run(NOW + HISTORY_SETTLE_MS + 120_000);
  assert.equal(second.excluded["code-session-not-typed"], 1);
  assert.equal(textsOf(w.store).filter(([, src]) => src === "rollout").length, 0);
  assert.equal(w.store.loadState().files[file].pending, undefined);
});

test("the goal typed after /auto, in a session whose rollout holds only Auto Drive's Primary Goal wrapper, is indexed from the log row once", async () => {
  const w = home();
  const S = "0190e000-c0de-7000-8000-00000000c013";
  const goal = "keep researching different approaches until we have a competitive solution";
  fs.writeFileSync(w.log, jsonl([
    { session_id: S, ts: sec("2026-05-02T09:00:00Z"), text: "Please read the benchmark notes in docs/bench.md before anything else" },
    { session_id: S, ts: sec("2026-05-02T09:10:00Z"), text: `/auto ${goal}` },
  ]));
  w.rollout(S, "2026-05-02T09-00-00", [meta(S, "2026-05-02T09:00:00.000Z"),
    user("Please read the benchmark notes in docs/bench.md before anything else", "2026-05-02T09:00:01.000Z"),
    user(`Primary Goal: ${goal}\n\nOrient yourself to this repository first, then plan.`, "2026-05-02T09:10:02.000Z")]);
  const report = await w.run();
  assert.deepEqual(textsOf(w.store), [["Please read the benchmark notes in docs/bench.md before anything else", "rollout"], [goal, "log"]]);
  assert.equal(report.excluded["code-turn-not-typed"], 1);
  assert.equal(report.excluded["history-session-has-rollout"], 1, "the other row of the session is the rollout's");
  const again = await w.run();
  assert.equal(again.added, 0);
});

test("an index built by 0.4.0 gets the /auto goal on its upgrade: the log is backfilled and the goal row admitted", async () => {
  const w = home();
  const S = "0190e000-c0de-7000-8000-00000000c014";
  const goal = "test then commit the uncommitted changes in the web app";
  fs.writeFileSync(w.log, jsonl([{ session_id: S, ts: sec("2026-05-03T09:00:00Z"), text: `/auto ${goal}` }]));
  const file = w.rollout(S, "2026-05-03T09-00-00", [meta(S, "2026-05-03T09:00:00.000Z"), user(`Primary Goal: ${goal}\n\nPlan first.`, "2026-05-03T09:00:02.000Z")]);
  const st = (f, lines) => { const s = fs.statSync(f); return { size: s.size, mtimeMs: s.mtimeMs, offset: s.size, lines }; };
  w.store.saveState({ files: { [w.log]: { ...st(w.log, 1), peel: 1 }, [file]: stampPeel({ ...st(file, 2), meta: { id: S, cwd: "/home/sam/projects/web-app", git_url: null, source: "cli", thread_source: null, originator: "code_cli_rs", timestamp: "2026-05-03T09:00:00.000Z" }, seenEvents: false }) }, lastIndexAt: null });
  const report = await w.run();
  assert.equal(report.backfilled, 1);
  assert.deepEqual(textsOf(w.store), [[goal, "log"]]);
});

test("an /auto row of a Codex log is no Auto Drive goal: in a session that has a rollout it defers to the rollout like any row", async () => {
  const root = tmpDir("recall-codex-auto-row");
  const dir = path.join(root, ".codex");
  const day = path.join(dir, "sessions", "2026", "05", "04");
  fs.mkdirSync(day, { recursive: true });
  const S = "0190f000-c0de-7000-8000-00000000c0f4";
  const typed = "/auto tidy the cart module and keep its public exports unchanged";
  const codexMeta = JSON.stringify({ timestamp: "2026-05-04T09:00:00.000Z", type: "session_meta", payload: { id: S, timestamp: "2026-05-04T09:00:00.000Z", cwd: "/home/sam/projects/web-app", originator: "codex_cli_rs", cli_version: "0.50.0", source: "cli", thread_source: "user" } });
  writeTranscript(`rollout-2026-05-04T09-00-00-${S}.jsonl`, [codexMeta, user(typed, "2026-05-04T09:00:02.000Z")], day);
  fs.writeFileSync(path.join(dir, "history.jsonl"), jsonl([{ session_id: S, ts: sec("2026-05-04T09:00:01Z"), text: typed }]));
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  const report = await runIndex({ config, store, homeDir: root, env: {}, embed: false, now: () => NOW });
  assert.equal(report.excluded["history-session-has-rollout"], 1);
  assert.deepEqual(textsOf(store).map(([, from]) => from), ["rollout"]);
});
