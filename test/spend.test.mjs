// Ledger, daily cap, response cache, retry policy and API client accounting. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createApi } from "../scripts/lib/api.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { parseEnvFile, getOpenAIKey } from "../scripts/lib/key.mjs";
import { RecallTimeoutError, postJson } from "../scripts/lib/http.mjs";
import { CapExceededError, costUsd, createLedger } from "../scripts/lib/ledger.mjs";
import { createResponseCache } from "../scripts/lib/response-cache.mjs";
import { fakeOpenAI, tmpDir } from "./helpers.mjs";

test("prices: gpt-6-luna $0.10 per 1M input tokens (x2 above 272K), embeddings $0.02", () => {
  assert.ok(Math.abs(costUsd("gpt-6-luna", 200_000) - 0.02) < 1e-12);
  assert.ok(Math.abs(costUsd("gpt-6-luna", 300_000) - 0.06) < 1e-12);
  assert.equal(costUsd("text-embedding-3-small", 1_000_000), 0.02);
  assert.throws(() => costUsd("gpt-unknown", 1), /no price/);
});

test("ledger: lines are lab-compatible, totals are per UTC day and overall, a new day resets the daily total", () => {
  const dir = tmpDir();
  let now = new Date("2026-10-07T23:00:00Z");
  const l = createLedger({ dir, dailyCapUsd: 1, totalCapUsd: null, now: () => now });
  l.record({ endpoint: "/v1/decisions", inputTokens: 1000, costUsd: 0.0001, requestId: "r1" });
  l.record({ endpoint: "/v1/embeddings", inputTokens: 500, costUsd: 0.00001, requestId: "r2" });
  assert.ok(Math.abs(l.spentToday() - 0.00011) < 1e-12);
  const lines = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(Object.keys(lines[0]).slice(0, 6), ["ts", "experiment", "endpoint", "inputTokens", "costUsd", "requestId"]);
  assert.equal(lines[0].experiment, "plugin-recall");
  now = new Date("2026-10-08T00:00:01Z");
  assert.equal(l.spentToday(), 0);
  assert.ok(Math.abs(l.spentTotal() - 0.00011) < 1e-12);
});

test("ledger: another process's appended lines are seen (tail read), a corrupt line is a loud error", () => {
  const dir = tmpDir();
  const a = createLedger({ dir, dailyCapUsd: 1 });
  const b = createLedger({ dir, dailyCapUsd: 1 });
  a.record({ endpoint: "/x", inputTokens: 1, costUsd: 0.25 });
  assert.equal(b.spentToday(), 0.25);
  b.record({ endpoint: "/x", inputTokens: 1, costUsd: 0.5 });
  assert.equal(a.spentToday(), 0.75);
  fs.appendFileSync(path.join(dir, "ledger.jsonl"), "{not json}\n");
  assert.throws(() => a.spentToday(), /corrupt ledger line/);
});

test("ledger: the daily cap stops a request BEFORE it is sent, counting what is already in flight; the total cap does too", () => {
  const dir = tmpDir();
  const l = createLedger({ dir, dailyCapUsd: 0.01, totalCapUsd: 0.02 });
  const r1 = l.reserve(0.006);
  assert.throws(() => l.reserve(0.006), (e) => e instanceof CapExceededError && e.scope === "daily" && /RECALL_DAILY_CAP_USD/.test(e.message));
  r1.release();
  l.reserve(0.006).release();
  l.record({ endpoint: "/x", inputTokens: 1, costUsd: 0.009 });
  assert.throws(() => l.reserve(0.002), /daily spend cap exceeded/);
  const t = createLedger({ dir: tmpDir(), dailyCapUsd: 10, totalCapUsd: 0.001 });
  assert.throws(() => t.reserve(0.002), (e) => e.scope === "total");
});

test("config: RECALL_DAILY_CAP_USD defaults to 1.0; invalid values throw instead of falling back", () => {
  assert.equal(loadConfig({}).dailyCapUsd, 1);
  assert.equal(loadConfig({ RECALL_DAILY_CAP_USD: "8" }).dailyCapUsd, 8);
  assert.throws(() => loadConfig({ RECALL_DAILY_CAP_USD: "lots" }), /RECALL_DAILY_CAP_USD/);
  assert.throws(() => loadConfig({ RECALL_K: "2.5" }), /RECALL_K/);
  assert.throws(() => loadConfig({ RECALL_DISABLED: "maybe" }), /RECALL_DISABLED/);
  assert.equal(loadConfig({ RECALL_K: "7" }).k, 7);
  assert.equal(loadConfig({}).k, 3, "v2 injects fewer cards (v1: 5)");
  assert.equal(loadConfig({ RECALL_DISABLED: "1" }).disabled, true);
});

test("config: the data dir is RECALL_DATA, else ONE shared ~/.plugin-recall (never a host's per-home plugin data dir)", () => {
  assert.equal(loadConfig({ RECALL_DATA: "/a", CLAUDE_PLUGIN_DATA: "/b" }).dataDir, "/a");
  assert.equal(loadConfig({ HOME: "/h", CLAUDE_PLUGIN_DATA: "/b", PLUGIN_DATA: "/c" }).dataDir, "/h/.plugin-recall");
  assert.equal(loadConfig({ HOME: "/h", PLUGIN_DATA: "/c" }).dataDir, "/h/.plugin-recall");
  assert.equal(loadConfig({ HOME: "/h" }).dataDir, "/h/.plugin-recall", "the same directory for Claude, Codex and Every Code, whichever home they run in");
});

test("key: env OPENAI_API_KEY first, else ~/.env; never echoed in the error", () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, ".env"), "FOO=1\nexport OPENAI_API_KEY='sk-from-file'\n");
  assert.equal(getOpenAIKey({ OPENAI_API_KEY: "sk-env" }, home), "sk-env");
  assert.equal(getOpenAIKey({}, home), "sk-from-file");
  assert.equal(parseEnvFile('OPENAI_API_KEY="q"', "OPENAI_API_KEY"), "q");
  const empty = tmpDir();
  assert.throws(() => getOpenAIKey({}, empty), /OPENAI_API_KEY is not in the environment/);
});

const res = (status, body, headers = {}) => ({ status, headers: new Headers(headers), text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const noSleep = async () => {};

test("http: retries ONLY 429 and 5xx (and network errors); a 400 throws at once", async () => {
  let n = 0;
  const f = async () => (++n < 3 ? res(n === 1 ? 429 : 503, "busy") : res(200, { ok: true }));
  const r = await postJson("http://x/y", {}, { apiKey: "k", fetchImpl: f, sleepImpl: noSleep, baseDelayMs: 1 });
  assert.equal(r.json.ok, true);
  assert.equal(r.attempts, 3);
  let m = 0;
  await assert.rejects(() => postJson("http://x/y", {}, { apiKey: "k", fetchImpl: async () => { m++; return res(400, "bad request"); }, sleepImpl: noSleep }), /-> 400/);
  assert.equal(m, 1, "a 400 is not retried");
  let q = 0;
  await assert.rejects(() => postJson("http://x/y", {}, { apiKey: "k", fetchImpl: async () => { q++; return res(429, { error: { code: "insufficient_quota" } }); }, sleepImpl: noSleep }), /insufficient_quota/);
  assert.equal(q, 1, "an exhausted quota is not retried");
});

test("http: a client timeout is NOT retried (the server may have billed it) and throws RecallTimeoutError", async () => {
  let n = 0;
  const f = async () => { n++; const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };
  await assert.rejects(() => postJson("http://x/y", {}, { apiKey: "k", fetchImpl: f, sleepImpl: noSleep, timeoutMs: 5 }), (e) => e instanceof RecallTimeoutError);
  assert.equal(n, 1);
});

test("http: a retry wait that would pass the deadline gives up instead of sleeping past the hook's budget", async () => {
  const f = async () => res(429, "busy", { "retry-after": "60" });
  await assert.rejects(() => postJson("http://x/y", {}, { apiKey: "k", fetchImpl: f, sleepImpl: noSleep, deadlineAt: Date.now() + 5000 }), /would pass the deadline/);
});

function apiFor(dataDir, post, capUsd = 5) {
  const ledger = createLedger({ dir: dataDir, dailyCapUsd: capUsd });
  return { ledger, api: createApi({ ledger, cache: createResponseCache({ dir: dataDir }), post, apiKey: () => "test" }) };
}

test("api: every billed call is ledgered from the response usage; an identical request replays from the cache for free", async () => {
  const dir = tmpDir();
  const fake = fakeOpenAI();
  const { ledger, api } = apiFor(dir, fake.post);
  const q = [{ name: "a", instructions: 'Past owner statement: "alpha beta gamma"\nIs this past owner statement important for handling the situation above correctly?' }];
  const first = await api.decidePredicates({ input: "alpha beta gamma delta", questions: q });
  assert.equal(first.cached, false);
  assert.ok(first.costUsd > 0);
  const spent = ledger.spentTotal();
  assert.ok(Math.abs(spent - first.costUsd) < 1e-12);
  const second = await api.decidePredicates({ input: "alpha beta gamma delta", questions: q });
  assert.equal(second.cached, true);
  assert.equal(second.costUsd, 0);
  assert.equal(second.latencyMs, 0);
  assert.deepEqual(second.probabilities, first.probabilities);
  assert.equal(ledger.spentTotal(), spent, "a cache hit writes no ledger line");
  assert.equal(fake.calls.length, 1);
  const third = await api.decidePredicates({ input: "alpha beta gamma delta!", questions: q });
  assert.equal(third.cached, false, "a different request body is a different key");
});

test("api: the cache is off with RECALL_NO_CACHE (latency measurement mode)", async () => {
  const dir = tmpDir();
  const fake = fakeOpenAI();
  const ledger = createLedger({ dir, dailyCapUsd: 5 });
  const api = createApi({ ledger, cache: createResponseCache({ dir, enabled: false }), post: fake.post, apiKey: () => "test" });
  const q = [{ name: "a", instructions: "x" }];
  await api.decidePredicates({ input: "same", questions: q });
  await api.decidePredicates({ input: "same", questions: q });
  assert.equal(fake.calls.length, 2);
});

test("api: the daily cap blocks the request before anything is sent", async () => {
  const dir = tmpDir();
  const fake = fakeOpenAI();
  const { api } = apiFor(dir, fake.post, 0.0000001);
  await assert.rejects(() => api.decidePredicates({ input: "alpha", questions: [{ name: "a", instructions: "x" }] }), CapExceededError);
  assert.equal(fake.calls.length, 0);
});

test("api: a timeout is recorded in the ledger at the estimate (it may have been billed) and then thrown", async () => {
  const dir = tmpDir();
  const post = async (url) => { throw new RecallTimeoutError(url, 10, 1); };
  const { ledger, api } = apiFor(dir, post);
  await assert.rejects(() => api.decidePredicates({ input: "alpha", questions: [{ name: "a", instructions: "x" }] }), RecallTimeoutError);
  const lines = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "timeout-estimate");
  assert.ok(lines[0].costUsd > 0 && ledger.spentToday() > 0);
});

test("api: large question sets pack at 200; a malformed answer count is a loud error", async () => {
  const fake = fakeOpenAI();
  const { api } = apiFor(tmpDir(), fake.post);
  const result = await api.decidePredicates({ input: "x", questions: Array.from({ length: 201 }, (_, i) => ({ name: `q${i}`, instructions: `x${i}` })) });
  assert.equal(result.probabilities.length, 201);
  assert.deepEqual(fake.calls.map((c) => c.body.questions.length), [200, 1]);
  const bad = async () => ({ status: 200, headers: {}, json: { answers: [], usage: { input_tokens: 5 } }, latencyMs: 1, requestId: "r" });
  const { api: api2 } = apiFor(tmpDir(), bad);
  await assert.rejects(() => api2.decidePredicates({ input: "x", questions: [{ name: "a", instructions: "x" }] }), /expected 1 answers, got 0/);
});
