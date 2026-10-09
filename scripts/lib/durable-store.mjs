// The durable feature is an offline index, retained even for cold query-cache runs.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { predicateKey } from './question-cache.mjs';

export const DURABILITY_TEXT = 'Is this a standing rule, preference, or constraint that the owner would want applied to future work, rather than a one-off instruction about the immediate task?';
export const DURABILITY_CLIP = 1500;
export const durableKey = item => predicateKey(item.text.slice(0, DURABILITY_CLIP), DURABILITY_TEXT);

export function createDurableStore({ dir }) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'durable.sqlite'));
  db.exec('PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS durable (key TEXT PRIMARY KEY, p REAL) WITHOUT ROWID');
  const get = db.prepare('SELECT p FROM durable WHERE key = ?');
  const put = db.prepare('INSERT INTO durable(key,p) VALUES (?,?) ON CONFLICT(key) DO NOTHING');
  return {
    get: item => get.get(durableKey(item)),
    put(item, p) {
      if (p !== null && (!Number.isFinite(p) || p < 0 || p > 1)) throw new Error('Invalid durability probability');
      const key = durableKey(item);
      put.run(key, p);
      if (get.get(key).p !== p) throw new Error('Conflicting offline durability answer');
    },
    close: () => db.close(),
  };
}

export function readDurableIndex({ items, dir }) {
  const store = createDurableStore({ dir });
  try {
    const out = new Map();
    for (const item of items) {
      const found = store.get(item);
      if (!found) throw new Error(`Missing offline durability for ${item.id}; run recall index --durable first`);
      out.set(item.id, found.p);
    }
    return out;
  } finally { store.close(); }
}

/** Explicit indexing only; exact-input dedup avoids paying clipped aliases twice. */
export async function buildDurableIndex({ items, dir, deps, stats = {} }) {
  const store = createDurableStore({ dir });
  try {
    const todo = [...new Map(items.filter(item => !store.get(item)).map(item => [durableKey(item), item])).values()];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(32, todo.length) }, async () => {
      while (next < todo.length) {
        const item = todo[next++];
        const r = await deps.scorePredicates({ input: item.text.slice(0, DURABILITY_CLIP), questions: [{ name: 'durable', instructions: DURABILITY_TEXT }], label: 'durable-type' });
        store.put(item, r.probabilities[0]);
        stats.requests = (stats.requests ?? 0) + (r.requests ?? 1);
        stats.cachedRequests = (stats.cachedRequests ?? 0) + (r.cachedRequests ?? Number(Boolean(r.cached)));
        stats.questions = (stats.questions ?? 0) + 1;
        stats.costUsd = (stats.costUsd ?? 0) + r.costUsd;
      }
    }));
    return { items: items.length, typed: todo.length, stats };
  } finally { store.close(); }
}
