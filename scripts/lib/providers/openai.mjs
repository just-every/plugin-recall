// The OpenAI provider: embeddings and the Decisions API (the judge). The key check is free (GET /v1/models, no tokens); access to the
// Decisions endpoint has no free call, so it is proven once with the smallest real request.
import { createApi, DECISIONS_MODEL } from "../api.mjs";
import { ApiError } from "../http.mjs";
import { costUsd, createLedger, estimateTokens } from "../ledger.mjs";
import { createQuestionCache } from "../question-cache.mjs";
import { createResponseCache } from "../response-cache.mjs";

const CHECK = Object.freeze({
  input: "Recall setup check.",
  questions: [{ name: "setup_check", instructions: "Is this a setup check?" }],
  label: "setup-access-check",
});

/** The request body the access check sends, as api.mjs builds it, for the estimate shown before consent. */
const checkBody = () => ({ model: DECISIONS_MODEL, input: CHECK.input, questions: CHECK.questions.map((q) => ({ type: "predicate", ...q })) });

/** A short reason for a failed request, never longer than one line. */
const shortReason = (e) => String(e?.message ?? e).split("\n")[0].replace(/^POST \S+:?\s*/, "").slice(0, 160);

export const openai = Object.freeze({
  id: "openai",
  label: "OpenAI",
  envName: "OPENAI_API_KEY",
  roles: Object.freeze(["embeddings", "judge"]),
  /** What the key is for, as setup's key heading says it. */
  purpose: "Recall uses it to find what you said before",
  keyUrl: "https://platform.openai.com/api-keys",
  /** What the key must be able to do, said where it is asked for. */
  keyNeeds: "needs a key with Decisions API access",
  looksLikeKey: (s) => /^sk-\S{8,}$/.test(s),
  keyPrefix: "sk-",
  shapeHint: "they start with sk-",
  baseUrl: (config) => config.openaiBaseUrl,
  /** What the free check is, as doctor explains it. */
  validateNote: "one free request (GET /v1/models), no tokens billed",

  /**
   * The free check: GET /v1/models with the key (no tokens, no charge).
   * @returns {Promise<{ok: true} | {ok: false, reason: "rejected"|"unreachable"|"http", status?: number, code?: string}>}
   */
  async validate({ key, config, fetchImpl = fetch, timeoutMs = 10000 }) {
    let res;
    try {
      res = await fetchImpl(`${config.openaiBaseUrl}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
      await res.arrayBuffer();
    } catch (e) {
      return { ok: false, reason: "unreachable", code: e?.cause?.code ?? e?.name ?? "error" };
    }
    if (res.status === 200) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "rejected", status: res.status };
    return { ok: false, reason: "http", status: res.status };
  },

  access: Object.freeze({
    label: "Decisions API",
    /** What the access check proves, in plain words: "Check once that your key can <ability>". The API's name is only in deniedText. */
    ability: "pick what to bring back",
    /** What the one access-check request costs, about (it prints as "less than $0.0001"). */
    estimateUsd: () => costUsd(DECISIONS_MODEL, estimateTokens(checkBody(), 400)),
    /**
     * Exactly one /v1/decisions request, billed to the ledger. Both caches are off: a cached answer would "prove" access for a new key.
     * @returns {Promise<{ok: true, costUsd: number} | {ok: false, reason: string, status?: number}>}
     */
    async check({ key, config }) {
      const dir = config.dataDir;
      const api = createApi({
        ledger: createLedger({ dir, dailyCapUsd: config.dailyCapUsd, totalCapUsd: config.totalCapUsd }),
        cache: createResponseCache({ dir, enabled: false }),
        questionCache: createQuestionCache({ dir, enabled: false }),
        baseUrl: config.openaiBaseUrl,
        apiKey: () => key,
        httpOptions: { maxRetries: 2 },
      });
      try {
        const r = await api.decidePredicates(CHECK);
        return { ok: true, costUsd: r.costUsd ?? 0 };
      } catch (e) {
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) return { ok: false, reason: "denied", status: e.status };
        if (e instanceof ApiError) return { ok: false, reason: `HTTP ${e.status}`, status: e.status };
        return { ok: false, reason: shortReason(e) };
      }
    },
    deniedText: Object.freeze([
      "Recall needs a key with Decisions API access, to pick what to bring back.",
      "Access is per OpenAI organisation: use a key from one that has it, or ask OpenAI to enable it.",
      "Then run this again.",
    ]),
  }),
});
