// Host records are synthetic lines in the real formats (fixtures/README.md); their sequence and the indexed corpus are test constructions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { transcriptVisibility } from '../scripts/lib/transcripts/visibility.mjs';
import { visibleStatementIds } from '../scripts/lib/live-exclusions.mjs';
import { eligibleIndices } from '../scripts/lib/corpus.mjs';
import { tsMicros } from '../scripts/lib/text.mjs';
import { readFixture, tmpDir } from './helpers.mjs';

const config = { minChars: 20 };
const decisionTs = '2099-01-01T00:00:00Z';
const fixture = (name) => readFixture('compaction', `${name}.jsonl`);
const codexOwners = fixture('codex-retained-019e0f0a-owners');
const codexBoundary = fixture('codex-compacted');
const claudeOwner = fixture('claude-preserved-messages-owner');
const claudeLost = fixture('claude-preserved-messages-lost-owner');
const claudeBoundary = fixture('claude-preserved-messages-boundary');
const claudeSummary = fixture('claude-preserved-messages-summary');

async function scan(lines, host = 'codex', compressed = false) {
  const file = path.join(tmpDir(), compressed ? 'history.jsonl.zst' : 'history.jsonl');
  const content = Buffer.from(lines.join(''));
  fs.writeFileSync(file, compressed ? zlib.zstdCompressSync(content) : content);
  return transcriptVisibility({ file, host, sessionId: 'live', config, decisionTs });
}
const corpusOf = (visibility) => ({ items: visibility.turns.map(({ statement }) => ({ ...statement, micros: tsMicros(statement.ts) })) });
const visible = (visibility, corpus = corpusOf(visibility)) => visibleStatementIds({ visibility, corpus, sessionId: 'live' });
const eligible = (visibility, corpus = corpusOf(visibility)) => eligibleIndices(corpus, { decisionMicros: tsMicros(decisionTs), excludeIds: visible(visibility, corpus) }).map((i) => corpus.items[i].id);

for (const compressed of [false, true]) {
  test(`Codex retained replacement owner text remains excluded in ${compressed ? 'zstd' : 'plain'} history`, async () => {
    const lostOwner = fixture('codex-retained-019d9525-owners').split('\n')[0] + '\n';
    const v = await scan([lostOwner, codexOwners, codexBoundary], 'codex', compressed);
    assert.equal(v.turns.length, 5);
    assert.deepEqual(new Set(visible(v)), new Set(v.turns.slice(1).map(({ statement }) => statement.id)));
    assert.deepEqual(eligible(v), [v.turns[0].statement.id]);
  });
}

test('Codex 019d9525 replacement preserves all accepted original owner records', async () => {
  const v = await scan([fixture('codex-retained-019d9525-owners'), fixture('codex-retained-019d9525-compacted')]);
  assert.equal(v.turns.length, 12); // The thirteenth source record is the below-minimum "yes".
  assert.equal(visible(v).size, 12);
  assert.deepEqual(eligible(v), []);
});

test('the latest replacement history supersedes earlier carryover', async () => {
  const firstOwners = fixture('codex-retained-019d9525-owners');
  const firstBoundary = fixture('codex-retained-019d9525-compacted');
  const v = await scan([firstOwners, firstBoundary, codexOwners, codexBoundary]);
  assert.equal(v.markers.length, 2);
  assert.equal(visible(v).size, 4);
  assert.equal(eligible(v).length, 12);
});

test('Codex carryover matches normalized indexed text even after original records disappear', async () => {
  const original = await scan([codexOwners]);
  const corpus = corpusOf(original);
  corpus.items[0].text = `  ${corpus.items[0].text.replaceAll(' ', '\n\t')}  `;
  corpus.items.push({ ...corpus.items[0], id: 'different-session', session_id: 'other' });
  const v = await scan([codexBoundary]);
  assert.equal(v.turns.length, 0);
  assert.deepEqual(new Set(visible(v, corpus)), new Set(corpus.items.slice(0, 4).map((it) => it.id)));
  assert.deepEqual(eligible(v, corpus), ['different-session']);
});

test('Claude retained UUID survives its paired summary, while an omitted owner becomes eligible', async () => {
  const boundary = JSON.parse(claudeBoundary), summary = JSON.parse(claudeSummary);
  assert.equal(summary.parentUuid, boundary.uuid);
  assert.equal(summary.uuid, boundary.compactMetadata.preservedMessages.anchorUuid);
  assert.ok(tsMicros(summary.timestamp) < tsMicros(boundary.timestamp));
  const v = await scan([claudeLost, claudeOwner, claudeBoundary, claudeSummary], 'claude');
  assert.equal(v.turns.length, 2); // Summary prose must not enter the owner's statements.
  assert.deepEqual([...visible(v)], [v.turns[1].statement.id]);
  assert.deepEqual(eligible(v), [v.turns[0].statement.id]);
});

test('a later Claude boundary replaces the preserved UUID set', async () => {
  const v = await scan([
    claudeLost, claudeOwner, claudeBoundary, claudeSummary,
    fixture('claude-preserved-messages-next-boundary'), fixture('claude-preserved-messages-next-summary'),
  ], 'claude');
  assert.equal(v.markers.length, 4);
  assert.equal(visible(v).size, 0);
  assert.equal(eligible(v).length, 2);
});

test('a later standalone Claude summary cannot inherit an earlier boundary carryover set', async () => {
  const v = await scan([
    claudeLost, claudeOwner, claudeBoundary, claudeSummary,
    fixture('claude-preserved-messages-next-summary'),
  ], 'claude');
  assert.equal(v.markers.length, 3);
  assert.equal(visible(v).size, 0);
  assert.equal(eligible(v).length, 2);
});

test('Claude summary anchor identifies its boundary when parentUuid is an interstitial attachment', async () => {
  const pair = fixture('claude-preserved-summary-anchor-pair');
  const rows = pair.trimEnd().split('\n').map((line) => JSON.parse(line));
  const boundary = rows[0], summary = rows.at(-1);
  assert.notEqual(summary.parentUuid, boundary.uuid);
  assert.equal(summary.parentUuid, rows.at(-2).uuid);
  assert.equal(summary.uuid, boundary.compactMetadata.preservedMessages.anchorUuid);
  const v = await scan([pair], 'claude');
  assert.equal(v.markers.length, 2);
  assert.deepEqual(v.carryOver.uuids, boundary.compactMetadata.preservedMessages.allUuids);
  assert.equal(v.turns.length, 0);
});
