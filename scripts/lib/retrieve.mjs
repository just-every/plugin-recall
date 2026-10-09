// The retrieval core: (query, current session, decision time) -> ranked statements with scores. Eligibility is enforced HERE and only
// here: an item is eligible iff its time is strictly before the decision time (parsed, microsecond precision), its id is not in
// excludeIds (already in the agent's context, from a contract or live compaction scan), and, when excludeSession is set (CLI query),
// it is not from that conversation. With the card filter on (excludeKinds, scopeFilter, the precision rules) only statements whose card allows
// injection in the current repo are eligible: the filter is part of eligibility, so ranking, judging and session chunks only ever see them.
import { cardAllow } from "./cards/eligibility.mjs";
import { exclusionTally } from "./cards/precision.mjs";
import { eligibleIndices } from "./corpus.mjs";
import { getPipeline } from "./pipelines/index.mjs";
import { TOP_N } from "./pipelines/rank.mjs";
import { situationOf } from "./situations.mjs";
import { tsMicros } from "./text.mjs";

/**
 * @param {{corpus: object, query: string, mode?: "prompt"|"stop", decisionTs: string, excludeIds?: Iterable<string>, excludeSession?: string|null,
 *          threadId?: string|null, currentRepo?: string|null, pipeline?: string, deps: {embedQuery: Function, scorePredicates: Function, rerank?: Function}, cfg: object, stats?: object}} o
 * @returns {Promise<{ranked: object[], eligible: number, stats: object, pipeline: string, excluded?: object}>} ranked: top 50, best first, [{id, score, parts}];
 *   excluded: what the precision rules kept out of an otherwise eligible history, {reason: {count, ids}} (absent when they kept out nothing)
 */
export async function retrieve({ corpus, query, mode = "prompt", decisionTs, excludeIds = [], excludeSession = null, threadId = null, currentRepo = null, pipeline = "default", deps, cfg, stats = {} }) {
  if (typeof query !== "string" || !query.trim()) throw new Error("retrieve: query must be a non-empty string");
  const pipe = getPipeline(pipeline);
  const tally = exclusionTally();
  const eligible = eligibleIndices(corpus, { decisionMicros: tsMicros(decisionTs), excludeIds: new Set(excludeIds), excludeSession, allow: cardAllow(cfg, currentRepo, tally.add) });
  const excluded = tally.summary();
  if (!eligible.length) return { ranked: [], eligible: 0, stats, pipeline: pipe.name, ...(excluded ? { excluded } : {}) };
  // `query` is the situation (or a bare message, wrapped by situationOf); threadId is the live thread, for the same-thread list.
  const ctx = { corpus, eligible, query, situation: situationOf(query, mode), threadId, mode, deps, cfg, stats, memo: {} };
  const t0 = performance.now();
  const { ranked } = await pipe.run(ctx);
  stats.totalMs = performance.now() - t0;
  return { ranked: ranked.slice(0, TOP_N), eligible: eligible.length, stats, pipeline: pipe.name, ...(excluded ? { excluded } : {}) };
}

/** Entries of `ranked` that pass the pipeline's injection gate, at most k. */
export function gated(pipelineName, ranked, cfg, k) {
  const pipe = getPipeline(pipelineName);
  return ranked.filter((e) => pipe.gate(e, cfg)).slice(0, k);
}
