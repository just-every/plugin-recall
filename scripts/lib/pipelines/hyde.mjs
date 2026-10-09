import { rankByEmbedding } from '../corpus.mjs';
import { prefilter } from './prefilter.mjs';
import { COMPOSE_SPEC } from './compose-model.mjs';

export const HYDE_INSTRUCTION = 'List 8 short things the owner might have said in earlier conversations (standing rules, preferences, decisions, constraints, past failures) that an agent in this situation should know. Write each in the owner\'s voice, one line each. Return a JSON object with key "hypotheses", an array of exactly 8 strings. This is a hypothetical text-generation task: use only the SITUATION below, do not use tools, files, memory, history, or external sources. Do not solve the coding task or discuss your process.';
export const HYDE_SCHEMA = { type: 'object', additionalProperties: false, required: ['hypotheses'], properties: { hypotheses: { type: 'array', minItems: 8, maxItems: 8, items: { type: 'string' } } } };

export function hydePrompt(situation) { return `${HYDE_INSTRUCTION}\n\n${situation}`; }

export function fuseHyde(rankings) {
  const { hydeRankingTop: top, hydeRrfK: k } = COMPOSE_SPEC.constants;
  const scores = new Map();
  for (const ranking of rankings) ranking.slice(0, top).forEach((idx, j) => scores.set(idx, (scores.get(idx) ?? 0) + 1 / (k + j + 1)));
  return [...scores].map(([idx, score]) => ({ idx, score })).sort((a, b) => b.score - a.score || a.idx - b.idx);
}

export async function hydeRanking(ctx) {
  if (ctx.memo.hyde) return ctx.memo.hyde;
  const run = (async () => {
    if (!ctx.deps.generate || !ctx.deps.embedTexts) throw new Error('compose requires generate and embedTexts dependencies for HyDE');
    const start = performance.now();
    const [pf, generated] = await Promise.all([
      prefilter(ctx),
      ctx.deps.generate({ prompt: hydePrompt(ctx.situation), schema: HYDE_SCHEMA, kind: 'codex', effort: 'low', label: 'hyde' }),
    ]);
    const hypotheses = generated?.hypotheses;
    if (!Array.isArray(hypotheses) || hypotheses.length !== 8 || hypotheses.some(h => typeof h !== 'string' || !h.trim())) throw new Error('HyDE must generate exactly eight nonempty strings');
    const vectors = await ctx.deps.embedTexts(hypotheses);
    if (!Array.isArray(vectors) || vectors.length !== 8) throw new Error('HyDE requires eight embedding vectors');
    const rankings = vectors.map(v => rankByEmbedding(ctx.corpus, ctx.eligible, v).map(row => row.idx));
    rankings.push(pf.emb.map(row => row.idx), pf.bm25.map(row => row.idx));
    const ranked = fuseHyde(rankings);
    ctx.stats.hydeMs = performance.now() - start;
    return { ranked, rank: new Map(ranked.map((row, j) => [row.idx, j + 1])) };
  })();
  ctx.memo.hyde = run;
  return run;
}
