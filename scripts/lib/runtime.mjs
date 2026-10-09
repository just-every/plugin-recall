// Wires the pieces for one process: config -> ledger, response cache, API client, index store, and the dependency bundle a retrieval
// needs (query embedding, Decisions scoring, optional CLI rerank), all bound to one deadline and one stats object.
import { createApi } from "./api.mjs";
import { runCliWorker } from "./cli-worker.mjs";
import { createLedger } from "./ledger.mjs";
import { createResponseCache } from "./response-cache.mjs";
import { createQuestionCache } from "./question-cache.mjs";
import { createRouter } from "./router.mjs";
import { createStore } from "./store.mjs";
import { toF32 } from "./vec.mjs";
import { readDurableIndex } from "./durable-store.mjs";

export function createRuntime(config, { post, homeDir, now, runWorker: injectedWorker, log = () => {} } = {}) {
  const ledger = createLedger({ dir: config.dataDir, dailyCapUsd: config.dailyCapUsd, totalCapUsd: config.totalCapUsd, ...(now ? { now } : {}) });
  const cache = createResponseCache({ dir: config.dataDir, enabled: !config.noCache });
  const questionCache = createQuestionCache({ dir: config.dataDir, enabled: !config.noCache });
  const api = createApi({ ledger, cache, questionCache, baseUrl: config.openaiBaseUrl, ...(post ? { post } : {}) });
  const store = createStore(config.dataDir);
  const router = createRouter({ config, ...(homeDir ? { homeDir } : {}) });

  // Every claude/codex worker goes through the router; `injectedWorker` exists for the test suite's stand-in binary.
  const runWorker = injectedWorker ?? ((o) => runCliWorker({ router, config, log, ...o }));

  /** Dependencies for one retrieval. `stats` receives costs and timings; `deadlineAt` (epoch ms) bounds every network call. */
  function makeDeps({ deadlineAt, stats = {} } = {}) {
    return {
      loadDurable: (items) => readDurableIndex({ items, dir: config.dataDir }),
      async embedQuery(text) {
        const r = await api.embedBatch([text], { label: "embed-query", deadlineAt });
        stats.embedCostUsd = (stats.embedCostUsd ?? 0) + r.costUsd;
        stats.embedCached = r.cached;
        stats.embedMs = r.latencyMs;
        return toF32(r.vectors[0]);
      },
      scorePredicates: (options) => api.decidePredicates({ ...options, deadlineAt }),
      scoreChoices: (options) => api.decideChoices({ ...options, deadlineAt }),
      async embedTexts(texts) {
        const r = await api.embedBatch(texts, { label: "embed-hyde", deadlineAt });
        stats.embedCostUsd = (stats.embedCostUsd ?? 0) + r.costUsd;
        stats.embedMs = (stats.embedMs ?? 0) + r.latencyMs;
        return r.vectors.map(toF32);
      },
      async generate({ prompt, schema, model, effort, kind = "codex" }) {
        const body = { kind, model: model ?? null, effort: effort ?? "low", prompt, schema: schema ?? null };
        const hit = cache.get("cli/generate", body);
        if (hit) { stats.generationCached = true; return hit; }
        const r = await runWorker({ kind, prompt, schema, model, effort });
        stats.generationMs = (stats.generationMs ?? 0) + r.durationMs;
        stats.generationHome = r.home;
        stats.generationCached = false;
        cache.put("cli/generate", body, r.json);
        return r.json;
      },
      async rerank({ prompt, schema, kind = "codex" }) {
        const r = await runWorker({ kind, prompt, schema });
        stats.rerankHome = r.home;
        return r.json.order;
      },
    };
  }

  return { config, homeDir, ledger, cache, questionCache, api, store, router, makeDeps, runWorker };
}
