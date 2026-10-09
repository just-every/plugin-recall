// Sequences below splice synthetic lines (in the real host record formats, see fixtures/README.md) to exercise 0/1/2 boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { compactionMarker } from '../scripts/lib/transcripts/compaction.mjs';
import { transcriptVisibility } from '../scripts/lib/transcripts/visibility.mjs';
import { visibleStatementIds, liveExclusions } from '../scripts/lib/live-exclusions.mjs';
import { eligibleIndices } from '../scripts/lib/corpus.mjs';
import { claudeTurn } from '../scripts/lib/transcripts/claude.mjs';
import { claudeConversationTurn } from '../scripts/lib/transcripts/tail.mjs';
import { formatInjection } from '../scripts/lib/context.mjs';
import { tsMicros } from '../scripts/lib/text.mjs';
import { FIXTURES, readFixture, tmpDir } from './helpers.mjs';

const config = { minChars: 20 };
const fixture = (name) => readFixture('compaction', `${name}.jsonl`);
const owners = [1, 2, 3].map((n) => fixture(`owner-${n}`));
const boundary = () => fixture('claude-compact_boundary');
const decisionTs = '2099-01-01T00:00:00Z';
async function scan(lines, { host = 'claude', compressed = false, decision = decisionTs } = {}) {
  const file = path.join(tmpDir(), compressed ? 'rollout.jsonl.zst' : 'transcript.jsonl');
  const text = lines.join('');
  fs.writeFileSync(file, compressed ? zlib.zstdCompressSync(Buffer.from(text)) : text);
  return { file, visibility: await transcriptVisibility({ file, host, sessionId: 'live', config, decisionTs: decision }) };
}
const corpusOf = (v) => ({ items: v.turns.map(({ statement }) => ({ ...statement, micros: tsMicros(statement.ts) })) });
const eligible = (corpus, excludeIds, decision = decisionTs) => eligibleIndices(corpus, { decisionMicros: tsMicros(decision), excludeIds }).map((i) => corpus.items[i].id);

for (const [host, kind] of [['claude', 'compact_boundary'], ['claude', 'isCompactSummary'], ['codex', 'compacted']]) {
  test(`${host} ${kind} record is detected structurally`, () => {
    const r = JSON.parse(fixture(`${host}-${kind}`));
    assert.equal(compactionMarker(r, host), kind);
    assert.equal(compactionMarker({ type: 'assistant', message: { content: JSON.stringify(r) } }, host), null);
  });
}

test('Every Code rollout fixture has no compaction boundary', async () => {
  const file = path.join(FIXTURES, 'code/sessions/2026/05/29/rollout-2026-05-29T13-57-42-0190b000-bbbb-7000-8000-00000000e001.jsonl');
  const v = await transcriptVisibility({ file, host: 'code', sessionId: 'live', config });
  assert.equal(v.boundary, null);
  assert.equal(visibleStatementIds({ corpus: corpusOf(v), sessionId: 'live', visibility: v }).size, v.turns.length);
});

test('Claude compaction summary is neither an owner statement nor a recent conversation turn', () => {
  let reason;
  assert.equal(claudeTurn(Buffer.from(fixture('claude-isCompactSummary')), { drop(r) { reason = r; } }), null);
  assert.equal(reason, 'compact-summary');
  assert.equal(claudeConversationTurn(JSON.parse(fixture('claude-isCompactSummary'))), null);
});

for (const host of ['claude', 'codex']) for (const n of [0, 1, 2]) {
  test(`${host}: ${n} boundaries: visible set and shared eligibility use the last boundary in file order`, async () => {
    const turns = host === 'claude' ? owners : [1, 2, 3].map((i) => fixture(`codex-owner-${i}`));
    const marker = host === 'claude' ? boundary() : fixture('codex-compacted');
    const lines = [turns[0], ...(n ? [marker] : []), turns[1], ...(n === 2 ? [marker] : []), turns[2]];
    const { visibility } = await scan(lines, { host });
    const corpus = corpusOf(visibility);
    assert.equal(corpus.items.length, 3);
    const other = { ...corpus.items[0], id: 'other', session_id: 'other', repo: 'repo' };
    const future = { ...other, id: 'future', micros: tsMicros(decisionTs) };
    corpus.items.push(other, future);
    const visible = visibleStatementIds({ corpus, sessionId: 'live', visibility });
    assert.deepEqual([...visible], corpus.items.slice(n, 3).map((it) => it.id));
    assert.deepEqual(eligible(corpus, visible), [...corpus.items.slice(0, n).map((it) => it.id), 'other']);
    // Eval contract still permits same-thread statements whenever exclude_ids doesn't contain them.
    assert.deepEqual(eligible(corpus, new Set([corpus.items[1].id])), [corpus.items[0].id, corpus.items[2].id, 'other']);
  });
}

test('post-boundary replay of an old statement stays visible, regardless of its timestamp', async () => {
  const { visibility } = await scan([owners[0], boundary(), owners[0], owners[1]]);
  const corpus = corpusOf(visibility);
  const visible = visibleStatementIds({ corpus, sessionId: 'live', visibility });
  assert.equal(eligible(corpus, visible).length, 0);
});

test('summary alone proves a boundary, future boundaries do not affect an earlier decision', async () => {
  const summary = fixture('claude-isCompactSummary');
  const { visibility } = await scan([owners[0], summary, owners[1]]);
  assert.equal(visibility.boundary.kind, 'isCompactSummary');
  assert.deepEqual(eligible(corpusOf(visibility), visibleStatementIds({ corpus: corpusOf(visibility), sessionId: 'live', visibility })), [visibility.turns[0].statement.id]);
  const old = await scan([owners[0], boundary()], { decision: '2000-01-01T00:00:00Z' });
  assert.equal(old.visibility.boundary, null);
});

test('current prompt and missing transcript are excluded', async () => {
  const { file, visibility } = await scan([owners[0], boundary(), owners[1]]);
  const corpus = corpusOf(visibility);
  corpus.items.push({ ...corpus.items[0], id: 'not-in-transcript' });
  const input = { session_id: 'live', host: 'claude', transcript_path: file };
  const visible = await liveExclusions({ corpus, input, config, decisionTs, currentPrompt: corpus.items[0].text });
  assert.equal(eligible(corpus, visible).length, 0);
  input.transcript_path = path.join(tmpDir(), 'not-created-yet.jsonl');
  assert.equal(eligible(corpus, await liveExclusions({ corpus, input, config, decisionTs })).length, 0);
});

for (const compressed of [false, true]) {
  test(`Codex ${compressed ? '.jsonl.zst' : '.jsonl'}: full scan finds the recorded compacted boundary`, async () => {
    const { visibility } = await scan([fixture('codex-owner-1'), fixture('codex-compacted'), fixture('codex-owner-2')], { host: 'codex', compressed });
    assert.equal(visibility.markers.length, 1);
    assert.equal(visibility.boundary.kind, 'compacted');
    const corpus = corpusOf(visibility);
    assert.deepEqual(eligible(corpus, visibleStatementIds({ corpus, sessionId: 'live', visibility })), [visibility.turns[0].statement.id]);
  });
}

test('injection labels live-session history; other sessions keep date and repo', async () => {
  const { visibility } = await scan(owners);
  const it = visibility.turns[0].statement;
  const other = { ...it, session_id: 'other', repo: 'example' };
  for (const text of [formatInjection([it, other], 'live')]) {
    assert.match(text, /\(earlier in this session, before context compaction\)/);
    assert.ok(text.includes(`${other.ts.slice(0, 10)} (repo: example)`));
  }
});

test('a boundary outside the old 4 MiB tail window is still detected; a partial last line is ignored', async () => {
  const tail = owners[1].repeat(Math.ceil(4 * 1024 * 1024 / Buffer.byteLength(owners[1])) + 1);
  const { visibility } = await scan([owners[0], boundary(), tail, owners[2].slice(0, 80)]);
  const corpus = corpusOf(visibility);
  const visible = visibleStatementIds({ corpus, sessionId: 'live', visibility });
  assert.deepEqual([...new Set(eligible(corpus, visible))], [visibility.turns[0].statement.id]);
});


test('indexed history removed from the transcript is located by the boundary timestamp', async () => {
  const { visibility } = await scan([boundary()]);
  const corpus = { items: [
    { id: 'old', text: 'An indexed statement from before compaction.', ts: '2000-01-01T00:00:00Z', micros: tsMicros('2000-01-01T00:00:00Z'), session_id: 'live' },
    { id: 'new', text: 'An indexed statement from after compaction.', ts: '2098-01-01T00:00:00Z', micros: tsMicros('2098-01-01T00:00:00Z'), session_id: 'live' },
  ] };
  assert.deepEqual(eligible(corpus, visibleStatementIds({ corpus, sessionId: 'live', visibility })), ['old']);
});

test('Every Code uses the shared Compacted rollout schema (tested with the Codex line; no Every Code boundary is claimed)', () => {
  assert.equal(compactionMarker(JSON.parse(fixture('codex-compacted')), 'code'), 'compacted');
});

test('an existing transcript with a corrupt complete boundary record fails loudly', async () => {
  const file = path.join(tmpDir(), 'corrupt.jsonl');
  fs.writeFileSync(file, fixture('codex-compacted').trimEnd().slice(0, -1) + '\n');
  await assert.rejects(liveExclusions({ corpus: { items: [] }, input: { host: 'codex', session_id: 'live', transcript_path: file }, config, decisionTs }), SyntaxError);
});
