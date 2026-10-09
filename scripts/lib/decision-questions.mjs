// Resolve exact question hits before deduplication and packing; a refusal is a cached answer too.
import { questionKey } from "./question-cache.mjs";

export function createQuestionScorer({ questionCache, send, maxQuestions = 200 }) {
  return async function score({ input, questions, packSize = maxQuestions, ...options }) {
    if (!Number.isInteger(packSize) || packSize < 1 || packSize > maxQuestions) throw new Error(`packSize must be in [1, ${maxQuestions}]`);
    const answers = new Map();
    const missing = new Map();
    let cacheHits = 0;
    const keys = questions.map((q) => {
      const key = questionKey(input, q);
      const hit = questionCache?.getKey(key);
      if (hit) { answers.set(key, hit.answer); cacheHits++; }
      else if (!missing.has(key)) missing.set(key, q);
      return key;
    });
    const pending = [...missing.entries()];
    const packs = [];
    for (let i = 0; i < pending.length; i += packSize) packs.push(pending.slice(i, i + packSize));
    const results = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(32, packs.length) }, async () => {
      while (cursor < packs.length) {
        const n = cursor++;
        const pack = packs[n];
        const r = await send({ input, questions: pack.map(([, q]) => q), ...options, label: `${options.label ?? "decisions"}#${n}` });
        results[n] = r;
        pack.forEach(([key], i) => {
          answers.set(key, r.answers[i]);
          questionCache?.putKey(key, r.answers[i], { requestId: r.requestId, source: "runtime" });
        });
      }
    }));
    return {
      answers: questions.map((q, i) => ({ ...answers.get(keys[i]), name: q.name })),
      costUsd: results.reduce((s, r) => s + r.costUsd, 0),
      inputTokens: results.reduce((s, r) => s + r.inputTokens, 0),
      latencyMs: Math.max(0, ...results.map((r) => r.latencyMs)),
      cached: results.every((r) => r.cached), cacheHits,
      requests: results.length, cachedRequests: results.filter((r) => r.cached).length,
      requestId: results.length === 1 ? results[0].requestId : null,
    };
  };
}
