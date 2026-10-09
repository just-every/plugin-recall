// The provider registry: the one place a provider is declared (its key, the free check, the one paid access check), and the key helpers.
// Every request goes to a local fake server; nothing is billed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { estimateTokens } from "../scripts/lib/ledger.mjs";
import { findKey, keyFingerprint, maskKey, PROVIDERS, requiredProviders } from "../scripts/lib/providers/index.mjs";
import { openai } from "../scripts/lib/providers/openai.mjs";
import { usd } from "../scripts/onboarding/estimate.mjs";
import { startFakeServer, tmpDir } from "./helpers.mjs";
import { closedUrl } from "./sandbox.mjs";

const KEY = "sk-test-provider-key-0001";
const cfg = (baseUrl, dataDir = tmpDir("recall-provider-data")) => ({ openaiBaseUrl: baseUrl, dataDir, dailyCapUsd: 1, totalCapUsd: null });

/** A local server answering every POST with `status` (and counting them), and GET /v1/models with `getStatus`. */
async function statusServer(status, getStatus = 200) {
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.method === "GET") { res.writeHead(getStatus, { "content-type": "application/json" }); res.end('{"data":[]}'); return; }
      posts.push(req.url);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `status ${status}` } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, posts, close: () => new Promise((r) => server.close(r)) };
}

test("the registry: one frozen entry per provider with everything setup and doctor read; OpenAI serves both roles today", () => {
  assert.ok(Object.isFrozen(PROVIDERS));
  assert.deepEqual(PROVIDERS.map((p) => p.id), ["openai"]);
  for (const p of PROVIDERS) {
    for (const k of ["id", "label", "envName", "purpose", "keyUrl", "shapeHint", "validateNote"]) assert.equal(typeof p[k], "string", k);
    for (const k of ["looksLikeKey", "baseUrl", "validate"]) assert.equal(typeof p[k], "function", k);
    assert.ok(Array.isArray(p.roles) && p.roles.length);
    assert.equal(typeof p.access.label, "string");
    assert.equal(typeof p.access.check, "function");
    assert.equal(typeof p.access.estimateUsd, "function");
    assert.ok(p.access.deniedText.length);
  }
  assert.deepEqual(requiredProviders({}), [openai]);
  assert.equal(openai.envName, "OPENAI_API_KEY");
  assert.deepEqual([...openai.roles], ["embeddings", "judge"]);
  assert.equal(openai.purpose, "Recall uses it to find what you said before");
  assert.equal(openai.access.ability, "pick what to bring back");
  assert.ok(openai.looksLikeKey("sk-abcdefgh") && !openai.looksLikeKey("sk-short") && !openai.looksLikeKey("pk-abcdefghij"));
});

test("findKey: the environment wins, then ~/.env (export, quotes and CRLF line ends), else null", () => {
  const home = tmpDir("recall-findkey");
  assert.equal(findKey(openai, { env: {}, homeDir: home }), null);
  fs.writeFileSync(path.join(home, ".env"), `OTHER=1\r\nexport OPENAI_API_KEY="${KEY}"\r\n`);
  assert.deepEqual(findKey(openai, { env: {}, homeDir: home }), { key: KEY, source: "~/.env" });
  fs.writeFileSync(path.join(home, ".env"), `OPENAI_API_KEY='${KEY}'\n`);
  assert.deepEqual(findKey(openai, { env: {}, homeDir: home }), { key: KEY, source: "~/.env" });
  assert.deepEqual(findKey(openai, { env: { OPENAI_API_KEY: "sk-from-the-environment" }, homeDir: home }), { key: "sk-from-the-environment", source: "the environment" });
  assert.deepEqual(findKey(openai, { env: { OPENAI_API_KEY: "" }, homeDir: home }), { key: KEY, source: "~/.env" }, "an empty variable is no key");
});

test("maskKey shows the first 3 and last 4 characters only; the fingerprint is 16 hex characters and never the key", () => {
  assert.equal(maskKey(KEY), "sk-...0001");
  assert.equal(maskKey("sk-abc"), "sk-...");
  const fp = keyFingerprint(KEY);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.notEqual(fp, KEY);
  assert.ok(!KEY.includes(fp) && !fp.includes(KEY.slice(3)));
  assert.notEqual(keyFingerprint(`${KEY}x`), fp);
});

test("validate: the free GET /v1/models; accepted, rejected (401), unreachable, and any other status", async () => {
  const server = await startFakeServer({ acceptKey: KEY });
  const broken = await statusServer(500, 500);
  try {
    assert.deepEqual(await openai.validate({ key: KEY, config: cfg(server.url) }), { ok: true });
    assert.deepEqual(await openai.validate({ key: "sk-wrong-key-123", config: cfg(server.url) }), { ok: false, reason: "rejected", status: 401 });
    assert.deepEqual(server.gets.map((g) => g.url), ["/v1/models", "/v1/models"]);
    assert.equal(server.calls.length, 0, "nothing billable");
    const gone = await openai.validate({ key: KEY, config: cfg(await closedUrl()) });
    assert.equal(gone.ok, false);
    assert.equal(gone.reason, "unreachable");
    assert.equal(gone.code, "ECONNREFUSED");
    assert.deepEqual(await openai.validate({ key: KEY, config: cfg(broken.url) }), { ok: false, reason: "http", status: 500 });
  } finally {
    await server.close();
    await broken.close();
  }
});

test("access.check: exactly one /v1/decisions request with the caches off, its cost in the ledger; 403 and 404 mean no access", async () => {
  const server = await startFakeServer();
  const dataDir = tmpDir("recall-access");
  try {
    const first = await openai.access.check({ key: KEY, config: cfg(server.url, dataDir) });
    assert.equal(first.ok, true);
    assert.ok(first.costUsd > 0 && first.costUsd < 0.0001, String(first.costUsd));
    assert.deepEqual(server.calls.map((c) => c.pathname), ["/v1/decisions"]);
    assert.deepEqual(server.calls[0].body.questions.map((q) => q.name), ["setup_check"]);
    assert.equal(server.calls[0].body.input, "Recall setup check.");
    // a second check asks again: a cached answer must never prove access for a key
    assert.equal((await openai.access.check({ key: KEY, config: cfg(server.url, dataDir) })).ok, true);
    assert.equal(server.calls.length, 2);
    const ledger = fs.readFileSync(path.join(dataDir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(ledger.map((l) => l.label), ["setup-access-check#0", "setup-access-check#0"]);
  } finally {
    await server.close();
  }
  for (const status of [403, 404]) {
    const s = await statusServer(status);
    try {
      assert.deepEqual(await openai.access.check({ key: KEY, config: cfg(s.url) }), { ok: false, reason: "denied", status });
      assert.deepEqual(s.posts, ["/v1/decisions"], "one request, not retried");
    } finally {
      await s.close();
    }
  }
  const gone = await openai.access.check({ key: KEY, config: cfg(await closedUrl()) });
  assert.equal(gone.ok, false);
  assert.ok(gone.reason && !gone.reason.includes("\n"), gone.reason);
});

test("access.estimateUsd is the one tiny request's price, which prints as less than $0.0001", () => {
  const est = openai.access.estimateUsd();
  assert.ok(est > 0 && est < 0.0001, String(est));
  assert.equal(usd(est), "less than $0.0001");
  assert.ok(estimateTokens({ input: "Recall setup check." }, 400) > 0);
});
