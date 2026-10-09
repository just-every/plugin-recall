import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createQuestionCache, predicateKey, questionKey } from "../scripts/lib/question-cache.mjs";
import { createApi } from "../scripts/lib/api.mjs";
import { createLedger } from "../scripts/lib/ledger.mjs";
import { createResponseCache } from "../scripts/lib/response-cache.mjs";
import { fakeOpenAI, tmpDir } from "./helpers.mjs";

test("question identity is x1 exact bytes and x5 ordered options, ignoring names", () => {
  const input = "situation\n";
  const instructions = "wording?";
  assert.equal(predicateKey(input, instructions), createHash("sha256").update(input).update("\0").update(instructions).digest("hex").slice(0, 32));
  const q = { type: "choice", name: "old", instructions, choices: [{ value: "A", description: "one" }, { value: "B", description: "two" }] };
  const { name, ...body } = q;
  assert.equal(questionKey(input, q), createHash("sha256").update(JSON.stringify({ input, ...body })).digest("hex"));
  assert.equal(questionKey(input, q), questionKey(input, { ...q, name: "new" }));
  assert.notEqual(questionKey(input, q), questionKey(input, { ...q, choices: [...q.choices].reverse() }));
  assert.notEqual(predicateKey(input, instructions), predicateKey(input.trim(), instructions));
});

test("cache hits and clipped aliases are removed before packs; refusals remain cached across restarts", async () => {
  const dir = tmpDir();
  const input = "the situation";
  let questionCache = createQuestionCache({ dir });
  for (let i = 0; i < 190; i++) questionCache.put(input, { type: "predicate", instructions: `q${i}` }, i === 0 ? { type: "refusal", name: "old" } : { type: "predicate", probability: 0.8 });
  questionCache.close();
  questionCache = createQuestionCache({ dir });
  const fake = fakeOpenAI({ decide: () => 0.6 });
  const api = createApi({ questionCache, cache: createResponseCache({ dir }), ledger: createLedger({ dir, dailyCapUsd: 1 }), apiKey: () => "test", post: fake.post });
  const questions = Array.from({ length: 210 }, (_, i) => ({ name: `n${i}`, instructions: `q${i}` }));
  questions.push({ name: "alias", instructions: "q209" });
  const r = await api.decidePredicates({ input, questions, packSize: 72 });
  assert.equal(r.cacheHits, 190);
  assert.deepEqual(fake.calls.map((c) => c.body.questions.length), [20]);
  assert.equal(r.probabilities[0], null);
  assert.equal(r.probabilities[210], 0.6);
  const again = await api.decidePredicates({ input, questions: [...questions].reverse(), packSize: 200 });
  assert.equal(again.requests, 0);
  assert.equal(again.costUsd, 0);
  assert.equal(again.cacheHits, 211);
  assert.deepEqual(again.probabilities, [...r.probabilities].reverse());
  questionCache.close();
});

test("disabled caches bypass imported answers and persist no new answers", async () => {
  const dir = tmpDir();
  const populated = createQuestionCache({ dir });
  populated.put("x", { type: "predicate", instructions: "q" }, { type: "predicate", probability: 0.9 });
  const fake = fakeOpenAI({ decide: () => 0.3 });
  const questionCache = createQuestionCache({ dir, enabled: false });
  const api = createApi({ questionCache, cache: createResponseCache({ dir, enabled: false }), ledger: createLedger({ dir, dailyCapUsd: 1 }), apiKey: () => "test", post: fake.post });
  for (let i = 0; i < 2; i++) assert.deepEqual((await api.decidePredicates({ input: "x", questions: [{ name: "a", instructions: "q" }] })).probabilities, [0.3]);
  assert.equal(fake.calls.length, 2);
  assert.equal(populated.get("x", { type: "predicate", instructions: "q" }).answer.probability, 0.9);
  populated.close();
});

test("choice replay restores caller names and conflicts fail loudly", async () => {
  const dir = tmpDir();
  const cache = createQuestionCache({ dir });
  const question = { type: "choice", name: "before", instructions: "Which?", choices: [{ value: "A" }, { value: "B" }] };
  const answer = { type: "choice", name: "before", choice: "B", probabilities: [{ value: "A", probability: 0.2 }, { value: "B", probability: 0.8 }] };
  cache.put("x", question, answer);
  const api = createApi({ questionCache: cache, cache: createResponseCache({ dir }), ledger: createLedger({ dir, dailyCapUsd: 0 }), apiKey: () => { throw new Error("no credentials"); }, post: () => { throw new Error("no network"); } });
  const r = await api.decideChoices({ input: "x", questions: [{ ...question, name: "after" }] });
  assert.deepEqual(r.answers, [{ ...answer, name: "after" }]);
  assert.equal(r.requests, 0);
  assert.throws(() => cache.put("x", question, { ...answer, choice: "A" }), /Conflicting/);
  cache.close();
});
