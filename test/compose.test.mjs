import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPOSE_SPEC, composeScore, blendCompose } from '../scripts/lib/pipelines/compose-model.mjs';
import { composeCandidates, composePipeline } from '../scripts/lib/pipelines/compose.mjs';
import { durableProbabilities, DURABILITY_TEXT } from '../scripts/lib/pipelines/durable.mjs';
import { fuseHyde, hydeRanking } from '../scripts/lib/pipelines/hyde.mjs';
import { buildDurableIndex, readDurableIndex } from '../scripts/lib/durable-store.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('composition never injects a refused predicate even with the probability gate set to zero', () => {
  const config = { promptThreshold: 0, stopInjectThreshold: 0 };
  for (const mode of ['prompt', 'stop']) {
    assert.equal(composePipeline.gate({ parts: { d: null } }, config, mode), false);
    assert.equal(composePipeline.gate({ parts: { d: 0 } }, config, mode), true);
  }
});

test('frozen compose scorers reproduce original B1 sklearn decision_function including missing values', () => {
  assert.equal(COMPOSE_SPEC.training.cases, 104);
  for (const model of Object.values(COMPOSE_SPEC.pipelines)) {
    assert.ok(!model.features.includes('facet') && !model.features.includes('salience'));
    for (const probe of model.parityProbes) assert.ok(Math.abs(composeScore(probe.raw, model) - probe.score) < 1e-12);
  }
  assert.deepEqual(COMPOSE_SPEC.pipelines['compose-lean'].features.slice(0, 6), ['d', 'node', 'embedding', 'bm25', 'same_thread', 'recency']);
});

test('composition admits every enabled channel and never an ineligible item', () => {
  const indices = [1, 2, 3, 4, 5, 6];
  const pf = { embRank: new Map(indices.map(i => [i, i === 2 ? 1 : 500])), bm25Rank: new Map(indices.map(i => [i, i === 3 ? 1 : 500])) };
  const routes = { nodeRank: new Map([[1, 32], [9, 1]]) };
  const hyde = { rank: new Map([[4, 300], [9, 1]]) };
  const durable = new Map([[5, .3], [6, null], [9, 1]]);
  assert.deepEqual(composeCandidates(indices, pf, routes, hyde, durable), [1, 2, 3, 4, 5]);
  assert.deepEqual(composeCandidates(indices, pf, routes, null, null, true), [1, 2, 3]);
});

test('listwise blend is normalized linear softmax plus choice probability, with strict missing answers', () => {
  const rows = [{ id: 'a', linear: 1000 }, { id: 'b', linear: 999 }];
  const out = blendCompose(rows, new Map([['a', .05], ['b', .95]]), .5);
  assert.equal(out[0].id, 'b');
  assert.ok(Math.abs(out.reduce((sum, row) => sum + row.blend, 0) - 1) < 1e-14);
  assert.throws(() => blendCompose(rows, new Map(), .5), /Missing or invalid/);
});

test('durability indexes unique clipped texts offline, then query reads eligible items without calls', async () => {
  const calls = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'recall-durable-test-'));
  const items = [{ id: 'a', text: 'a'.repeat(1501) }, { id: 'b', text: 'a'.repeat(1500) + 'b' }, { id: 'future', text: 'future' }];
  const deps = {
    scorePredicates: async request => { calls.push(request); return { probabilities: [null], cached: true, costUsd: 0 }; },
    loadDurable: selected => readDurableIndex({ items: selected, dir }),
  };
  try {
  await buildDurableIndex({ items: items.slice(0, 2), deps, dir });
  assert.equal((await buildDurableIndex({ items: items.slice(0, 2), deps, dir })).typed, 0);
  const ctx = { corpus: { items }, eligible: [0, 1], memo: {}, stats: {}, deps };
  const p = await durableProbabilities(ctx);
  assert.equal(await durableProbabilities(ctx), p);
  assert.deepEqual([...p], [[0, null], [1, null]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.length, 1500);
  assert.equal(calls[0].questions[0].instructions, DURABILITY_TEXT);
  assert.throws(() => readDurableIndex({ items, dir }), /run recall index --durable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HyDE RRF uses ten independent top1000 lists and deterministic position ties', () => {
  const ranked = fuseHyde([[2, 1], [1, 2]]);
  assert.deepEqual(ranked.map(r => r.idx), [1, 2]);
  assert.ok(Math.abs(ranked[0].score - (1 / 61 + 1 / 62)) < 1e-14);
  assert.equal(fuseHyde([Array.from({ length: 1001 }, (_, i) => i)]).length, 1000);
});

test('HyDE fails explicitly without generative dependencies', async () => {
  await assert.rejects(hydeRanking({ memo: {}, deps: {} }), /requires generate and embedTexts/);
});
