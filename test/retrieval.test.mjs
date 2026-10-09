// Eligibility, the retrieval core and the named pipelines, against the fake OpenAI (no network).
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, V1_ENV } from "../scripts/lib/config.mjs";
import { buildCorpus, eligibleIndices } from "../scripts/lib/corpus.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { GENERIC_TEXT, ITEM_CLIP } from "../scripts/lib/pipelines/questions.mjs";
import { SPEC } from "../scripts/lib/pipelines/spec.mjs";
import { promptSituation, situationOf, stopSituation } from "../scripts/lib/situations.mjs";
import { gated, retrieve } from "../scripts/lib/retrieve.mjs";
import { loadIndexedCorpus } from "../scripts/lib/index-corpus.mjs";
import { tsMicros } from "../scripts/lib/text.mjs";
import { fakeOpenAI, seedIndex, tmpDir } from "./helpers.mjs";

const ROWS = [
  { id: "a1", ts: "2026-09-01T10:00:00Z", text: "Never add fallback paths; fix the code structure properly instead of random limits.", session_id: "s-old", repo: "alpha" },
  { id: "a2", ts: "2026-09-02T10:00:00.500000Z", text: "Use real prices from the source sheet, never invent unit costs.", session_id: "s-old", repo: "alpha" },
  { id: "a3", ts: "2026-09-03T10:00:00.753000Z", text: "Lets run the summarizer on the small model while we compare costs.", session_id: "s-old", repo: "beta" },
  { id: "a4", ts: "2026-09-03T10:00:00Z", text: "Run the harness for a single stage with the final worker code only.", session_id: "s-old", repo: "beta" },
  { id: "a5", ts: "2026-09-10T10:00:00Z", text: "Back and forward buttons must not change focus when viewing earlier edits.", session_id: "s-live", repo: "gamma" },
  { id: "a6", ts: "2026-09-11T10:00:00Z", text: "A completely unrelated note about lunch and the weather outside today.", session_id: "s-old", repo: null },
];

async function setup(opts = {}) {
  const dataDir = tmpDir("recall-ret");
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_DAILY_CAP_USD: "5", ...(opts.env ?? {}) });
  const api = fakeOpenAI(opts.api);
  const runtime = createRuntime(config, { post: api.post });
  await seedIndex(runtime.store, opts.rows ?? ROWS);
  const { corpus } = loadIndexedCorpus(runtime.store);
  const deps = (stats = {}) => runtime.makeDeps({ stats });
  return { config, api, runtime, corpus, deps };
}

test("eligibility: strictly before the decision time, compared as parsed microseconds, never as strings", async () => {
  const { corpus } = await setup();
  const ids = (decision, extra = {}) => eligibleIndices(corpus, { decisionMicros: tsMicros(decision), ...extra }).map((i) => corpus.items[i].id);
  assert.deepEqual(ids("2026-09-03T10:00:00.753000Z"), ["a1", "a2", "a4"], "an item AT the decision time is not eligible (strict <)");
  // "…00Z" is 753 ms EARLIER than "…00.753000Z", although it sorts after it as a string
  assert.deepEqual(ids("2026-09-03T10:00:00.754000Z"), ["a1", "a2", "a4", "a3"]);
  assert.deepEqual(ids("2026-09-03T10:00:00Z"), ["a1", "a2"], "a4 is exactly at the decision time: excluded");
  assert.deepEqual(ids("2026-08-01T00:00:00Z"), []);
});

test("eligibility: exclude_ids (already in the agent's context) and the live session are excluded; later items never appear", async () => {
  const { corpus } = await setup();
  const m = tsMicros("2026-12-31T00:00:00Z");
  const ids = (extra) => eligibleIndices(corpus, { decisionMicros: m, ...extra }).map((i) => corpus.items[i].id);
  assert.equal(ids({}).length, 6);
  assert.ok(!ids({ excludeIds: new Set(["a2", "a3"]) }).some((i) => ["a2", "a3"].includes(i)));
  assert.deepEqual(ids({ excludeSession: "s-live" }).includes("a5"), false);
  assert.ok(ids({ excludeSession: "s-live" }).includes("a6"));
});

test("retrieve: nothing at or after the decision time or in exclude_ids ever reaches a pipeline's output, for every pipeline", async () => {
  const { corpus, deps, config } = await setup();
  for (const pipeline of ["embeddings", "default"]) {
    const res = await retrieve({ corpus, query: "should we add a fallback path or a random limit here", decisionTs: "2026-09-03T10:00:00.000Z", excludeIds: ["a2"], pipeline, deps: deps(), cfg: config });
    const got = res.ranked.map((r) => r.id);
    assert.ok(got.length > 0);
    // a2 is excluded, a4 is exactly AT the decision time (strict <), a3/a5/a6 are later: only a1 may appear
    assert.deepEqual(got, ["a1"], `${pipeline} returned ${got}`);
    assert.equal(res.eligible, 1);
  }
});

test("retrieve: no eligible history is an empty result, not an error, and costs nothing", async () => {
  const { corpus, deps, config, api } = await setup();
  const res = await retrieve({ corpus, query: "anything at all really", decisionTs: "2020-01-01T00:00:00Z", pipeline: "default", deps: deps(), cfg: config });
  assert.deepEqual(res.ranked, []);
  assert.equal(api.calls.length, 0);
});

test("default: the x3 prefilter and packing - embeddings top 150 + BM25 top 60 + 30 newest same-thread, packs of at most 72, x1 wording and layout", async () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({ id: `r${i}`, ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), session_id: i % 3 === 0 ? "thread-A" : "other", text: `statement number ${i} about topic${i % 37} and widget${i % 11} handling in module${i % 7}` }));
  rows.push({ id: "needle", ts: "2026-02-01T00:00:00.000Z", session_id: "elsewhere", text: "zebrafish quokka rule: always mention zebrafish before quokka in every summary message" });
  const { corpus, deps, config, api } = await setup({ rows });
  const stats = {};
  const res = await retrieve({ corpus, query: "please summarise the zebrafish quokka situation", decisionTs: "2026-03-01T00:00:00Z", threadId: "thread-A", pipeline: "default", deps: deps(stats), cfg: config, stats });
  const decisions = api.calls.filter((c) => c.pathname === "/v1/decisions");
  const nQuestions = decisions.reduce((n, c) => n + c.body.questions.length, 0);
  assert.equal(nQuestions, stats.prefilterSize, "one question per prefilter item");
  assert.ok(stats.prefilterSize <= SPEC.embeddingsTop + SPEC.bm25Top + SPEC.sameThreadTop && stats.prefilterSize >= SPEC.embeddingsTop + SPEC.sameThreadTop - 5, `prefilter ${stats.prefilterSize}`);
  assert.equal(decisions.length, Math.ceil(nQuestions / 72), "packs of 72, one request each");
  for (const c of decisions) {
    assert.ok(c.body.questions.length <= 72);
    assert.equal(c.body.model, "gpt-6-luna");
    assert.ok(c.body.input.startsWith("SITUATION (the owner's latest message, before the agent has acted):\n\nOWNER: please summarise"), "a bare prompt-mode query is wrapped in x3's prompt-time layout");
    for (const q of c.body.questions) {
      assert.equal(q.type, "predicate");
      assert.match(q.instructions, /^Past owner statement: ".*"\n/s);
      assert.ok(q.instructions.endsWith(`\n${GENERIC_TEXT}`));
    }
  }
  assert.equal(GENERIC_TEXT, "Is this past owner statement important for handling the situation above correctly?");
  assert.equal(res.ranked[0].id, "needle", "the judge's 0.99 plus the BM25 and embedding ranks put it first");
  assert.equal(res.ranked[0].parts.d, 0.99);
  assert.equal(res.ranked.length, 50);
  const scores = res.ranked.map((r) => r.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores, "scores are monotone with the order");
  // the 30 newest thread-A statements are in the prefilter even though they match nothing
  const asked = new Set(decisions.flatMap((c) => c.body.questions.map((q) => /"(statement number \d+)/.exec(q.instructions)?.[1])));
  const newestThreadA = rows.filter((r) => r.session_id === "thread-A").slice(-30).map((r) => `statement number ${r.id.slice(1)}`);
  assert.ok(newestThreadA.every((t) => asked.has(t)), "same-thread newest 30 are scored");
  const threadRanks = res.ranked.map((r) => r.parts.threadRank).filter((x) => x != null);
  assert.ok(threadRanks.every((x) => x >= 1));
});

test("default: a statement is clipped to 260 characters with the x1 marker, and a bare message in the situation to 1500", async () => {
  const long = `${"alpha beta gamma ".repeat(60)}END`;
  const { corpus, deps, config, api } = await setup({ rows: [{ id: "L", ts: "2026-01-01T00:00:00Z", text: long }] });
  await retrieve({ corpus, query: `alpha beta ${"x".repeat(2000)}`, decisionTs: "2026-02-01T00:00:00Z", pipeline: "default", deps: deps(), cfg: config });
  const call = api.calls.find((c) => c.pathname === "/v1/decisions").body;
  const quoted = /Past owner statement: "(.*)"\n/s.exec(call.questions[0].instructions)[1];
  assert.ok(quoted.endsWith(" [...]") && quoted.length <= ITEM_CLIP + 6);
  assert.ok(call.input.length < 1500 + 120 && call.input.includes(" [...]"));
  const emb = api.calls.find((c) => c.pathname === "/v1/embeddings").body.input[0];
  assert.equal(emb, call.input, "the query embedding text is the situation (clipped to 6000, which this one is under)");
});

test("situations: x1/x3 layouts - prompt-time owner message, stop-time last two turns plus the agent's message, an eval situation used as is", () => {
  assert.equal(promptSituation("do the thing"), "SITUATION (the owner's latest message, before the agent has acted):\n\nOWNER: do the thing");
  const stop = stopSituation([{ role: "user", text: "u0" }, { role: "assistant", text: "a1" }, { role: "user", text: "u2" }], "final words");
  assert.equal(stop, "SITUATION (conversation so far, newest last):\n\nASSISTANT: a1\n\nOWNER: u2\n\nASSISTANT (latest message): final words");
  assert.equal(stopSituation([], "x"), "SITUATION (conversation so far, newest last):\n\nASSISTANT (latest message): x");
  assert.ok(stopSituation([{ role: "user", text: "q".repeat(900) }], "m".repeat(2000)).includes(`${"q".repeat(500)} [...]`));
  const eval1 = "SITUATION (conversation so far, newest last):\n\nASSISTANT (latest message): x";
  assert.equal(situationOf(eval1, "stop"), eval1, "an eval query that already is a situation is used as is");
  assert.equal(situationOf("hello there friend", "stop"), stopSituation([], "hello there friend"));
  assert.equal(situationOf("hello there friend", "prompt"), promptSituation("hello there friend"));
});

test("default: reciprocal rank fusion k=60 of the embedding rank, the BM25 rank and the D-generic rank (D weighted 2), ties by embedding rank", async () => {
  // The judge likes only "b"; embeddings like "a" best. b's D rank 1 (weight 2) beats a's better embedding/BM25 rank.
  const rows = [
    { id: "a", ts: "2026-01-01T00:00:00Z", text: "zebrafish quokka zebrafish quokka rule" },
    { id: "b", ts: "2026-01-02T00:00:00Z", text: "quokka handling guidance for summaries and other things entirely" },
    { id: "c", ts: "2026-01-03T00:00:00Z", text: "unrelated lunch weather statement" },
  ];
  const { corpus, deps, config } = await setup({ rows, api: { decide: ({ instructions }) => (instructions.includes("guidance for summaries") ? 0.97 : 0.05) } });
  const res = await retrieve({ corpus, query: "zebrafish quokka", mode: "stop", decisionTs: "2026-02-01T00:00:00Z", pipeline: "default", deps: deps(), cfg: config });
  const byId = Object.fromEntries(res.ranked.map((r) => [r.id, r]));
  const fused = (r, k) => 1 / (k + r.parts.embRank) + 1 / (k + r.parts.bm25Rank) + 2 / (k + r.parts.dRank);
  for (const id of ["a", "b", "c"]) assert.ok(Math.abs(byId[id].score - fused(byId[id], 60)) < 1e-12, `${id}: k = 60 at stop time`);
  // prompt time fuses with k = 10, the constant x3's own prompt-time cross-validation refit (SPEC.rrfKPrompt)
  const prompt = await retrieve({ corpus, query: "zebrafish quokka", mode: "prompt", decisionTs: "2026-02-01T00:00:00Z", pipeline: "default", deps: deps(), cfg: config });
  for (const r of prompt.ranked) assert.ok(Math.abs(r.score - fused(r, 10)) < 1e-12, `${r.id}: k = 10 at prompt time`);
  assert.equal(byId.b.parts.dRank, 1, "the only statement the judge likes is D rank 1");
  assert.equal(byId.b.parts.d, 0.97);
  assert.deepEqual(res.ranked.map((r) => r.id).slice(0, 2).sort(), ["a", "b"]);
  // injection gate: D-generic's probability decides whether to speak; 0.95 (the Stop hook and its own 0.9 stop-time tau are gone)
  assert.deepEqual(gated("default", res.ranked, config, 5).map((p) => p.id), ["b"]);
  assert.equal(config.promptThreshold, 0.95);
  const edge = res.ranked.map((r) => ({ ...r, parts: { ...r.parts, d: r.id === "b" ? 0.92 : 0.1 } }));
  assert.deepEqual(gated("default", edge, config, 5), [], "0.92 is below the prompt-time tau 0.95");
});

test("default: a refused question is unscored, ranked after every scored statement in the D list (embedding order), and counted", async () => {
  const rows = [
    { id: "x", ts: "2026-01-01T00:00:00Z", text: "alpha bravo charlie delta echo" },
    { id: "y", ts: "2026-01-02T00:00:00Z", text: "alpha bravo foxtrot golf hotel" },
    { id: "z", ts: "2026-01-03T00:00:00Z", text: "alpha bravo india juliet kilo" },
  ];
  const { corpus, deps, config } = await setup({ rows, api: { decide: ({ instructions }) => (instructions.includes("foxtrot") ? null : 0.5) } });
  const stats = {};
  const res = await retrieve({ corpus, query: "alpha bravo", decisionTs: "2026-02-01T00:00:00Z", pipeline: "default", deps: deps(stats), cfg: config, stats });
  const y = res.ranked.find((r) => r.id === "y");
  assert.equal(y.parts.d, undefined);
  assert.equal(y.parts.dRank, 3, "refused: after the two scored statements");
  assert.equal(stats.refused, 1);
  assert.deepEqual(gated("default", res.ranked, config, 5), [], "0.5 is below the gate and a refused statement is never injected");
});

test("embeddings: cosine order, and the gate is the cosine threshold", async () => {
  const { corpus, deps, config } = await setup();
  const res = await retrieve({ corpus, query: "never invent unit costs, use real prices from the source", decisionTs: "2026-12-01T00:00:00Z", pipeline: "embeddings", deps: deps(), cfg: config });
  assert.equal(res.ranked[0].id, "a2");
  assert.ok(res.ranked[0].score > res.ranked[1].score);
  assert.ok(gated("embeddings", res.ranked, config, 5).length >= 1);
  assert.equal(gated("embeddings", res.ranked, { ...config, embThreshold: 0.99 }, 5).length, 0);
});

test("an unknown pipeline name is a loud error", async () => {
  const { corpus, deps, config } = await setup();
  await assert.rejects(() => retrieve({ corpus, query: "something to ask", decisionTs: "2026-12-01T00:00:00Z", pipeline: "nope", deps: deps(), cfg: config }), /unknown pipeline "nope".*embeddings/);
});

test("buildCorpus: a statement with no embedding is reported, never silently searched or dropped; duplicate ids throw", () => {
  const stmts = [{ id: "p", text: "has a vector for sure", ts: "2026-01-01T00:00:00Z", session_id: "s", host: "claude", hash: "H1" }, { id: "q", text: "has none yet at all", ts: "2026-01-02T00:00:00Z", session_id: "s", host: "claude", hash: "H2" }];
  const vec = new Float32Array(1536);
  const c = buildCorpus({ statements: stmts, embeddings: new Map([["H1", vec]]) });
  assert.deepEqual(c.items.map((i) => i.id), ["p"]);
  assert.deepEqual(c.withoutEmbedding.map((i) => i.id), ["q"]);
  assert.throws(() => buildCorpus({ statements: [stmts[0], stmts[0]], embeddings: new Map([["H1", vec]]) }), /duplicate corpus id/);
});
