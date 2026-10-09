import test from "node:test";
import assert from "node:assert/strict";
import { makeSessionNodes, SESSION_PREDICATE, SESSION_SPEC } from "../scripts/lib/pipelines/sessions-nodes.mjs";
import { sessionRoutes } from "../scripts/lib/pipelines/sessions-routing.mjs";
import { rankSessionItems, sessionsPipeline } from "../scripts/lib/pipelines/sessions.mjs";
import { genericQuestion } from "../scripts/lib/pipelines/questions.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { loadConfig, V1_ENV } from "../scripts/lib/config.mjs";
import { fakeOpenAI, tmpDir } from "./helpers.mjs";

function context(items, decide) {
  const emb = items.map((_, idx) => ({ idx, score: 1 / (idx + 1) }));
  const calls = [];
  return {
    corpus: { items }, eligible: items.map((_, i) => i), situation: "SITUATION test", stats: {},
    memo: { prefilter: Promise.resolve({ emb, embRank: new Map(emb.map((r, k) => [r.idx, k + 1])), cos: new Map(emb.map((r) => [r.idx, r.score])) }) },
    deps: { scorePredicates: async (request) => {
      calls.push(request);
      return { probabilities: request.questions.map(decide), costUsd: 0, cached: false };
    } }, calls,
  };
}

test("sessions: exact A1 K24/L2400 partition and wording after eligibility, including invisible members", () => {
  const items = Array.from({ length: 28 }, (_, i) => ({ id: `i${i}`, session_id: i === 2 ? "other" : "thread", text: `statement${i} ${"x".repeat(300)}` }));
  const eligible = items.map((_, i) => i).filter((i) => i !== 1);
  const embRank = new Map(eligible.map((idx, k) => [idx, k + 1]));
  const nodes = makeSessionNodes({ items }, eligible, embRank);
  assert.deepEqual(SESSION_SPEC, { chunkSize: 24, nodeClip: 2400, topNodes: 32, packSize: 200 });
  assert.deepEqual(nodes.map((n) => n.id), ["thread:0", "thread:24", "other:0"]);
  assert.deepEqual(nodes.map((n) => n.indices.length), [24, 2, 1]);
  assert.deepEqual(nodes.flatMap((n) => n.indices).sort((a, b) => a - b), eligible);
  const first = nodes[0];
  const lines = first.indices.map((idx) => `${items[idx].text.slice(0, 260)} [...]`);
  const expectedText = `${lines.join("\n").slice(0, 2400).trimEnd()} [...]`;
  assert.equal(first.text, expectedText);
  assert.deepEqual(first.visible, first.indices.slice(0, 9));
  assert.ok(first.indices.includes(25) && !first.visible.includes(25));
  assert.equal(first.instructions, `Past owner statements from one earlier conversation:\n${expectedText}\nDoes this set of past owner statements include one that is important for handling the situation above correctly?`);
  assert.equal(first.embRank, 1);
});

test("sessions: all roots route, top32 numeric roots expand, leaf refusals and unexpanded items follow numeric leaves", async () => {
  const items = Array.from({ length: 40 }, (_, idx) => ({ id: `i${idx}`, session_id: `s${idx}`, text: `text${idx}` }));
  const ctx = context(items, (q) => {
    if (q.instructions.endsWith(SESSION_PREDICATE)) return q.name === "s0:0" ? null : q.name === "s39:0" ? .9 : .5;
    return q.name === "i1" ? null : q.name === "i39" ? 1 : .4;
  });
  const routing = await sessionRoutes(ctx);
  assert.equal(routing.nodes.length, 40);
  assert.equal(routing.selectedNodes.length, 32);
  assert.deepEqual(routing.candidates, [39, ...Array.from({ length: 31 }, (_, i) => i + 1)]);
  assert.equal(routing.nodeRank.has(0), false);
  assert.equal(routing.nodeProbability.get(0), null);
  assert.equal(routing.nodeRank.get(39), 1);
  const before = ctx.calls.length;
  assert.equal(await sessionRoutes(ctx), routing, "reuse routing within a composed query");
  assert.equal(ctx.calls.length, before);
  const { ranked } = await sessionsPipeline.run(ctx);
  assert.equal(ranked.length, 40);
  assert.equal(ranked[0].id, "i39");
  const numeric = ranked.filter((r) => r.score >= 0);
  assert.equal(numeric.length, 31);
  for (const row of numeric) {
    const expected = .75 * (row.parts.d + row.parts.node) / 2 + .25 / Math.log2(row.parts.embRank + 1);
    assert.equal(row.score, expected);
  }
  assert.deepEqual(ranked.slice(31).map((r) => r.id), ["i0", "i1", "i32", "i33", "i34", "i35", "i36", "i37", "i38"]);
  assert.equal(ctx.stats.sessionNodeRefusals, 1);
  assert.equal(ctx.stats.sessionItemRefusals, 1);
  assert.equal(ctx.stats.refused, 2);
  const leaves = ctx.calls.flatMap((r) => r.questions).filter((q) => !q.instructions.endsWith(SESSION_PREDICATE));
  assert.equal(leaves.length, 32);
  for (const question of leaves) assert.deepEqual(question, genericQuestion(items.find((it) => it.id === question.name)));
  assert.equal(sessionsPipeline.gate(ranked.find((r) => r.id === "i1"), { promptThreshold: .95 }), false);
  assert.equal(sessionsPipeline.gate(ranked.find((r) => r.id === "i1"), { promptThreshold: 0 }), false);
  assert.equal(sessionsPipeline.gate(ranked[0], { promptThreshold: .95 }), true);
});

test("sessions: numeric zero remains scored, final score ties use embedding rank, and missing leaf scores throw", () => {
  const ctx = context([{ id: "first" }, { id: "rest" }, { id: "third" }], () => 0);
  const routing = {
    candidates: [2, 0], nodeProbability: new Map([[0, 0], [2, 0]]), nodeRank: new Map([[0, 2], [2, 1]]),
    emb: [{ idx: 0, score: 1 }, { idx: 1, score: .5 }, { idx: 2, score: .1 }],
    embRank: new Map([[0, 1], [1, 2], [2, 3]]), cos: new Map([[0, 1], [1, .5], [2, .1]]),
  };
  const probabilities = new Map([["first", 0], ["third", 1 / 3]]);
  const ranked = rankSessionItems(ctx, routing, probabilities);
  assert.equal(ranked[0].score, .25);
  assert.equal(ranked[1].score, .25);
  assert.deepEqual(ranked.map((r) => r.id), ["first", "third", "rest"]);
  assert.equal(ranked[2].score, -1.5);
  assert.throws(() => rankSessionItems(ctx, routing, new Map()), /Missing session item score/);
});

test("sessions: A1 requests contain at most 200 predicates and a refused root never expands", async () => {
  const items = Array.from({ length: 225 }, (_, idx) => ({ id: `i${idx}`, session_id: `s${idx}`, text: `text${idx}` }));
  const ctx = context(items, () => null);
  const api = fakeOpenAI({ decide: () => null });
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: tmpDir("recall-sessions"), RECALL_DAILY_CAP_USD: "5" });
  const runtime = createRuntime(config, { post: api.post });
  ctx.deps = runtime.makeDeps({ stats: ctx.stats });
  const { ranked } = await sessionsPipeline.run(ctx);
  assert.deepEqual(api.calls.map((r) => r.body.questions.length), [200, 25]);
  assert.equal(ctx.stats.sessionCandidates, 0);
  assert.equal(ranked.length, 50);
  assert.ok(ranked.every((r) => r.score < 0));
  assert.deepEqual(ranked.map((r) => r.id), items.slice(0, 50).map((it) => it.id));
});
