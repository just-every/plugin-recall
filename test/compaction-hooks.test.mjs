import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, V1_ENV } from '../scripts/lib/config.mjs';
import { createRuntime } from '../scripts/lib/runtime.mjs';
import { handlePrompt } from '../scripts/lib/prompt-hook.mjs';
import { transcriptVisibility } from '../scripts/lib/transcripts/visibility.mjs';
import { loadIndexedCorpus } from '../scripts/lib/index-corpus.mjs';
import { eligibleIndices } from '../scripts/lib/corpus.mjs';
import { liveExclusions } from '../scripts/lib/live-exclusions.mjs';
import { prefilter } from '../scripts/lib/pipelines/prefilter.mjs';
import { tsMicros } from '../scripts/lib/text.mjs';
import { fakeEmbedding, fakeOpenAI, readFixture, seedIndex, tmpDir } from './helpers.mjs';
const fixture = (name) => readFixture('compaction', `${name}.jsonl`);
const decisionTs = '2099-01-01T00:00:00Z';

for (const host of ['claude', 'codex']) for (const n of [0, 1, 2]) {
  test(`${host} live prompt, ${n} boundaries: only hidden history reaches retrieval and same-thread channel`, async () => {
    const dataDir = tmpDir();
    const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: '0', RECALL_ALLOW_HEADLESS: '1' });
    const post = fakeOpenAI({ decide: () => 1 }).post;
    const runtime = createRuntime(config, { post });
    const file = path.join(dataDir, 'transcript.jsonl');
    const owners = [1, 2, 3].map((i) => fixture(`${host === 'codex' ? 'codex-' : ''}owner-${i}`));
    const marker = fixture(host === 'claude' ? 'claude-compact_boundary' : 'codex-compacted');
    fs.writeFileSync(file, [owners[0], ...(n ? [marker] : []), owners[1], ...(n === 2 ? [marker] : []), owners[2]].join(''));
    const v = await transcriptVisibility({ file, host, sessionId: 'live', config });
    const rows = v.turns.map((t) => t.statement);
    const other = { ...rows[0], id: 'other', session_id: 'other', repo: 'other-repo', text: 'Keep the external API response format consistent across client versions.' };
    await seedIndex(runtime.store, [...rows, other]);
    const input = { host, session_id: 'live', transcript_path: file, prompt: rows[2].text, turn_key: 'turn' };
    const now = () => new Date(decisionTs);
    const out = JSON.parse((await handlePrompt({ input, config, runtime, now })).stdout);
    const context = out.hookSpecificOutput.additionalContext;
    assert.equal(context.includes('(earlier in this session, before context compaction)'), n > 0);
    assert.ok(context.includes('(repo: other-repo)'));
    const logs = () => fs.readdirSync(path.join(dataDir, 'logs')).filter((f) => f.startsWith('turns-')).flatMap((f) => fs.readFileSync(path.join(dataDir, 'logs', f), 'utf8').trim().split('\n').map(JSON.parse));
    const prompt = logs().find((r) => r.event === 'prompt');
    assert.deepEqual(new Set(prompt.injected), new Set([...rows.slice(0, n).map((r) => r.id), 'other']));
    const { corpus } = loadIndexedCorpus(runtime.store);
    const excludeIds = await liveExclusions({ corpus, input, config, decisionTs, currentPrompt: input.prompt });
    const eligible = eligibleIndices(corpus, { decisionMicros: tsMicros(decisionTs), excludeIds });
    const pf = await prefilter({ corpus, eligible, situation: input.prompt, threadId: 'live', deps: { embedQuery: async () => fakeEmbedding(input.prompt) }, stats: {}, memo: {} });
    assert.deepEqual(new Set([...pf.threadRank.keys()].map((i) => corpus.items[i].id)), new Set(rows.slice(0, n).map((r) => r.id)));
  });
}
