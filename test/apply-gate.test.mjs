// The apply gate (scripts/lib/apply-gate.mjs): the second Decisions question over the eligible survivors. No network: the fake OpenAI records
// every question, so the exact question, the statement line and the situation are asserted literally, and its `decideApply` answers the gate.
// Synthetic statements only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { APPLY_TEXT, GATE_LOG_MAX, applyGate, applyQuestion, gateRecord } from "../scripts/lib/apply-gate.mjs";
import { appendCards, cardsPath } from "../scripts/lib/cards/cards-file.mjs";
import { buildCard } from "../scripts/lib/cards/schema.mjs";
import { ConfigError, V1_ENV, loadConfig, needsCards } from "../scripts/lib/config.mjs";
import { parseHookInput } from "../scripts/lib/hook-io.mjs";
import { createHubIndex } from "../scripts/lib/hub-index.mjs";
import { loadIndexedCorpus } from "../scripts/lib/index-corpus.mjs";
import { selectInjection } from "../scripts/lib/injection.mjs";
import { summarizeLogs, formatSummary } from "../scripts/lib/log-summary.mjs";
import { clip } from "../scripts/lib/text.mjs";
import { GENERIC_TEXT, itemLine } from "../scripts/lib/pipelines/questions.mjs";
import { handlePrompt } from "../scripts/lib/prompt-hook.mjs";
import { retrieve } from "../scripts/lib/retrieve.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { costUsd, estimateTokens } from "../scripts/lib/ledger.mjs";
import { pluginRoot } from "../scripts/lib/plugin-root.mjs";
import { createTurnState } from "../scripts/lib/turn-log.mjs";
import { gateRows, gateSummary } from "../scripts/monitor/static/gate.js";
import { fakeOpenAI, isApplyQuestion, readFixture, seedIndex, tmpDir } from "./helpers.mjs";

const AT = "2026-10-08T12:00:00.000Z";
const NOW = () => new Date("2026-10-07T12:00:00Z");
const PROMPT = "The duplicate draft runs come from a re-execution path, so I will add a fallback path with a random limit to stop them.";
const hookInput = (over = {}) => parseHookInput({ stdin: JSON.stringify({ ...JSON.parse(readFixture("hook-inputs", "claude-prompt.json")), prompt: PROMPT, ...over }) });

// Five global rules that all share words with the prompt, so the fake judge (yes to everything) passes them all and the fused order is fixed by the rankers.
const T = (n) => `2026-09-0${n}T10:00:00.000Z`;
const ROWS = [
  { id: "s1", ts: T(1), repo: "lib-a", text: "Never add a fallback path or a random limit, fix the code structure instead.", card: { kind: "rule", scope: "global", gist: "the agent had added a fallback path to hide a failure" } },
  { id: "s2", ts: T(2), repo: "lib-b", text: "I prefer a proper fix over a fallback path: keep the draft code structure simple.", card: { kind: "preference", scope: "global", gist: "the agent offered two ways to fix the duplicate runs" } },
  { id: "s3", ts: T(3), repo: "lib-c", text: "A random limit on the duplicate draft runs is never an acceptable fix, find the re-execution path.", card: { kind: "rule", scope: "global", gist: "the agent proposed capping the runs" } },
  { id: "s4", ts: T(4), repo: "lib-d", text: "Always trace a duplicate run back to its re-execution path before changing anything.", card: { kind: "rule", scope: "global", gist: "the agent started editing before it had found the cause" } },
  { id: "s5", ts: T(5), repo: "lib-e", text: "No fallback path, no random limit, no hidden retries when fixing the draft runs.", card: { kind: "rule", scope: "global", gist: "the agent was reviewing the draft code" } },
];
const SESSION = hookInput().session_id;

async function world({ env = {}, rows = ROWS, api = {}, post = null } = {}) {
  const dataDir = tmpDir("recall-gate");
  const config = loadConfig({ RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_DAILY_CAP_USD: "5", RECALL_ALLOW_HEADLESS: "1", RECALL_K: "3", ...env });
  const fake = fakeOpenAI({ decide: () => 0.99, ...api });
  const runtime = createRuntime(config, { post: post ? post(fake.post) : fake.post });
  await seedIndex(runtime.store, rows.map(({ card, ...r }) => r));
  appendCards(cardsPath(dataDir), rows.filter((r) => r.card).map((r) => buildCard({ statement: r, entry: { n: 1, ...r.card }, model: "haiku", at: AT, gistSource: "transcript" })));
  return { dataDir, config, fake, runtime };
}
const logLines = (dataDir) => {
  const dir = path.join(dataDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("turns-")).sort().flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map(JSON.parse)) : [];
};
const promptLine = (w) => logLines(w.dataDir).filter((l) => l.event === "prompt").at(-1);
const turn = async (w, over = {}) => { const out = await handlePrompt({ input: hookInput(over), config: w.config, runtime: w.runtime, now: NOW }); return { out, line: promptLine(w) }; };
const decisionCalls = (w) => w.fake.calls.filter((c) => c.pathname === "/v1/decisions").map((c) => c.body);
const applyQuestions = (w) => decisionCalls(w).flatMap((b) => b.questions.filter((q) => isApplyQuestion(q.instructions)).map((q) => ({ input: b.input, ...q })));
const quoteOf = (q) => /"([\s\S]*)"\n/.exec(q.instructions)[1];
const idOfQuote = (quote) => ROWS.find((r) => r.text === quote).id;
/** The fused order of the survivors, from a run with the gate off in a world of its own. */
async function fusedOrder(rows = ROWS) {
  const w = await world({ env: { RECALL_APPLY_GATE: "0", RECALL_K: "10" }, rows });
  return (await turn(w)).line.injected;
}
/** An apply answer per statement id. */
const byId = (table, rows = ROWS) => ({ quote }) => table[rows.find((r) => r.text === quote).id] ?? null;

// ---- the question and the statement line ----
test("the question and the statement line are x10's apply@g, character for character", () => {
  assert.equal(APPLY_TEXT, "Does this past owner statement apply to the task the assistant is doing right now, not just the same topic?");
  const item = { id: "s1", text: ROWS[0].text, card: { gist: ROWS[0].card.gist } };
  const q = applyQuestion(item);
  assert.equal(q.instructions, `Past owner statement (said while ${ROWS[0].card.gist}): "${ROWS[0].text}"\nDoes this past owner statement apply to the task the assistant is doing right now, not just the same topic?`);
  assert.equal(q.name, "s1|apply@g");
  assert.equal(q.instructions, `${itemLine(item, { itemGist: true })}\n${APPLY_TEXT}`);
  // the statement is clipped to 260 characters, as D-generic's is
  const long = applyQuestion({ id: "x", text: "w ".repeat(300), card: { gist: "g" } });
  assert.equal(long.instructions.split("\n")[0], `Past owner statement (said while g): "${clip("w ".repeat(300), 260)}"`);
  // D-generic's line has no gist and stays so
  assert.equal(itemLine(item, { itemGist: false }), `Past owner statement: "${ROWS[0].text}"`);
  assert.notEqual(GENERIC_TEXT, APPLY_TEXT);
});

test("the hook asks one request with one question per survivor, over the same situation as D-generic; D-generic's lines carry no gist", async () => {
  const w = await world();
  const { line } = await turn(w);
  const gate = applyQuestions(w);
  const generic = decisionCalls(w).flatMap((b) => b.questions.filter((q) => !isApplyQuestion(q.instructions)).map((q) => ({ input: b.input, ...q })));
  assert.equal(gate.length, 5, "all five survive");
  assert.equal(decisionCalls(w).filter((b) => b.questions.some((q) => isApplyQuestion(q.instructions))).length, 1, "one request");
  assert.deepEqual(new Set(gate.map((q) => q.input)), new Set(generic.map((q) => q.input)), "the same situation text");
  assert.ok(gate[0].input.startsWith("SITUATION"));
  for (const q of gate) {
    const row = ROWS.find((r) => r.text === quoteOf(q));
    assert.equal(q.instructions, `Past owner statement (said while ${row.card.gist}): "${row.text}"\n${APPLY_TEXT}`);
    assert.equal(q.type, "predicate");
    assert.equal(q.name, `${row.id}|apply@g`);
  }
  for (const q of generic) assert.ok(!q.instructions.includes("said while"), "itemGist stays off for D-generic");
  assert.equal(line.applyGate.requests, 1);
  assert.equal(line.applyGate.questions, 5);
});

// ---- selection ----
test("the survivors are reranked by the apply probability, descending, and the first k are injected", async () => {
  const fused = await fusedOrder();
  assert.equal(fused.length, 5);
  // ascending along the fused order: the gate must reverse it (only three of five fit)
  const table = Object.fromEntries(fused.map((id, i) => [id, 0.3 + 0.1 * i]));
  const w = await world({ api: { decideApply: byId(table) } });
  const { line, out } = await turn(w);
  const want = [...fused].reverse().slice(0, 3);
  assert.deepEqual(line.injected, want);
  assert.deepEqual(line.applyGate.rows.map((r) => r.id).sort(), [...fused].sort(), "every survivor is recorded");
  assert.notDeepEqual(want, fused.slice(0, 3), "this is a rerank, not the fused order");
  const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  const at = want.map((id) => ctx.indexOf(ROWS.find((r) => r.id === id).text));
  assert.ok(at.every((x) => x >= 0) && at[0] < at[1] && at[1] < at[2], "the block lists them best first");
  assert.equal(line.applyGate.survivors, 5);
  assert.equal(line.applyGate.passed, 5);
  assert.equal(line.applyGate.selected, 3);
});

test("ties in the apply probability keep the fused order", async () => {
  const fused = await fusedOrder();
  const w = await world({ api: { decideApply: 0.7 } });
  assert.deepEqual((await turn(w)).line.injected, fused.slice(0, 3));
});

test("the threshold: p at the bar passes (>=), p below it does not; a lone passer is injected alone", async () => {
  const fused = await fusedOrder();
  const [a, b, c, d, e] = fused;
  const w = await world({ api: { decideApply: byId({ [a]: 0.19, [b]: 0.2, [c]: 0.1999, [d]: 0.05, [e]: 0.2001 }) } });
  const { line } = await turn(w);
  assert.deepEqual(line.injected, [e, b], "0.2001 then 0.2; 0.19, 0.1999 and 0.05 are below the bar");
  const verdicts = Object.fromEntries(line.applyGate.rows.map((r) => [r.id, r.pass]));
  assert.deepEqual(verdicts, { [a]: false, [b]: true, [c]: false, [d]: false, [e]: true });
  assert.equal(line.applyGate.threshold, 0.2);
  // nothing reaches the bar: silent, and the line says why
  const low = await world({ api: { decideApply: 0.1 } });
  const r = await turn(low);
  assert.deepEqual(JSON.parse(r.out.stdout), { continue: true });
  assert.equal(r.line.outcome, "silent");
  assert.equal(r.line.reason, "nothing-above-threshold");
  assert.deepEqual(r.line.injected, []);
  assert.equal(r.line.applyGate.passed, 0);
});

test("applyThreshold moves the bar; k caps what passes", async () => {
  const fused = await fusedOrder();
  const table = Object.fromEntries(fused.map((id, i) => [id, 0.35 + 0.1 * i])); // 0.35 .. 0.75
  const hi = await world({ env: { RECALL_APPLY_THRESHOLD: "0.6" }, api: { decideApply: byId(table) } });
  assert.deepEqual((await turn(hi)).line.injected, [fused[4], fused[3]], "only 0.75 and 0.65 reach 0.6");
  const one = await world({ env: { RECALL_K: "1" }, api: { decideApply: byId(table) } });
  assert.deepEqual((await turn(one)).line.injected, [fused[4]]);
});

test("a refused question cannot pass, however the others are answered", async () => {
  const fused = await fusedOrder();
  const [a, b, c] = fused;
  const w = await world({ api: { decideApply: byId({ [a]: null, [b]: 0.9, [c]: 0.8, [fused[3]]: null, [fused[4]]: 0.5 }) } });
  const { line } = await turn(w);
  assert.deepEqual(line.injected, [b, c, fused[4]]);
  const rows = Object.fromEntries(line.applyGate.rows.map((r) => [r.id, r]));
  assert.deepEqual([rows[a].p, rows[a].pass, rows[fused[3]].p, rows[fused[3]].pass], [null, false, null, false]);
  assert.equal(line.applyGate.refused, 2);
  // all refused: nothing is injected, not the fused order
  const none = await world({ api: { decideApply: null } });
  const r = await turn(none);
  assert.equal(r.line.outcome, "silent");
  assert.deepEqual(r.line.injected, []);
  assert.deepEqual(JSON.parse(r.out.stdout), { continue: true });
  assert.equal(r.line.applyGate.refused, 5);
});

test("applyGate(): a missing answer is not a pass; a statement without a card is not asked and cannot pass", async () => {
  const w = await world();
  const { corpus } = loadIndexedCorpus(w.runtime.store);
  const withCard = ["s1", "s2", "s3"].map((id) => ({ id }));
  const card = (id) => ({ kind: "rule", scope: "global", gist: `gist of ${id}` });
  for (const e of withCard.slice(0, 2)) corpus.items[corpus.byId.get(e.id)].card = card(e.id);
  const asked = [];
  const deps = { scorePredicates: async ({ questions }) => { asked.push(...questions.map((q) => q.name)); return { probabilities: [0.9, undefined], costUsd: 0, requests: 1 }; } };
  const stats = {};
  const run = await applyGate({ entries: withCard, corpus, situation: "SITUATION x", deps, k: 3, threshold: 0.2, stats });
  assert.deepEqual(asked, ["s1|apply@g", "s2|apply@g"], "s3 has no card: not asked");
  assert.deepEqual(run.picked.map((e) => e.id), ["s1"]);
  assert.deepEqual(run.rows, [{ id: "s1", p: 0.9, pass: true }, { id: "s2", p: null, pass: false }, { id: "s3", p: null, pass: false }]);
  assert.equal(stats.refused, 2);
  // NaN is not an answer either
  const nan = await applyGate({ entries: withCard.slice(0, 1), corpus, situation: "SITUATION x", deps: { scorePredicates: async () => ({ probabilities: [NaN] }) }, k: 3, threshold: 0, stats: {} });
  assert.deepEqual(nan.picked, []);
});

test("more than 200 survivors would be packed, never truncated", async () => {
  const w = await world();
  const { corpus } = loadIndexedCorpus(w.runtime.store);
  const entries = ROWS.map((r) => ({ id: r.id }));
  for (const e of entries) corpus.items[corpus.byId.get(e.id)].card = { kind: "rule", scope: "global", gist: "g" };
  const seen = [];
  const deps = { scorePredicates: async ({ questions, packSize }) => { seen.push({ n: questions.length, packSize }); return { probabilities: questions.map(() => 0.5), costUsd: 0, requests: 1 }; } };
  await applyGate({ entries, corpus, situation: "SITUATION x", deps, k: 3, threshold: 0.2, stats: {} });
  assert.deepEqual(seen, [{ n: 5, packSize: 200 }], "one call, packSize at the API limit");
});

// ---- where it sits: only the eligible survivors are asked ----
test("only the survivors are asked: not what D-generic rejected, not a repeat of this session, not a hub", async () => {
  const fused = await fusedOrder();
  const [a, b, c, d] = fused;
  const rejected = ROWS.find((r) => r.id === c).text;
  const w = await world({ api: { decide: ({ instructions }) => (instructions.includes(rejected) ? 0.5 : 0.99) } });
  // b was injected earlier in this very session (noRepeat); d is a hub: it was injected into three other sessions
  createTurnState(w.dataDir).write("sess-gate", { session_id: "sess-gate", at: AT, injected: [b] });
  const hubs = createHubIndex({ dataDir: w.dataDir, windowDays: 14, now: () => new Date("2026-10-06T12:00:00Z") });
  for (const s of ["o1", "o2", "o3"]) hubs.record({ sessionId: s, ids: [d] });
  const { line } = await turn(w, { session_id: "sess-gate" });
  const asked = applyQuestions(w).map((q) => idOfQuote(quoteOf(q)));
  assert.deepEqual(asked.sort(), [a, fused[4]].sort(), "only what is left after D-generic's bar, noRepeat and the hub rule");
  assert.deepEqual(line.repeats, [b]);
  assert.deepEqual(line.hubs, [d]);
  assert.deepEqual([...line.injected].sort(), [a, fused[4]].sort());
  assert.deepEqual(line.applyGate.rows.map((r) => r.id).sort(), [a, fused[4]].sort());
  // the turn state and the hub index record what was injected, not what was asked
  assert.deepEqual(createTurnState(w.dataDir).read("sess-gate").injected.sort(), [b, ...line.injected].sort());
});

test("a statement asked about but not injected is not marked told: it may come back next turn", async () => {
  const fused = await fusedOrder();
  const w = await world({ env: { RECALL_K: "1" }, api: { decideApply: byId(Object.fromEntries(fused.map((id, i) => [id, i === 2 ? 0.9 : 0.1]))) } });
  assert.deepEqual((await turn(w, { session_id: "t1" })).line.injected, [fused[2]]);
  assert.deepEqual(createTurnState(w.dataDir).read("t1").injected, [fused[2]]);
});

// ---- cost, cache, deadline, cap ----
test("the question cache serves a repeated turn: no second apply request, cost zero", async () => {
  const w = await world();
  const first = await turn(w, { session_id: "c1" });
  assert.equal(applyQuestions(w).length, 5);
  assert.ok(first.line.applyGate.costUsd > 0 && first.line.applyGate.cachedRequests === 0);
  const second = await turn(w, { session_id: "c2" });
  assert.equal(applyQuestions(w).length, 5, "answered from the cache: nothing new was sent");
  assert.equal(second.line.applyGate.costUsd, 0);
  assert.equal(second.line.applyGate.cacheHits, 5);
  assert.deepEqual(second.line.injected, first.line.injected);
});

test("the gate's cost is part of the turn's cost", async () => {
  const on = await world();
  const off = await world({ env: { RECALL_APPLY_GATE: "0" } });
  const a = (await turn(on)).line;
  const b = (await turn(off)).line;
  assert.ok(a.applyGate.costUsd > 0);
  assert.ok(Math.abs(a.stats.costUsd - (b.stats.costUsd + a.applyGate.costUsd)) < 1e-12);
});

test("if the deadline expires before the gate answers, nothing is injected (not the unreranked survivors), loudly", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const w = await world({
    env: { RECALL_TIMEOUT_MS: "1000" },
    post: (post) => async (url, body, opts) => {
      if (body.questions?.some((q) => isApplyQuestion(q.instructions))) await sleep(2500);
      return post(url, body, opts);
    },
  });
  const t0 = Date.now();
  const { out, line } = await turn(w);
  assert.ok(Date.now() - t0 < 2400, "cut at the deadline, not after the slow answer");
  assert.deepEqual(JSON.parse(out.stdout), { continue: true });
  assert.equal(line.outcome, "silent");
  assert.equal(line.reason, "apply-gate-failed");
  assert.equal(line.level, "error");
  assert.match(line.error, /RecallDeadline.*apply gate exceeded/);
  assert.equal(line.injected, undefined);
  assert.equal(line.context, undefined);
  assert.equal(line.applyGate.survivors, 5);
  assert.equal(createTurnState(w.dataDir).read(SESSION), null, "nothing was recorded as told");
});

test("a failing gate request injects nothing and says so", async () => {
  const w = await world({ post: (post) => async (url, body, opts) => { if (body.questions?.some((q) => isApplyQuestion(q.instructions))) throw new Error("upstream said no"); return post(url, body, opts); } });
  const { out, line } = await turn(w);
  assert.deepEqual(JSON.parse(out.stdout), { continue: true });
  assert.equal(line.reason, "apply-gate-failed");
  assert.match(line.error, /upstream said no/);
});

test("the spend cap guards the gate: a cap that fits the search but not the gate's request injects nothing", async () => {
  const off = await world({ env: { RECALL_APPLY_GATE: "0" } });
  await turn(off);
  const spent = fs.readFileSync(path.join(off.dataDir, "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const embedded = spent.filter((e) => e.endpoint === "/v1/embeddings").reduce((n, e) => n + e.costUsd, 0);
  const searched = spent.filter((e) => e.endpoint === "/v1/decisions").reduce((n, e) => n + e.costUsd, 0);
  const reserveD = costUsd("gpt-6-luna", estimateTokens(decisionCalls(off)[0], 400)); // what the pre-flight check holds for the D-generic request
  // the D-generic request fits (embedding spent + its reservation), the gate's does not (embedding + D spent + a reservation of the same size)
  const cap = embedded + reserveD + searched / 2;
  const w = await world({ env: { RECALL_DAILY_CAP_USD: String(cap) } });
  const { out, line } = await turn(w);
  assert.equal(decisionCalls(w).length, 1, "the search was sent");
  assert.deepEqual(JSON.parse(out.stdout), { continue: true });
  assert.equal(line.outcome, "silent");
  assert.equal(line.reason, "cap-reached");
  assert.equal(applyQuestions(w).length, 0, "the gate's request was never sent");
  assert.equal(createTurnState(w.dataDir).read(SESSION), null);
});

// ---- the switch ----
test("switched off, the hook is main's: no apply question is sent, the same picks and block, the same log fields", async () => {
  const off = await world({ env: { RECALL_APPLY_GATE: "0", RECALL_K: "2" } });
  const { line, out } = await turn(off);
  assert.equal(applyQuestions(off).length, 0);
  assert.ok(!("applyGate" in line) && !("apply" in line), "the log line has no gate fields");
  // main's selection for the same ranking
  const { corpus } = loadIndexedCorpus(off.runtime.store);
  const { attachCards } = await import("../scripts/lib/cards/eligibility.mjs");
  const { loadCards } = await import("../scripts/lib/cards/cards-file.mjs");
  attachCards(corpus, loadCards(cardsPath(off.dataDir)));
  const stats = {};
  const res = await retrieve({ corpus, query: line.situation, mode: "prompt", decisionTs: NOW().toISOString(), pipeline: "default", deps: off.runtime.makeDeps({ stats }), cfg: off.config, stats, currentRepo: line.repo, threadId: SESSION });
  const main = selectInjection({ ranked: res.ranked, corpus, pipeline: off.config.pipeline, cfg: off.config, sessionId: SESSION, currentRepo: line.repo, source: { root: pluginRoot(process.env) } });
  assert.deepEqual(line.injected, main.picked.map((e) => e.id));
  assert.equal(line.injected.length, 2);
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, main.context);
  // the requests: embedding + D-generic only, exactly as the gate-less pipeline sends them
  assert.deepEqual(decisionCalls(off).map((b) => b.questions.length), [5]);
  // on, the same ranking gives the same survivors; the only difference is the gate's request and its fields
  const on = await world({ env: { RECALL_K: "2" } });
  const onLine = (await turn(on)).line;
  assert.deepEqual(onLine.candidates.map((c) => c.id), line.candidates.map((c) => c.id), "the retrieval itself is untouched");
  assert.deepEqual(onLine.injected, line.injected, "a uniform yes keeps the fused order");
  assert.equal(decisionCalls(on).length, decisionCalls(off).length + 1);
});

test("switched off, with a gate-hostile fake (refusals, deadline-length delay) nothing changes: the stage is not even reached", async () => {
  const w = await world({ env: { RECALL_APPLY_GATE: "0" }, api: { decideApply: null }, post: (post) => async (url, body, opts) => { if (body.questions?.some((q) => isApplyQuestion(q.instructions))) throw new Error("never asked"); return post(url, body, opts); } });
  const { line } = await turn(w);
  assert.equal(line.outcome, "injected");
  assert.equal(line.injected.length, 3);
});

// ---- the turn log ----
test("the turn log records each survivor's probability and verdict, the settings with their sources, and stays bounded", async () => {
  const fused = await fusedOrder();
  const table = Object.fromEntries(fused.map((id, i) => [id, [0.9, 0.15, null, 0.4, 0.2][i]]));
  const w = await world({ api: { decideApply: byId(table) } });
  const { line } = await turn(w);
  const g = line.applyGate;
  assert.deepEqual(g.rows.map((r) => r.id), fused, "the survivors in the fused order");
  assert.deepEqual(g.rows.map((r) => r.p), [0.9, 0.15, null, 0.4, 0.2]);
  assert.deepEqual(g.rows.map((r) => r.pass), [true, false, false, true, true]);
  assert.deepEqual([g.survivors, g.passed, g.selected, g.refused, g.threshold, g.k], [5, 3, 3, 1, 0.2, 3]);
  assert.ok(g.ms >= 0 && g.requests === 1 && g.questions === 5);
  assert.deepEqual(line.apply, { applyGate: { value: true, source: "default" }, applyThreshold: { value: 0.2, source: "default" } });
  assert.ok(JSON.stringify(g).length < 1200, `the record is ${JSON.stringify(g).length} bytes`);
  // a long list is cut at GATE_LOG_MAX rows, the counts stay whole
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: `id-${String(i).padStart(3, "0")}-${"x".repeat(20)}`, p: i / 120, pass: i > 60 }));
  const rec = gateRecord({ rows, picked: rows.slice(0, 3), threshold: 0.2, k: 3, stats: { questions: 120, requests: 1 }, ms: 12.4 });
  assert.equal(rec.rows.length, GATE_LOG_MAX);
  assert.equal(rec.survivors, 120);
  assert.equal(rec.rows[1].p, 0.008, "three decimals");
  assert.ok(JSON.stringify(rec).length < 6000);
});

test("recall logs counts the gate; the monitor joins the rows to the statements", async () => {
  const fused = await fusedOrder();
  const w = await world({ api: { decideApply: byId(Object.fromEntries(fused.map((id, i) => [id, i < 2 ? 0.8 : null]))) } });
  const { line } = await turn(w);
  const day = line.ts.slice(0, 10);
  const sum = summarizeLogs(w.dataDir, [day]);
  assert.deepEqual(sum.applyGate, { turns: 1, survivors: 5, passed: 2, injected: 2, noAnswer: 3 });
  assert.match(formatSummary(sum), /apply gate[\s\S]*5  asked[\s\S]*2  at the bar[\s\S]*2  injected[\s\S]*3  no answer/);
  assert.ok(!formatSummary({ ...sum, applyGate: { turns: 0, survivors: 0, passed: 0, injected: 0, noAnswer: 0 } }).includes("apply gate"));
  const byIdMap = new Map(line.candidates.map((c) => [c.id, c]));
  const rows = gateRows(line, (id) => byIdMap.get(id));
  assert.deepEqual(rows.map((r) => r.verdict), ["injected", "injected", "no answer", "no answer", "no answer"]);
  assert.ok(rows.every((r) => r.row?.text));
  assert.match(gateSummary(line), /^5 surviving statements asked; 2 at 0\.2 or more, 3 without an answer; 2 injected\.$/);
  assert.deepEqual(gateRows({}, () => null), []);
  assert.equal(gateSummary({}), null);
});

// ---- configuration ----
test("config: the gate is on at 0.2 by default; env beats file beats default; unknown keys and bad values are still loud", () => {
  const c = loadConfig({});
  assert.deepEqual([c.applyGate, c.applyThreshold, c.sources.applyGate, c.sources.applyThreshold], [true, 0.2, "default", "default"]);
  const dataDir = tmpDir("recall-gate-cfg");
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ applyGate: false, applyThreshold: 0.35 }));
  const f = loadConfig({ RECALL_DATA: dataDir });
  assert.deepEqual([f.applyGate, f.applyThreshold, f.sources.applyGate], [false, 0.35, "file"]);
  const e = loadConfig({ RECALL_DATA: dataDir, RECALL_APPLY_GATE: "1", RECALL_APPLY_THRESHOLD: "0.5" });
  assert.deepEqual([e.applyGate, e.applyThreshold, e.sources.applyGate, e.sources.applyThreshold], [true, 0.5, "env", "env"]);
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ applyGat: false }));
  assert.throws(() => loadConfig({ RECALL_DATA: dataDir }), (err) => err instanceof ConfigError && /unknown key "applyGat"/.test(err.message));
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ applyThreshold: 1.5 }));
  assert.throws(() => loadConfig({ RECALL_DATA: dataDir }), ConfigError);
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ applyGate: "no" }));
  assert.throws(() => loadConfig({ RECALL_DATA: dataDir }), ConfigError);
  assert.throws(() => loadConfig({ RECALL_APPLY_THRESHOLD: "-0.1" }), ConfigError);
  assert.throws(() => loadConfig({ RECALL_APPLY_GATE: "maybe" }), ConfigError);
  // v1 values switch the gate off with everything else; the gate needs the cards (it shows each statement's gist)
  assert.equal(loadConfig(V1_ENV).applyGate, false);
  assert.equal(needsCards(loadConfig(V1_ENV)), false);
  assert.equal(needsCards(loadConfig({ ...V1_ENV, RECALL_APPLY_GATE: "1" })), true);
});
