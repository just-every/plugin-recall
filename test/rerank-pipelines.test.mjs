import test from "node:test";
import assert from "node:assert/strict";
import { rerankPrompt, validateOrder, candidateLabel } from "../scripts/lib/pipelines/rerank.mjs";
import { listwiseQuestions, listwiseScores, LISTWISE_TEXT } from "../scripts/lib/pipelines/listwise.mjs";
import { retrieve } from "../scripts/lib/retrieve.mjs";
import { loadConfig, V1_ENV } from "../scripts/lib/config.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { loadIndexedCorpus } from "../scripts/lib/index-corpus.mjs";
import { fakeOpenAI, seedIndex, tmpDir } from "./helpers.mjs";

test("x3 CLI prompt preserves full situation, exact label format and 260 character clip", () => {
  const query = `SITUATION: ${"q".repeat(2000)}`;
  const prompt = rerankPrompt(query, [{ text: "a".repeat(300) }, { text: "second statement" }]);
  assert.ok(prompt.includes(query));
  assert.ok(prompt.includes(`[m01] ${"a".repeat(260)} [...]\n[m02] second statement`));
  assert.ok(prompt.endsWith('Return JSON {"order": [...]} listing every candidate id (m01 to m02) exactly once, most important first.'));
});

test("CLI ordering must be a complete permutation: no repaired, invented or duplicate ranks", () => {
  assert.deepEqual(validateOrder(["m03", "m01", "m02"], 3), [2, 0, 1]);
  for (const order of [null, ["m01"], ["m01", "m01", "m03"], ["m00", "m02", "m03"], [1, 2, 3], ["m01", "m02", "m03", "m04"]]) {
    assert.throws(() => validateOrder(order, 3), /invalid CLI rerank ordering/);
  }
});

test("A2 listwise averages reversed slot probabilities and fails on refusals or absent options", async () => {
  const items = [{ id: "a", text: "first" }, { id: "b", text: "second" }];
  const qs = listwiseQuestions(items);
  assert.deepEqual(qs.map((q) => q.instructions), [LISTWISE_TEXT, LISTWISE_TEXT]);
  assert.deepEqual(qs[1].choices, [{ value: "C0", description: "second" }, { value: "C1", description: "first" }]);
  const answer = (p) => ({ type: "choice", probabilities: p.map((probability, i) => ({ value: `C${i}`, probability })) });
  const ctx = { situation: "query", stats: {}, deps: { scoreChoices: async () => ({ answers: [answer([0.8, 0.2]), answer([0.4, 0.6])], costUsd: 0 }) } };
  const ps = await listwiseScores(ctx, items);
  assert.equal(ps.get("a"), 0.7);
  assert.ok(Math.abs(ps.get("b") - 0.3) < 1e-10);
  ctx.deps.scoreChoices = async () => ({ answers: [{ type: "refusal" }, answer([0.1, 0.9])], costUsd: 0 });
  await assert.rejects(() => listwiseScores(ctx, items), /refusal/);
  ctx.deps.scoreChoices = async () => ({ answers: [answer([1]), answer([0.1, 0.9])], costUsd: 0 });
  await assert.rejects(() => listwiseScores(ctx, items), /coverage/);
});

test("P3 and P4 assemble on P1 top20/top24, preserve tails and enforce codex", async () => {
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: tmpDir("rerank-assembly"), RECALL_DAILY_CAP_USD: "5" });
  const api = fakeOpenAI();
  const runtime = createRuntime(config, { post: api.post });
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, text: `owner statement ${i} topic ${i % 4}`, ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), session_id: "old" }));
  await seedIndex(runtime.store, rows);
  const { corpus } = loadIndexedCorpus(runtime.store);
  const args = { corpus, query: "owner topic statement", decisionTs: "2026-03-01T00:00:00Z", mode: "stop", cfg: config };
  const base = (await retrieve({ ...args, pipeline: "default", deps: runtime.makeDeps() })).ranked;
  const deps = runtime.makeDeps();
  deps.rerank = async ({ kind, n, prompt }) => { assert.equal(kind, "codex"); assert.equal(n, 20); assert.ok(prompt.includes(base[0].id) === false); return Array.from({ length: n }, (_, i) => candidateLabel(n - i - 1)); };
  const codex = (await retrieve({ ...args, pipeline: "default+codex", deps })).ranked;
  assert.deepEqual(codex.slice(0, 20).map((r) => r.id), base.slice(0, 20).map((r) => r.id).reverse());
  assert.deepEqual(codex.slice(20).map((r) => r.id), base.slice(20).map((r) => r.id));
  deps.scoreChoices = async ({ questions }) => {
    assert.equal(questions[0].choices.length, 24);
    return { costUsd: 0, answers: questions.map((q, reverse) => ({ type: "choice", probabilities: q.choices.map((c, i) => ({ value: c.value, probability: (reverse ? i === 0 : i === 23) ? 1 : 0 })) })) };
  };
  const list = (await retrieve({ ...args, pipeline: "default+listwise", deps })).ranked;
  assert.equal(list[0].id, base[23].id);
  assert.deepEqual(list.slice(24).map((r) => r.id), base.slice(24).map((r) => r.id));
  assert.ok(list.every((r, i) => i === 0 || r.score <= list[i - 1].score));
});
