// Make sure every statement text has an embedding in the store: embed only the hashes the store lacks, 128 texts per request, a few
// requests at a time, one chunk file per wave so an interrupted run keeps what it paid for.
import { embedInput, textHash } from "./text.mjs";
import { toF32 } from "./vec.mjs";

export const EMBED_BATCH = 128;
export const EMBED_CONCURRENCY = 4;

/**
 * @param {string[]} texts
 * @returns {Promise<{embedded: number, requests: number, costUsd: number, inputTokens: number, have: Map<string, Float32Array>}>}
 */
export async function ensureEmbeddings({ texts, store, api, deadlineAt, log = () => {}, have = store.loadEmbeddings() }) {
  const missing = new Map(); // hash -> input text
  for (const t of texts) {
    const h = textHash(t);
    if (!have.has(h) && !missing.has(h)) missing.set(h, embedInput(t));
  }
  const hashes = [...missing.keys()];
  let requests = 0;
  let costUsd = 0;
  let inputTokens = 0;
  const wave = EMBED_BATCH * EMBED_CONCURRENCY;
  for (let w = 0; w < hashes.length; w += wave) {
    const part = hashes.slice(w, w + wave);
    const batches = [];
    for (let i = 0; i < part.length; i += EMBED_BATCH) batches.push(part.slice(i, i + EMBED_BATCH));
    const results = await Promise.all(batches.map((b) => api.embedBatch(b.map((h) => missing.get(h)), { label: "embed-statements", deadlineAt, cacheable: false })));
    const vecs = [];
    results.forEach((r) => {
      requests += r.cached ? 0 : 1;
      costUsd += r.costUsd;
      inputTokens += r.inputTokens;
      for (const v of r.vectors) vecs.push(toF32(v));
    });
    store.appendEmbeddings(part, vecs);
    part.forEach((h, i) => have.set(h, vecs[i]));
    log(`embedded ${Math.min(w + wave, hashes.length)}/${hashes.length}`);
  }
  return { embedded: hashes.length, requests, costUsd, inputTokens, have };
}
