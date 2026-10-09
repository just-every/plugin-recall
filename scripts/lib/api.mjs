// OpenAI calls: the Decisions API (gpt-6-luna) and embeddings (text-embedding-3-small). Every call goes through billedCall():
// response cache -> cap reservation -> POST (retry only 429/5xx/network) -> ledger line from the response's usage -> cache put.
// A client timeout is recorded in the ledger at the pre-flight estimate (it may have been billed) and thrown. No fallbacks.
import { postJson, RecallTimeoutError } from "./http.mjs";
import { costUsd, estimateTokens } from "./ledger.mjs";
import { getOpenAIKey } from "./key.mjs";
import { createQuestionScorer } from "./decision-questions.mjs";

export const DEFAULT_BASE_URL = "https://api.openai.com";
export const DECISIONS_MODEL = "gpt-6-luna";
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const MAX_QUESTIONS = 200; // measured per-request limit of the Decisions API

export class DecisionsParseError extends Error {
  constructor(message, raw) {
    super(`${message}: ${JSON.stringify(raw).slice(0, 800)}`);
    this.name = "DecisionsParseError";
  }
}

/**
 * @param {{ledger: object, cache: object, questionCache?: object, baseUrl?: string, apiKey?: () => string, post?: typeof postJson, httpOptions?: object}} deps
 */
export function createApi({ ledger, cache, questionCache, baseUrl = DEFAULT_BASE_URL, apiKey = () => getOpenAIKey(), post = postJson, httpOptions = {} }) {
  async function billedCall({ endpoint, url, model, body, tokensOf, label, deadlineAt, timeoutMs, overhead, cacheable = true }) {
    const hit = cacheable ? cache.get(endpoint, body) : null;
    if (hit) return { json: hit, cached: true, costUsd: 0, latencyMs: 0, requestId: null, inputTokens: 0 };
    const estTokens = estimateTokens(body, overhead);
    const reservation = ledger.reserve(costUsd(model, estTokens));
    let http;
    let cost;
    let inputTokens;
    // The reservation is released only AFTER the spend is in the ledger: the ledger is shared by every hook process, and between a
    // release and a record another process would see neither the reservation nor the spend.
    try {
      try {
        http = await post(url, body, { ...httpOptions, apiKey: apiKey(), label, deadlineAt, timeoutMs });
      } catch (e) {
        if (e instanceof RecallTimeoutError) {
          ledger.record({ endpoint, inputTokens: estTokens, costUsd: costUsd(model, estTokens), kind: "timeout-estimate", label });
        }
        throw e;
      }
      inputTokens = tokensOf(http.json);
      if (typeof inputTokens !== "number") throw new Error(`${endpoint}: response has no token usage (request ${http.requestId}); cannot bill it to the ledger`);
      cost = costUsd(model, inputTokens);
      ledger.record({ endpoint, inputTokens, costUsd: cost, requestId: http.requestId, label });
    } finally {
      reservation.release();
    }
    if (cacheable) cache.put(endpoint, body, http.json);
    return { json: http.json, cached: false, costUsd: cost, latencyMs: http.latencyMs, requestId: http.requestId, inputTokens };
  }

  function parseAnswers(raw, expected) {
    if (!raw || !Array.isArray(raw.answers)) throw new DecisionsParseError("response has no answers array", raw);
    if (raw.answers.length !== expected) throw new DecisionsParseError(`expected ${expected} answers, got ${raw.answers.length}`, raw);
    for (const a of raw.answers) {
      if (!a || !["predicate", "choice", "score", "refusal"].includes(a.type)) throw new DecisionsParseError(`unknown answer type ${a?.type}`, raw);
      if (a.type === "predicate" && typeof a.probability !== "number") throw new DecisionsParseError("predicate answer without numeric probability", raw);
    }
    return raw.answers;
  }

  async function sendQuestions({ input, questions, label = "decisions", deadlineAt, timeoutMs }) {
    const body = { model: DECISIONS_MODEL, input, questions };
    const r = await billedCall({ endpoint: "/v1/decisions", url: `${baseUrl}/v1/decisions`, model: DECISIONS_MODEL, body, tokensOf: (j) => j?.usage?.input_tokens, label, deadlineAt, timeoutMs, overhead: 400 });
    const answers = parseAnswers(r.json, questions.length);
    answers.forEach((answer, i) => {
      if (answer.type !== "refusal" && answer.type !== questions[i].type) throw new DecisionsParseError("answer type does not match question", answer);
      if (answer.type === "choice" && (!Array.isArray(answer.probabilities) || answer.probabilities.some((p) => !Number.isFinite(p.probability)))) throw new DecisionsParseError("choice answer without probabilities", answer);
    });
    return { ...r, answers };
  }
  const decideQuestions = createQuestionScorer({ questionCache, send: sendQuestions, maxQuestions: MAX_QUESTIONS });
  async function decidePredicates({ questions, ...options }) {
    const r = await decideQuestions({ ...options, questions: questions.map((q) => ({ type: "predicate", name: q.name, instructions: q.instructions })) });
    return { ...r, probabilities: r.answers.map((a) => a.type === "predicate" ? a.probability : null) };
  }
  const decideChoices = ({ questions, ...options }) => decideQuestions({ ...options, questions: questions.map((q) => ({ type: "choice", name: q.name, instructions: q.instructions, choices: q.choices })) });

  /**
   * Embeddings for up to 2048 texts in one request. Vectors are returned in input order as plain arrays. Statement batches pass
   * cacheable:false: the embedding store already keys them by text hash, and a 128-vector response is 2 MB of JSON.
   */
  async function embedBatch(texts, { label = "embeddings", deadlineAt, timeoutMs, cacheable = true } = {}) {
    if (!texts.length) throw new Error("embedBatch: texts must not be empty");
    for (const [i, t] of texts.entries()) if (typeof t !== "string" || !t) throw new Error(`embedBatch: texts[${i}] must be a non-empty string`);
    const body = { model: EMBEDDING_MODEL, input: texts, encoding_format: "float" };
    const r = await billedCall({ endpoint: "/v1/embeddings", url: `${baseUrl}/v1/embeddings`, model: EMBEDDING_MODEL, body, tokensOf: (j) => j?.usage?.prompt_tokens, label, deadlineAt, timeoutMs, overhead: texts.length * 4 + 16, cacheable });
    const data = r.json?.data;
    if (!Array.isArray(data) || data.length !== texts.length) throw new Error(`embeddings: malformed response: ${JSON.stringify(r.json).slice(0, 300)}`);
    const vectors = [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { vectors, costUsd: r.costUsd, cached: r.cached, latencyMs: r.latencyMs, inputTokens: r.inputTokens };
  }

  return { decidePredicates, decideChoices, decideQuestions, embedBatch };
}
