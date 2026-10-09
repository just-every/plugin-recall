// UserPromptSubmit: prompt-time recall, the only hook (Recall acts when the owner sends a message). Inject at most RECALL_K earlier owner
// statements that pass the pipeline's gate: v2 injects typed cards (kind, scope, date, gist) of directives that apply here, never the same
// statement twice in a session and never a hub (a statement already said into several other sessions recently); the config settings at their v1
// values give v1's bare dated quotes. Silent for sub-agents, for every
// non-interactive session (claude -p, SDK, codex exec ...: headless.mjs, and also when it cannot tell), for automation and trivial
// prompts, for the kill switch, when the shared spend cap is reached, and on ANY failure or timeout (which is logged loudly; nothing is
// ever invented).
import { maybeStartIndex } from "./auto-index.mjs";
import path from "node:path";
import { attachCards } from "./cards/eligibility.mjs";
import { cardsPath, loadCards } from "./cards/cards-file.mjs";
import { ownerTurnText } from "./cards/context-source.mjs";
import { applySettings, cardFilterOn, effectiveSettings, needsCards, precisionSettings } from "./config.mjs";
import { isCapError, logCapSilence } from "./cap-guard.mjs";
import { classifySession } from "./headless.mjs";
import { applyGate, gateRecord } from "./apply-gate.mjs";
import { injectionContext, priorOf, survivorsOf } from "./injection.mjs";
import { loadIndexedCorpus } from "./index-corpus.mjs";
import { promptOutput } from "./hook-io.mjs";
import { withDeadline } from "./deadline.mjs";
import { retrieve } from "./retrieve.mjs";
import { filterOptions, judgeOwnerText } from "./owner-filter.mjs";
import { createTurnLog, createTurnState } from "./turn-log.mjs";
import { turnMeta } from "./turn-meta.mjs";
import { contextSituation, promptSituation } from "./situations.mjs";
import { clip } from "./text.mjs";
import { liveExclusions } from "./live-exclusions.mjs";
import { conversationTurns, priorContext } from "./transcripts/tail.mjs";
import { createHubIndex } from "./hub-index.mjs";
import { repoOfSession } from "./repo-identity.mjs";
import { pluginRoot } from "./plugin-root.mjs";

const RECALL_BLOCK = /<recall-context>[\s\S]*?<\/recall-context>/g;

const brief = (corpus, e) => {
  const it = corpus.items[corpus.byId.get(e.id)];
  return {
    id: e.id, score: e.score, parts: e.parts, ts: it.ts, repo: it.repo, session_id: it.session_id, text: clip(it.text, 160), src: it.src ?? null,
    ...(it.card ? { kind: it.card.kind, scope: it.card.scope, gist: it.card.gist } : {}),
  };
};

/** The repo the session is in, by the rule the indexer files statements under (repo-identity.mjs), and the label the situation shows for it. */
const repoAndProject = (cwd) => {
  const repo = repoOfSession({ cwd });
  return { repo, project: repo ?? (cwd ? path.basename(cwd.replace(/[\\/]+$/, "")) || null : null) };
};

/** The prompt-time situation: v1's owner message alone, or with the project and the last exchange read from the transcript (queryContext). */
function buildSituation({ config, input, query, project }) {
  if (!config.queryContext) return promptSituation(query);
  const { prevOwner, assistant } = priorContext(conversationTurns({ host: input.host, file: input.transcript_path }), query);
  return contextSituation({ project, prevOwner: prevOwner === null ? null : ownerTurnText(prevOwner, config), assistant, ownerText: query });
}

/** @returns {Promise<{stdout: string, stderr: string, exitCode: number}>} */
export async function handlePrompt({ input, config, runtime, now = () => new Date(), env = process.env }) {
  const log = createTurnLog(config.dataDir, { now });
  const state = createTurnState(config.dataDir);
  const t0 = performance.now();
  const base = { event: "prompt", ...turnMeta(input), session_id: input.session_id, pipeline: config.pipeline, dataDir: config.dataDir, settings: effectiveSettings(config) };
  const silent = (reason, extra = {}) => {
    log.write({ ...base, outcome: "silent", reason, latency_ms: Math.round(performance.now() - t0), ...extra });
    return promptOutput(input.host, null);
  };

  if (config.disabled) return silent("disabled");
  if (config.child) return silent("child");
  if (input.agent_id) return silent("subagent", { agent_type: input.agent_type });
  if (!config.allowHeadless) {
    const session = await classifySession({ input, env });
    if (!session.interactive) return silent(session.reason, { signals: session.signals });
  }
  if (!input.prompt) return silent("no-prompt");

  const judged = judgeOwnerText(input.prompt.replace(RECALL_BLOCK, " "), filterOptions(config));
  if (!judged.text) return silent(`not-owner-text:${judged.reason}`);
  const query = judged.text;

  const capped = runtime.ledger.capReached();
  if (capped) {
    logCapSilence({ log, base, dataDir: config.dataDir, cap: capped, now, extra: { latency_ms: Math.round(performance.now() - t0) } });
    return promptOutput(input.host, null);
  }

  const stats = {};
  const { repo: currentRepo, project } = repoAndProject(input.cwd);
  let result;
  let corpusInfo;
  let situation;
  let cardCount = 0;
  const deadlineAt = Date.now() + config.timeoutMs;
  const failed = (e, fields) => {
    if (isCapError(e)) {
      logCapSilence({ log, base, dataDir: config.dataDir, cap: e, now, extra: { latency_ms: Math.round(performance.now() - t0), stats, ...fields.extra } });
      return promptOutput(input.host, null);
    }
    log.write({ ...base, level: "error", outcome: "silent", reason: fields.reason, error: `${e.name}: ${e.message}`, query: clip(query, 400), latency_ms: Math.round(performance.now() - t0), stats, ...fields.extra });
    return promptOutput(input.host, null);
  };
  try {
    corpusInfo = loadIndexedCorpus(runtime.store);
    if (!corpusInfo.corpus.items.length) {
      maybeStartIndex({ config, store: runtime.store });
      return silent("empty-index", { statements: corpusInfo.statements, without_embedding: corpusInfo.withoutEmbedding });
    }
    if (needsCards(config)) {
      const cards = loadCards(cardsPath(config.dataDir));
      cardCount = attachCards(corpusInfo.corpus, cards);
      if (!cardCount) {
        // v2 injects only statements that have a card; with none there is nothing it may say. The background pass writes them.
        maybeStartIndex({ config, store: runtime.store });
        log.write({ ...base, level: "error", outcome: "silent", reason: "no-cards", error: `${cardsPath(config.dataDir)} has no cards for the ${corpusInfo.statements} indexed statements; run: recall enrich`, latency_ms: Math.round(performance.now() - t0) });
        return promptOutput(input.host, null);
      }
    }
    situation = buildSituation({ config, input, query, project });
    const decisionTs = now().toISOString();
    result = await withDeadline(
      (async () => retrieve({
        corpus: corpusInfo.corpus, query: situation, mode: "prompt", decisionTs,
        excludeIds: await liveExclusions({ corpus: corpusInfo.corpus, input, config, decisionTs, currentPrompt: query }), threadId: input.session_id,
        currentRepo, pipeline: config.pipeline, deps: runtime.makeDeps({ deadlineAt, stats }), cfg: config, stats,
      }))(),
      config.timeoutMs,
      "recall retrieval",
    );
  } catch (e) {
    return failed(e, { reason: "retrieval-failed" });
  }

  const { corpus } = corpusInfo;
  const prior = priorOf(state.read(input.session_id)?.injected ?? [], corpus);
  const hubIndex = createHubIndex({ dataDir: config.dataDir, windowDays: config.hubWindowDays, now });
  const hubIds = config.hubMaxSessions > 0 ? hubIndex.suppressed({ sessionId: input.session_id, maxSessions: config.hubMaxSessions }) : new Set();
  const { passing, repeats, hubs } = survivorsOf({ ranked: result.ranked, corpus, pipeline: config.pipeline, cfg: config, prior, hubIds });
  let picked = passing.slice(0, config.k);
  let gate = null;
  if (config.applyGate && passing.length) {
    // The precision gate, inside the same deadline as the retrieval: when it cannot answer in time (or at all) nothing is injected, never the unreranked survivors.
    const gateStats = {};
    const g0 = performance.now();
    try {
      const run = await withDeadline(
        applyGate({ entries: passing, corpus, situation, deps: runtime.makeDeps({ deadlineAt, stats: gateStats }), k: config.k, threshold: config.applyThreshold, stats: gateStats }),
        Math.max(1, deadlineAt - Date.now()),
        "recall apply gate",
      );
      picked = run.picked;
      stats.costUsd = (stats.costUsd ?? 0) + (gateStats.costUsd ?? 0);
      gate = gateRecord({ ...run, threshold: config.applyThreshold, k: config.k, stats: gateStats, ms: performance.now() - g0 });
    } catch (e) {
      return failed(e, { reason: "apply-gate-failed", extra: { repo: currentRepo, eligible: result.eligible, applyGate: { threshold: config.applyThreshold, survivors: passing.length, ids: passing.map((p) => p.id), ms: Math.round(performance.now() - g0), questions: gateStats.questions ?? 0, requests: gateStats.requests ?? 0 } } });
    }
  }
  const context = injectionContext({ picked, corpus, cfg: config, sessionId: input.session_id, currentRepo, source: { root: pluginRoot(env) } });
  if (picked.length) {
    state.write(input.session_id, { session_id: input.session_id, at: now().toISOString(), injected: [...prior.ids, ...picked.map((e) => e.id)] });
    hubIndex.record({ sessionId: input.session_id, ids: picked.map((e) => e.id) });
  }
  log.write({
    ...base, outcome: context ? "injected" : "silent", ...(context ? {} : { reason: "nothing-above-threshold" }),
    query: clip(query, 400), situation: clip(situation, 3000), repo: currentRepo, eligible: result.eligible, statements: corpusInfo.statements, without_embedding: corpusInfo.withoutEmbedding,
    ...(needsCards(config) ? { cards: cardCount } : {}),
    // what the precision rules kept out of an otherwise eligible history, per rule: {reason: {count, ids (the newest 50)}}, and the rules' settings
    ...(cardFilterOn(config) ? { precision: precisionSettings(config) } : {}), ...(result.excluded ? { excluded: result.excluded } : {}),
    // with the apply gate on: its settings with their sources (applyGate, below, is what it did on this turn)
    ...(config.applyGate ? { apply: applySettings(config) } : {}),
    candidates: result.ranked.slice(0, 20).map((e) => brief(corpus, e)), injected: picked.map((e) => e.id), ...(repeats.length ? { repeats } : {}), ...(hubs.length ? { hubs } : {}), ...(gate ? { applyGate: gate } : {}), context,
    latency_ms: Math.round(performance.now() - t0), stats,
  });
  try { maybeStartIndex({ config, store: runtime.store }); } catch (e) { log.write({ ...base, level: "error", event: "auto-index", error: e.message }); }
  return promptOutput(input.host, context);
}
