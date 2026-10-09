// Every Code rollouts (transcripts/code-rollout.mjs): they carry no UserMessage events, so every user message is a candidate, Auto Drive's and
// the review loop's included, and nothing in the record tells them apart. The typed-prompt logs do: a turn of a session a log names is kept
// only when it is one of the session's typed rows (a long paste matches its placeholder); a session no log names is nobody's typed session
// when its home's log was being written before and after the turn, and undecided (kept, as before) outside the log's span or without a log;
// a young turn the log does not vouch for yet waits for the next pass. Codex rollouts are untouched. Synthetic rollouts, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { codeTurnVerdict } from "../scripts/lib/transcripts/code-rollout.mjs";
import { HISTORY_SETTLE_MS } from "../scripts/lib/transcripts/history-scan.mjs";
import { isTypedTurn, typedMatcher } from "../scripts/lib/transcripts/typed-rows.mjs";
import { writeTranscript } from "./transcript-builders.mjs";
import { tmpDir } from "./helpers.mjs";

const NAMED = "0190e000-c0de-7000-8000-00000000c001"; // the log names it: the person typed two prompts, Auto Drive wrote the rest
const AGENT = "0190e000-c0de-7000-8000-00000000c002"; // no log row, inside the log's span: an agent's session
const OLD = "0190e000-c0de-7000-8000-00000000c003"; // no log row, before the log's first row: the log cannot say
const at = (min) => new Date(Date.parse("2026-04-02T08:00:00.000Z") + min * 60_000).toISOString();
const sec = (min) => Math.floor(Date.parse(at(min)) / 1000);
const NOW = Date.parse("2026-10-01T00:00:00.000Z");

const meta = (id, ts) => JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, timestamp: ts, cwd: "/home/sam/projects/web-app", originator: "code_cli_rs", cli_version: "0.0.0", source: "cli", model_provider: null } });
const user = (text, ts) => JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const asst = (text, ts) => JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const PASTED = "The stack trace from the failing job:\nError: column totals missing\n    at render (report.ts:41)";

function world({ kind = ".code", log = true } = {}) {
  const root = tmpDir("recall-code-rollouts");
  const home = path.join(root, kind);
  const day = path.join(home, "sessions", "2026", "04", "02");
  fs.mkdirSync(day, { recursive: true });
  writeTranscript(`rollout-2026-04-02T08-00-00-${NAMED}.jsonl`, [
    meta(NAMED, at(0)),
    user("Please make the monthly report group rows by account first", at(1)),
    asst("Grouped by account.", at(2)),
    user("Primary Goal: make the monthly report group rows by account\n\nOutline the steps first, then carry them out one by one.", at(3)),
    user("Close the remaining gap: add a test for the empty month and run the full suite before reporting back", at(5)),
    user(`Here is what the job printed ${PASTED} can you fix the totals?`, at(7)),
  ], day);
  writeTranscript(`rollout-2026-04-02T08-30-00-${AGENT}.jsonl`, [meta(AGENT, at(30)), user("Context: repo web-app. Review the unstaged changes for correctness and report findings only", at(31))], day);
  writeTranscript(`rollout-2026-04-01T07-00-00-${OLD}.jsonl`, [meta(OLD, at(-60)), user("Before the log began: the invoice page should load the current month by default", at(-59))], day);
  if (log) {
    fs.writeFileSync(path.join(home, "history.jsonl"), [
      { session_id: "0190e000-c0de-7000-8000-00000000c009", ts: sec(-1), text: "an earlier session of the same home, typed before the others started" },
      { session_id: NAMED, ts: sec(1), text: "Please make the monthly report group rows by account first" },
      { session_id: NAMED, ts: sec(3), text: "/auto make the monthly report group rows by account" },
      { session_id: NAMED, ts: sec(7), text: "Here is what the job printed [Pasted Content 82 chars] can you fix the totals?" },
      { session_id: "0190e000-c0de-7000-8000-00000000c009", ts: sec(90), text: "a later row of another session, so the log spans the agent's session" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  return { root, home, day, store, run: (o = {}) => runIndex({ config, store, homeDir: root, env: {}, embed: false, now: () => NOW, ...o }) };
}
const rolloutTexts = (store) => store.loadStatements().filter((s) => !s.src.includes("history.jsonl")).map((s) => s.text);

test("typed rows: whole-text match with whitespace collapsed; a paste placeholder stands for the pasted text; a bare command matches nothing", () => {
  const m = [typedMatcher("Here is what the job printed [Pasted Content 82 chars] can you fix the totals?"), typedMatcher("keep the  totals\nright aligned")].filter(Boolean);
  assert.equal(isTypedTurn(`Here is what the job printed ${PASTED} can you fix the totals?`, m), true);
  assert.equal(isTypedTurn("keep the totals right aligned", m), true);
  assert.equal(isTypedTurn("keep the totals right aligned on mobile", m), false, "a turn that only starts like a typed row is not it");
  assert.equal(isTypedTurn("Here is what the job printed", m), false);
  assert.equal(typedMatcher(""), null);
  assert.equal(typedMatcher("   "), null);
});

test("Every Code rollout of a session the log names: only its typed turns are statements; Auto Drive's wrapper and prompts are not", async () => {
  const w = world();
  const report = await w.run();
  const texts = rolloutTexts(w.store);
  assert.ok(texts.includes("Please make the monthly report group rows by account first"));
  assert.ok(texts.some((t) => t.startsWith("Here is what the job printed The stack trace from the failing job")), "the paste is the person's");
  assert.ok(!texts.some((t) => t.startsWith("Primary Goal:") || t.startsWith("Close the remaining gap")));
  assert.equal(report.excluded["code-turn-not-typed"], 2);
});

test("Every Code rollout of a session no log names: dropped inside its home's log span, kept outside it or when the home keeps no log", async () => {
  const w = world();
  const report = await w.run();
  const texts = rolloutTexts(w.store);
  assert.ok(!texts.some((t) => t.startsWith("Context: repo web-app")), "an agent's session: the log was being written before and after it");
  assert.equal(report.excluded["code-session-not-typed"], 1);
  assert.ok(texts.includes("Before the log began: the invoice page should load the current month by default"));
  const bare = world({ log: false });
  await bare.run();
  assert.equal(rolloutTexts(bare.store).length, 6, "no log at all: every user turn of the three rollouts is a candidate, as before");
});

test("a Codex rollout without UserMessage events is not decided by the logs", async () => {
  const w = world({ kind: ".codex" });
  const report = await w.run();
  assert.equal(report.excluded["code-turn-not-typed"], undefined);
  assert.ok(rolloutTexts(w.store).some((t) => t.startsWith("Close the remaining gap")));
});

test("a young Every Code turn the log does not vouch for waits; the next pass after its row is written keeps it", async () => {
  const w = world();
  const file = path.join(w.day, `rollout-2026-04-02T08-00-00-${NAMED}.jsonl`);
  const young = new Date(NOW - 60_000).toISOString();
  fs.appendFileSync(file, `${user("A prompt typed a minute ago whose log row is not written yet", young)}\n${user("Typed right after it, still waiting behind it", young)}\n`);
  const first = await w.run();
  assert.equal(first.excluded["code-turn-not-typed"], 2, "the settled Auto Drive turns are decided");
  const state = w.store.loadState().files[file];
  assert.equal(state.pending, true);
  assert.equal(state.lines, 6, "the pass stopped before the young turn");
  assert.ok(!rolloutTexts(w.store).some((t) => t.startsWith("A prompt typed a minute ago")));
  fs.appendFileSync(path.join(w.home, "history.jsonl"), `${JSON.stringify({ session_id: NAMED, ts: Math.floor((NOW - 59_000) / 1000), text: "A prompt typed a minute ago whose log row is not written yet" })}\n`);
  const second = await w.run({ now: () => NOW + HISTORY_SETTLE_MS });
  assert.equal(second.added, 1);
  assert.ok(rolloutTexts(w.store).some((t) => t.startsWith("A prompt typed a minute ago")));
  assert.equal(second.excluded["code-turn-not-typed"], 1, "the one behind it is settled now and was never typed");
  assert.equal(w.store.loadState().files[file].pending, undefined);
});

test("codeTurnVerdict: a turn without a time is never left waiting", () => {
  const typed = { sessions: new Map([[NAMED, []]]), spans: new Map() };
  assert.equal(codeTurnVerdict({ session_id: NAMED, ts: null, raw: "anything" }, { typed, home: "/h", now: NOW }), "code-turn-not-typed");
  assert.equal(codeTurnVerdict({ session_id: AGENT, ts: null, raw: "anything" }, { typed, home: "/h", now: NOW }), "keep");
});
