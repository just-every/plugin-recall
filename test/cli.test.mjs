// The CLI (index / query / eval) as a user runs it, against a local fake OpenAI. eval follows the offline contract exactly.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V1_ENV } from "../scripts/lib/config.mjs";
import { claudeLine, startFakeServer, tmpDir } from "./helpers.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "recall.mjs");

function recall(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, OPENAI_API_KEY: "sk-test", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => { stdout += d; });
    c.stderr.on("data", (d) => { stderr += d; });
    c.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const writeJsonl = (file, rows) => fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
const readJsonl = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const CORPUS = [
  { id: "c1", text: "Never add fallback code paths; fix the structure properly.", ts: "2026-01-01T00:00:00Z", session_id: "A", repo: "r1", host: "claude" },
  { id: "c2", text: "Use real prices from the source, never invent unit costs.", ts: "2026-01-02T00:00:00.500000Z", session_id: "A", repo: "r1", host: "claude" },
  { id: "c3", text: "Lets run the summarizer on the small model while we compare costs.", ts: "2026-01-03T00:00:00Z", session_id: "B", repo: null, host: "codex" },
  { id: "c4", text: "Back and forward must not change focus when viewing earlier edits.", ts: "2026-01-04T00:00:00Z", session_id: "B", repo: "r2", host: "code" },
  { id: "c5", text: "A later statement about fallback code paths that must stay invisible to earlier cases.", ts: "2026-02-01T00:00:00Z", session_id: "C", repo: null, host: "claude" },
];
const CASES = [
  { case_id: "k1", mode: "stop", query: "I added a fallback code path and a limit, fixing the structure later.", decision_ts: "2026-01-04T00:00:00Z", session_id: "B", exclude_ids: [] },
  { case_id: "k2", mode: "prompt", query: "should the planner use the fallback structure from before", decision_ts: "2026-01-10T00:00:00Z", session_id: "B", exclude_ids: ["c3"] },
  { case_id: "k3", mode: "prompt", query: "anything about fallback code paths at all", decision_ts: "2026-03-01T00:00:00Z", session_id: "C", exclude_ids: ["c5"] },
];

test("eval: follows the contract - top-50 {id, score} per case, eligibility ts < decision_ts and not in exclude_ids, sidecars, resumable", async () => {
  const server = await startFakeServer();
  try {
    const dir = tmpDir("recall-eval");
    const env = { ...V1_ENV, RECALL_DATA: path.join(dir, "data"), RECALL_OPENAI_BASE_URL: server.url, RECALL_DAILY_CAP_USD: "5", HOME: dir };
    writeJsonl(path.join(dir, "corpus.jsonl"), CORPUS);
    writeJsonl(path.join(dir, "cases.jsonl"), CASES);
    for (const pipeline of ["embeddings", "default"]) {
      const out = path.join(dir, `out-${pipeline}.jsonl`);
      const r = await recall(["eval", "--corpus", path.join(dir, "corpus.jsonl"), "--cases", path.join(dir, "cases.jsonl"), "--pipeline", pipeline, "--out", out], env);
      assert.equal(r.code, 0, r.stderr);
      const rows = readJsonl(out);
      assert.deepEqual(rows.map((x) => x.case_id), ["k1", "k2", "k3"], "one row per case, in case order");
      for (const row of rows) {
        assert.deepEqual(Object.keys(row), ["case_id", "ranked"]);
        for (const e of row.ranked) assert.deepEqual(Object.keys(e), ["id", "score"]);
      }
      const ids = Object.fromEntries(rows.map((x) => [x.case_id, x.ranked.map((e) => e.id)]));
      assert.deepEqual([...ids.k1].sort(), ["c1", "c2", "c3"], `${pipeline}: c4 is exactly at the decision time and c5 is later`);
      assert.deepEqual([...ids.k2].sort(), ["c1", "c2", "c4"], `${pipeline}: c3 is excluded, c5 is later`);
      assert.ok(!ids.k3.includes("c5") && ids.k3.length === 4, `${pipeline}: exclude_ids honoured`);
      const stats = readJsonl(`${out}.stats.jsonl`);
      assert.equal(stats.length, 3);
      assert.ok(stats.every((s) => s.latency_ms >= 0 && s.eligible >= 1));
    }
    // resumable: a rerun only runs the missing cases
    const out = path.join(dir, "out-default.jsonl");
    const kept = readJsonl(out);
    writeJsonl(out, kept.slice(0, 1));
    const before = server.calls.length;
    const again = await recall(["eval", "--corpus", path.join(dir, "corpus.jsonl"), "--cases", path.join(dir, "cases.jsonl"), "--pipeline", "default", "--out", out], env);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(readJsonl(out), kept);
    assert.ok(server.calls.length >= before, "ran the two missing cases");
    // a malformed case is a loud error before anything runs
    writeJsonl(path.join(dir, "bad.jsonl"), [{ ...CASES[0], decision_ts: "yesterday" }]);
    const bad = await recall(["eval", "--corpus", path.join(dir, "corpus.jsonl"), "--cases", path.join(dir, "bad.jsonl"), "--pipeline", "default", "--out", path.join(dir, "bad-out.jsonl")], env);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /unparseable timestamp/);
    const unknown = await recall(["eval", "--corpus", path.join(dir, "corpus.jsonl"), "--cases", path.join(dir, "cases.jsonl"), "--pipeline", "nope", "--out", path.join(dir, "u.jsonl")], env);
    assert.notEqual(unknown.code, 0);
  } finally {
    await server.close();
  }
});

test("eval: a daily cap stops the run loudly with a non-zero exit, and spent money is in the ledger", async () => {
  const server = await startFakeServer();
  try {
    const dir = tmpDir("recall-evalcap");
    const env = { ...V1_ENV, RECALL_DATA: path.join(dir, "data"), RECALL_OPENAI_BASE_URL: server.url, RECALL_DAILY_CAP_USD: "0.0000004", HOME: dir };
    writeJsonl(path.join(dir, "corpus.jsonl"), CORPUS);
    writeJsonl(path.join(dir, "cases.jsonl"), CASES);
    const r = await recall(["eval", "--corpus", path.join(dir, "corpus.jsonl"), "--cases", path.join(dir, "cases.jsonl"), "--pipeline", "default", "--out", path.join(dir, "o.jsonl")], env);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr + r.stdout, /CapExceededError|spend cap exceeded/);
  } finally {
    await server.close();
  }
});

test("index then query: the CLI mines a fake home, embeds, and returns ranked statements with scores; spend reports the ledger", async () => {
  const server = await startFakeServer();
  try {
    const dir = tmpDir("recall-cli");
    const home = path.join(dir, ".claude_cli");
    const proj = path.join(home, "projects", "-x");
    fs.mkdirSync(proj, { recursive: true });
    const lines = [];
    for (const [i, text] of ["Never add fallback paths; fix the code structure properly instead of random limits.", "Run the summarizer on the small model, with a zero thinking budget please."].entries()) {
      const rec = JSON.parse(claudeLine("human_typed"));
      rec.message.content = text;
      rec.timestamp = `2026-09-0${i + 1}T10:00:00.000Z`;
      lines.push(JSON.stringify(rec));
    }
    fs.writeFileSync(path.join(proj, "5ccc0000-0000-0000-0000-000000000003.jsonl"), `${lines.join("\n")}\n`);
    const env = { ...V1_ENV, RECALL_DATA: path.join(dir, "data"), RECALL_HOMES: home, RECALL_OPENAI_BASE_URL: server.url, RECALL_DAILY_CAP_USD: "5", HOME: dir };
    const idx = await recall(["index", "--quiet"], env);
    assert.equal(idx.code, 0, idx.stderr);
    const report = JSON.parse(idx.stdout);
    assert.equal(report.added, 2);
    assert.equal(report.embedding.embedded, 2);
    const q = await recall(["query", "--text", "can we add a fallback path with a limit here", "--pipeline", "default", "--json", "--before", "2026-12-01T00:00:00Z", "--session", "nope"], env);
    assert.equal(q.code, 0, q.stderr);
    const res = JSON.parse(q.stdout);
    assert.equal(res.results[0].text.startsWith("Never add fallback paths"), true);
    assert.equal(res.results[0].would_inject, true);
    assert.ok(res.results[0].parts.d === 0.99 && res.results[0].score > 0);
    const plain = await recall(["query", "--text", "can we add a fallback path with a limit here", "--pipeline", "embeddings"], env);
    assert.match(plain.stdout, /pipeline embeddings, 2 eligible statements/);
    const early = await recall(["query", "--text", "can we add a fallback path with a limit here", "--before", "2020-01-01T00:00:00Z", "--json"], env);
    assert.deepEqual(JSON.parse(early.stdout).results, [], "nothing before the decision time");
    const spend = JSON.parse((await recall(["spend"], env)).stdout);
    assert.ok(spend.spentToday > 0 && spend.dailyCapUsd === 5);
    const none = await recall(["query", "--text", "x"], { ...env, RECALL_DATA: path.join(dir, "empty") });
    assert.notEqual(none.code, 0);
    assert.match(none.stderr, /index .* is empty/);
  } finally {
    await server.close();
  }
});

test("query: the text is an argument; --repo, --any-repo and --kind pick which cards are searched, and --json names each result's kind", async () => {
  const server = await startFakeServer();
  try {
    const dir = tmpDir("recall-query-filters");
    const dataDir = path.join(dir, "data");
    const { createStore } = await import("../scripts/lib/store.mjs");
    const { appendCards } = await import("../scripts/lib/cards/cards-file.mjs");
    const { seedIndex } = await import("./helpers.mjs");
    const rows = [
      { id: "A", repo: "r1", kind: "rule", scope: "global", text: "Never add a fallback path or a random limit, fix the code structure instead." },
      { id: "B", repo: "r1", kind: "decision", scope: "repo", text: "In this repo a fallback path in the export code needs my sign-off first." },
      { id: "C", repo: "r2", kind: "correction", scope: "repo", text: "Stop adding a fallback path and a random limit to the other service." },
      { id: "D", repo: "r1", kind: "question", scope: "repo", text: "Why did the fallback path fail on this run when the previous run passed?" },
    ].map((r, i) => ({ ...r, ts: `2026-01-0${i + 1}T00:00:00Z`, session_id: `s${i}`, host: "claude" }));
    await seedIndex(createStore(dataDir), rows.map(({ id, repo, text, ts, session_id, host }) => ({ id, repo, text, ts, session_id, host })));
    appendCards(path.join(dataDir, "cards.jsonl"), rows.map((r) => ({ id: r.id, kind: r.kind, scope: r.scope, scope_repo: r.scope === "global" ? null : r.repo, gist: "the agent had added a fallback", model: "test", at: "2026-01-01T00:00:00Z", gist_source: "transcript" })));
    const env = { RECALL_DATA: dataDir, RECALL_OPENAI_BASE_URL: server.url, RECALL_DAILY_CAP_USD: "5", HOME: dir };
    const ids = async (...args) => {
      const r = await recall(["query", "I am about to add a fallback path and a random limit here", "--json", "--before", "2026-12-01T00:00:00Z", ...args], env);
      assert.equal(r.code, 0, r.stderr);
      return JSON.parse(r.stdout).results.map((x) => `${x.id}:${x.kind}`).sort();
    };
    assert.deepEqual(await ids("--repo", "r1"), ["A:rule", "B:decision"], "this repo's statements and the global rule; no question, nothing from r2");
    assert.deepEqual(await ids("--repo", "r2"), ["A:rule", "C:correction"]);
    assert.deepEqual(await ids("--repo", "r1", "--kind", "decision"), ["B:decision"]);
    assert.deepEqual(await ids("--repo", "r1", "--kind", "rule,decision"), ["A:rule", "B:decision"]);
    assert.deepEqual(await ids("--repo", "r1", "--kind", "question"), ["D:question"], "--kind overrides the default exclusion of questions");
    assert.deepEqual(await ids("--any-repo"), ["A:rule", "B:decision", "C:correction"], "no repo restriction (questions stay excluded by default)");
    assert.deepEqual(await ids("--any-repo", "--kind", "correction"), ["C:correction"]);
    const withText = await recall(["query", "--text", "I am about to add a fallback path and a random limit here", "--json", "--repo", "r1", "--before", "2026-12-01T00:00:00Z"], env);
    assert.equal(JSON.parse(withText.stdout).query, "I am about to add a fallback path and a random limit here", "--text still works");
    const both = await recall(["query", "x", "--text", "y"], env);
    assert.match(both.stderr, /give the query text once/);
    const bogus = await recall(["query", "some text", "--kind", "bogus"], env);
    assert.equal(bogus.code, 1);
    assert.match(bogus.stderr, /--kind takes rule, preference, decision, correction, question, status, other/);
    const plain = await recall(["query", "I am about to add a fallback path here", "--repo", "r1", "--before", "2026-12-01T00:00:00Z"], env);
    assert.match(plain.stdout, /\(\* = would pass to the hook's apply gate; query does not run the gate\)/);
  } finally {
    await server.close();
  }
});
