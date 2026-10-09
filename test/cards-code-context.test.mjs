// The "previous owner message" a card writer is shown for an Every Code statement (context-source.mjs, code-owner.mjs, enrich.mjs) is a
// message the person typed: from a rollout, a user turn counts only when it is one of its session's typed rows (an Auto Drive coordinator's
// prompt and a host's canned request are passed over); from a typed-prompt log of 2025, the run's Auto Drive submissions are passed over.
// Both through enrichStatements, with a stand-in worker that records its prompts. Synthetic homes, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scanContexts } from "../scripts/lib/cards/context-source.mjs";
import { createCodeOwners, rolloutHome } from "../scripts/lib/cards/code-owner.mjs";
import { enrichStatements } from "../scripts/lib/cards/enrich.mjs";
import { runEnrich } from "../scripts/lib/cards/run.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { writeTranscript } from "./transcript-builders.mjs";
import { tmpDir } from "./helpers.mjs";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const S = "0190e000-c0de-7000-8000-00000000c0c1";
const meta = (id, ts) => JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, timestamp: ts, cwd: "/home/sam/projects/web-app", originator: "code_cli_rs", cli_version: "0.0.0", source: "cli", model_provider: null } });
const user = (text, ts) => JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const asst = (text, ts) => JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const FIRST = "Please make the invoice export faster for the big accounts";
const SUMMARY = "Please write a Session Summary for the most recent Auto Drive session in this chat, covering what was done and what is left.";
const STATEMENT = "Ship the faster export behind the beta flag for now";

const promptWorker = () => {
  const prompts = [];
  const fn = async (o) => {
    prompts.push(o.prompt);
    const n = Number(/exactly one entry for each of the (\d+) numbered/.exec(o.prompt)[1]);
    return { json: { cards: Array.from({ length: n }, (_, i) => ({ n: i + 1, kind: "decision", scope: "repo", gist: "the agent was speeding up the export" })) }, home: "/h/.claude_x", kind: "claude" };
  };
  fn.prompts = prompts;
  return fn;
};

function world() {
  const root = tmpDir("recall-code-context");
  const home = path.join(root, ".code");
  const day = path.join(home, "sessions", "2026", "05", "02");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(home, "history.jsonl"), [
    { session_id: S, ts: sec("2026-05-02T09:00:00Z"), text: FIRST },
    { session_id: S, ts: sec("2026-05-02T09:01:00Z"), text: "/auto make the invoice export stream its rows" },
    { session_id: S, ts: sec("2026-05-02T10:00:00Z"), text: STATEMENT },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const file = writeTranscript(`rollout-2026-05-02T09-00-00-${S}.jsonl`, [
    meta(S, "2026-05-02T09:00:00.000Z"),
    user(FIRST, "2026-05-02T09:00:01.000Z"),
    asst("Looking at the export.", "2026-05-02T09:00:30.000Z"),
    user("Primary Goal: make the invoice export stream its rows\n\nPlan first, then implement in small steps.", "2026-05-02T09:01:02.000Z"),
    asst("Streaming is in.", "2026-05-02T09:40:00.000Z"),
    user(SUMMARY, "2026-05-02T09:41:00.000Z"),
    asst("Summary: the export streams rows now.", "2026-05-02T09:42:00.000Z"),
    user(STATEMENT, "2026-05-02T10:00:01.000Z"),
  ], day);
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  return { root, home, file, config, store };
}

test("rolloutHome: the directory a rollout's sessions/ or archived_sessions/ tree hangs from", () => {
  assert.equal(rolloutHome("/h/.code/sessions/2026/05/02/rollout-x.jsonl"), "/h/.code");
  assert.equal(rolloutHome("/h/backup/.code/archived_sessions/rollout-x.jsonl.zst"), "/h/backup/.code");
  assert.equal(rolloutHome("/h/rollout-x.jsonl"), null);
});

test("scanContexts with the typed-row rule: the coordinator prompt and the canned summary request are no previous owner message", async () => {
  const w = world();
  const codeOwner = await createCodeOwners({ config: w.config, homeDir: w.root, env: {}, now: NOW })(w.file);
  const ruled = await scanContexts({ file: w.file, host: "code", config: w.config, codeOwner, targets: [{ key: "st", line: 8, text: STATEMENT }] });
  assert.deepEqual(ruled.get("st"), { owner: FIRST, assistant: "Summary: the export streams rows now." });
  const bare = await scanContexts({ file: w.file, host: "code", config: w.config, targets: [{ key: "st", line: 8, text: STATEMENT }] });
  assert.equal(bare.get("st").owner, SUMMARY, "without the rule the canned request would be taken for the person's");
});

test("enrich: an Every Code rollout statement's card prompt shows the person's previous message", async () => {
  const w = world();
  await runIndex({ config: w.config, store: w.store, homeDir: w.root, env: {}, embed: false, now: () => NOW });
  const statement = w.store.loadStatements().find((s) => s.text === STATEMENT && !s.src.includes("history.jsonl"));
  assert.ok(statement, "the typed statement is indexed from the rollout");
  const worker = promptWorker();
  await enrichStatements({ statements: [statement], existing: new Map(), outFile: path.join(w.root, "cards.jsonl"), runWorker: worker, config: w.config, homeDir: w.root, env: {} });
  assert.match(worker.prompts[0], new RegExp(`Previous owner message: "${FIRST}"\\nPrevious assistant message: "Summary: the export streams rows now\\."\\nStatement: "${STATEMENT}"`));
});

test("enrich: an Every Code log statement of 2025 does not get an Auto Drive submission as its previous owner message", async () => {
  const root = tmpDir("recall-code-context-log");
  const home = path.join(root, ".code");
  fs.mkdirSync(home, { recursive: true });
  const R = "0190e000-ad00-7000-8000-00000000adc1";
  const t0 = sec("2025-09-20T09:00:00Z");
  fs.writeFileSync(path.join(home, "history.jsonl"), [
    { session_id: R, ts: t0, text: "/auto rework the invoice exporter so it streams rows instead of buffering them" },
    { session_id: R, ts: t0 + 40, text: "Primary goal: rework the invoice exporter to stream rows. Plan first, then implement in small steps." },
    { session_id: R, ts: t0 + 6 * 3600, text: "Back again: the streaming exporter is fine, ship it to the beta users" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  await runIndex({ config, store, homeDir: root, env: {}, embed: false, now: () => NOW });
  const statement = store.loadStatements().find((s) => s.text.startsWith("Back again"));
  const worker = promptWorker();
  await enrichStatements({ statements: [statement], existing: new Map(), outFile: path.join(root, "cards.jsonl"), runWorker: worker, config, homeDir: root, env: {} });
  assert.match(worker.prompts[0], /Previous owner message: "rework the invoice exporter so it streams rows instead of buffering them"\nPrevious assistant message: \(none\)/);
});

test("recall enrich through the runtime looks up the typed-prompt logs in the runtime's home folder", async () => {
  const w = world();
  await runIndex({ config: w.config, store: w.store, homeDir: w.root, env: {}, embed: false, now: () => NOW });
  const worker = promptWorker();
  const runtime = createRuntime(w.config, { homeDir: w.root, runWorker: worker });
  await runEnrich({ config: w.config, runtime, preflight: async () => ({ worker: "claude" }) });
  const prompt = worker.prompts.find((p) => p.includes(`Statement: "${STATEMENT}"`));
  assert.match(prompt, new RegExp(`Previous owner message: "${FIRST}"\\nPrevious assistant message: "Summary: the export streams rows now\\."\\nStatement: "${STATEMENT}"`));
});

test("scanContexts names an Every Code rollout's session by its session_meta, as the indexer does, not by the file name", async () => {
  const w = world();
  const renamed = path.join(path.dirname(w.file), "rollout-2026-05-02T09-00-00-0190e000-c0de-7000-8000-00000000c0ff.jsonl");
  fs.renameSync(w.file, renamed);
  const codeOwner = await createCodeOwners({ config: w.config, homeDir: w.root, env: {}, now: NOW })(renamed);
  const ruled = await scanContexts({ file: renamed, host: "code", config: w.config, codeOwner, targets: [{ key: "st", line: 8, text: STATEMENT }] });
  assert.equal(ruled.get("st").owner, FIRST);
});
