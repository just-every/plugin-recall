// The constants of the tuned winner "x3-rrf-pf-s" (docs/x3-pipeline.json).
// test/spec.test.mjs checks every value here against that file, so the pipeline cannot drift from the measured one unnoticed.
export const SPEC = Object.freeze({
  // query: the embedding text is the situation clipped to this many characters; the BM25 query is tokenize(situation), unclipped
  embeddingTextClip: 6000,
  // prefilter: union of embeddings top, BM25 top and the newest same-thread statements (about 200 items)
  embeddingsTop: 150,
  bm25Top: 60,
  sameThreadTop: 30,
  bm25DocClip: 4000,
  // D-generic: one predicate per prefilter item, packs of at most packSize questions sent concurrently
  itemClip: 260,
  packSize: 72,
  maxQuestionsPerRequest: 200,
  // reciprocal rank fusion: w_e/(k+E) + w_b/(k+B) + w_dg/(k+Dg), ranks 1-based; the same-thread list is not fused
  rrfK: 60,
  // Prompt time only: the k that the prototype's own prompt-time cross-validation refit (k 10, D weight 2).
  // pipeline.json says "same constants" for the prompt-time note, but the 0.294 it reports (25/85) was measured with this k; k 60 gives 21/85.
  rrfKPrompt: 10,
  wEmbeddings: 1,
  wBm25: 1,
  wDGeneric: 2,
  // thresholds
  injectPromptTau: 0.95, // UserPromptSubmit: prompt_time_injection.tau_dgeneric
});
