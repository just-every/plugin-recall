// `recall enrich` and `recall index --enrich` as a user (and the background indexer) runs them: the real CLI, the real router and worker plumbing
// (roster, usage reader, CLAUDE_CONFIG_DIR, `--model haiku`, the JSON schema), with a stand-in `claude` binary on PATH and a stand-in
// `usage --json`. No network, no real model.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCards } from "../scripts/lib/cards/cards-file.mjs";
import { BATCH_SCHEMA } from "../scripts/lib/cards/schema.mjs";
import { claudeLine, startFakeServer, tmpDir } from "./helpers.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "recall.mjs");

/** A temp world: a roster with one eligible Claude home, `usage --json`, and a `claude` that answers batches by number and logs how it was called. */
function world({ usedPercent = 10, claudeBody } = {}) {
  const dir = tmpDir("recall-enrich-cli");
  const home = path.join(dir, ".claude_worker");
  fs.mkdirSync(home);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const callLog = path.join(dir, "claude-calls.jsonl");
  fs.writeFileSync(path.join(dir, "roster.json"), JSON.stringify([{ id: "worker", kind: "claude", home, protected: false, manual: false }, { id: "default", kind: "claude", home: path.join(dir, ".claude"), protected: true, manual: false }]));
  fs.writeFileSync(path.join(dir, "usage.mjs"), `console.log(JSON.stringify({ results: [{ path: ${JSON.stringify(home)}, windows: [{ label: "5h All", usedPercent: ${usedPercent} }] }] }));\n`);
  fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}
import fs from "node:fs";
const prompt = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ args: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR, recallChild: process.env.RECALL_CHILD, maxThinking: process.env.MAX_THINKING_TOKENS, prompt }) + "\\n");
${claudeBody ?? `
const n = Number(/exactly one entry for each of the (\\d+) numbered/.exec(prompt)[1]);
const cards = Array.from({ length: n }, (_, i) => ({ n: i + 1, kind: i % 2 ? "question" : "rule", scope: "global", gist: "the agent was in the middle of a task" }));
console.log(JSON.stringify({ is_error: false, result: "", structured_output: { cards } }));`}
`, { mode: 0o755 });
  const env = {
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, RECALL_DATA: path.join(dir, "data"), RECALL_AUTO_INDEX: "0",
    RECALL_HOMES_ROSTER: path.join(dir, "roster.json"), RECALL_USAGE_CMD: `${process.execPath} ${path.join(dir, "usage.mjs")}`, OPENAI_API_KEY: "sk-test",
  };
  return { dir, home, env, calls: () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}
function recall(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => { stdout += d; });
    c.stderr.on("data", (d) => { stderr += d; });
    c.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const statementRow = (i, over = {}) => ({ id: `claude-${i}`, text: `Always run the full test suite before you tell me it is done, rule ${i}.`, ts: `2026-09-0${i}T10:00:00.000Z`, session_id: `sess-${i}`, repo: "r", host: "claude", hash: `h${i}`, src: "test", ...over });
const seed = (env, rows) => { const d = env.RECALL_DATA; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "statements.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`); };

test("recall enrich: the worker is `claude -p --model haiku` with a JSON schema, under the eligible home the router picked, never the protected one", async () => {
  const w = world();
  seed(w.env, [1, 2, 3].map((i) => statementRow(i)));
  const r = await recall(["enrich"], w.env);
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual([report.pending, report.written, report.failed.length], [3, 3, 0]);
  assert.equal(report.out, path.join(w.env.RECALL_DATA, "cards.jsonl"));
  assert.match(r.stderr, new RegExp(`card writer: claude worker, home ${w.home} \\(10% used\\)`));
  const [call] = w.calls();
  assert.equal(call.configDir, w.home, "an explicit eligible home");
  assert.equal(call.recallChild, "1");
  assert.equal(call.maxThinking, "0", "no extended thinking for a card");
  assert.ok(call.args.includes("-p") && call.args[call.args.indexOf("--model") + 1] === "haiku");
  assert.deepEqual(JSON.parse(call.args[call.args.indexOf("--json-schema") + 1]), BATCH_SCHEMA);
  assert.ok(call.args.includes("--settings") && call.args.includes('{"disableAllHooks":true}'), "hooks are off in the worker");
  const cards = loadCards(path.join(w.env.RECALL_DATA, "cards.jsonl"));
  assert.deepEqual([...cards.values()].map((c) => [c.id, c.kind, c.model]), [["claude-1", "rule", "haiku"], ["claude-2", "question", "haiku"], ["claude-3", "rule", "haiku"]]);
  // incremental: a second run has nothing to do and starts no worker
  const again = JSON.parse((await recall(["enrich"], w.env)).stdout);
  assert.deepEqual([again.pending, again.written], [0, 0]);
  assert.equal(w.calls().length, 1);
  // --limit
  seed(w.env, [1, 2, 3, 4, 5, 6].map((i) => statementRow(i)));
  const limited = JSON.parse((await recall(["enrich", "--limit", "2"], w.env)).stdout);
  assert.deepEqual([limited.pending, limited.written], [2, 2]);
});

test("recall enrich with no eligible home (every one walled) fails before any call, naming why; a statement the model cannot card is listed and the exit code is non-zero", async () => {
  const walled = world({ usedPercent: 95 });
  seed(walled.env, [statementRow(1)]);
  const r = await recall(["enrich"], walled.env);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no claude worker home is eligible: every eligible claude home is walled, errored or needs auth/);
  assert.match(r.stderr, /5h All at 95% \(limit 90%\)/);
  assert.deepEqual(walled.calls(), []);

  const wrong = world({ claudeBody: 'console.log(JSON.stringify({ is_error: false, result: "", structured_output: { cards: [{ n: 1, kind: "chore", scope: "global", gist: "x" }] } }));' });
  seed(wrong.env, [statementRow(1)]);
  const bad = await recall(["enrich"], wrong.env);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /ERROR: no card for claude-1 after 2 attempts: kind "chore"/);
  assert.equal(wrong.calls().length, 2);
  assert.equal(JSON.parse(bad.stdout).failed[0].id, "claude-1");
  assert.equal(fs.existsSync(path.join(wrong.env.RECALL_DATA, "cards.jsonl")), false, "no card was invented");
});

test("recall enrich --corpus writes beside, not into, the live cards and matches the live index", async () => {
  const w = world();
  const corpus = path.join(w.dir, "contract.jsonl");
  fs.writeFileSync(corpus, `${[{ id: "k1", text: "Never push without asking.", ts: "2026-09-01T10:00:00Z", session_id: "z", repo: "r", host: "claude" }].map((x) => JSON.stringify(x)).join("\n")}\n`);
  seed(w.env, [statementRow(1)]);
  const r = await recall(["enrich", "--corpus", corpus], w.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).out, path.join(w.env.RECALL_DATA, "cards-contract.jsonl"));
  assert.equal(fs.existsSync(path.join(w.env.RECALL_DATA, "cards.jsonl")), false);
  const explicit = path.join(w.dir, "mine.jsonl");
  const e = await recall(["enrich", "--corpus", corpus, "--out", explicit], w.env);
  assert.equal(JSON.parse(e.stdout).out, explicit);
  assert.equal(loadCards(explicit).get("k1").gist_source, "none");
});

test("recall index --enrich (what the background indexer runs): index and embed, release the index lock, then write the new statements' cards from their transcripts", async () => {
  const server = await startFakeServer();
  try {
    const w = world();
    const proj = path.join(w.dir, ".claude_mined", "projects", "-x");
    fs.mkdirSync(proj, { recursive: true });
    const lines = ["Never add fallback paths; fix the code structure properly instead of random limits.", "Run the summarizer on the small model, with a zero thinking budget please."].map((text, i) => {
      const rec = JSON.parse(claudeLine("human_typed"));
      rec.message.content = text;
      rec.timestamp = `2026-09-0${i + 1}T10:00:00.000Z`;
      return JSON.stringify(rec);
    });
    fs.writeFileSync(path.join(proj, "5ccc0000-0000-0000-0000-000000000003.jsonl"), `${lines.join("\n")}\n`);
    const env = { ...w.env, RECALL_HOMES: path.join(w.dir, ".claude_mined"), RECALL_OPENAI_BASE_URL: server.url, RECALL_DAILY_CAP_USD: "5" };
    const r = await recall(["index", "--quiet", "--enrich"], env);
    assert.equal(r.code, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.added, 2);
    assert.deepEqual([report.enrich.pending, report.enrich.written, report.enrich.failed.length], [2, 2, 0]);
    assert.ok(!fs.existsSync(path.join(env.RECALL_DATA, "state", "index.lock")), "the index lock is released");
    const cards = loadCards(path.join(env.RECALL_DATA, "cards.jsonl"));
    assert.equal(cards.size, 2);
    assert.deepEqual([...cards.values()].map((c) => c.gist_source), ["none", "transcript"], "the first message of the session has nothing before it; the second has the first");
    const prompt = w.calls()[0].prompt;
    assert.ok(prompt.includes('Statement: "Run the summarizer on the small model'));
    assert.ok(prompt.includes('Previous owner message: "Never add fallback paths'), "read from the transcript the statement's src points at");
    // without --enrich the index makes no card and calls no worker
    const plain = await recall(["index", "--quiet"], { ...env, RECALL_DATA: path.join(w.dir, "data2") });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(JSON.parse(plain.stdout).enrich, undefined);
    assert.equal(w.calls().length, 1);
  } finally {
    await server.close();
  }
});

/** Add an eligible codex home (and a stand-in `codex`) to a world; `claudeNeedsAuth` signs the Claude home out. */
function addCodexWorker(w, { claudeNeedsAuth = true } = {}) {
  const codexHome = path.join(w.dir, ".codex_worker");
  fs.mkdirSync(codexHome);
  const codexCalls = path.join(w.dir, "codex-calls.jsonl");
  fs.writeFileSync(path.join(w.dir, "roster.json"), JSON.stringify([
    { id: "cx", kind: "codex", home: codexHome, protected: false, manual: false },
    { id: "cx-owner", kind: "codex", home: path.join(w.dir, ".codex"), protected: true, manual: false },
    { id: "cl", kind: "claude", home: w.home, protected: false, manual: false },
  ]));
  const claudeRow = claudeNeedsAuth ? `{ path: ${JSON.stringify(w.home)}, needsAuth: true, windows: [] }` : `{ path: ${JSON.stringify(w.home)}, windows: [{ label: "5h All", usedPercent: 10 }] }`;
  fs.writeFileSync(path.join(w.dir, "usage.mjs"), `console.log(JSON.stringify({ results: [{ path: ${JSON.stringify(codexHome)}, windows: [{ label: "1w", usedPercent: 5 }] }, ${claudeRow}] }));\n`);
  fs.writeFileSync(path.join(w.dir, "bin", "codex"), `#!${process.execPath}
import fs from "node:fs";
const prompt = fs.readFileSync(0, "utf8");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(codexCalls)}, JSON.stringify({ args, codexHome: process.env.CODEX_HOME, recallChild: process.env.RECALL_CHILD, schema: fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8") }) + "\\n");
const n = Number(/exactly one entry for each of the (\\d+) numbered/.exec(prompt)[1]);
const cards = Array.from({ length: n }, (_, i) => ({ n: i + 1, kind: "decision", scope: "repo", gist: "the agent was in the middle of a task" }));
fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ cards }));
`, { mode: 0o755 });
  return { codexHome, codexCalls: () => (fs.existsSync(codexCalls) ? fs.readFileSync(codexCalls, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

test("recall enrich --worker codex: the card writer is `codex exec` with the output schema under the eligible codex home, never the protected one; the card names the worker as its model", async () => {
  const w = world();
  const cx = addCodexWorker(w);
  seed(w.env, [1, 2].map((i) => statementRow(i)));
  const r = await recall(["enrich", "--worker", "codex"], w.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`card writer: codex worker, home ${cx.codexHome} \\(5% used\\)`));
  const [call] = cx.codexCalls();
  assert.equal(call.codexHome, cx.codexHome);
  assert.equal(call.recallChild, "1");
  assert.ok(call.args.includes("--disable") && call.args.includes("hooks"), "hooks are off in the worker");
  assert.ok(!call.args.includes("-m"), "no model flag: codex's own default");
  assert.deepEqual(JSON.parse(call.schema), BATCH_SCHEMA);
  assert.deepEqual([...loadCards(path.join(w.env.RECALL_DATA, "cards.jsonl")).values()].map((c) => [c.kind, c.model]), [["decision", "codex"], ["decision", "codex"]]);
  assert.deepEqual(w.calls(), [], "no claude worker ran");
  const bad = await recall(["enrich", "--worker", "gemini"], w.env);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /--worker must be auto, claude or codex/);
});

test("recall enrich (--worker auto is the default): haiku through an eligible Claude home when there is one, otherwise codex through an eligible codex home", async () => {
  // a Claude home is eligible: haiku, and codex is never started
  const both = world();
  const cxBoth = addCodexWorker(both, { claudeNeedsAuth: false });
  seed(both.env, [1, 2].map((i) => statementRow(i)));
  const a = await recall(["enrich"], both.env);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(JSON.parse(a.stdout).worker, "claude");
  assert.match(a.stderr, /card writer: claude worker/);
  assert.equal(both.calls().length, 1);
  assert.ok(both.calls()[0].args.includes("haiku"));
  assert.deepEqual(cxBoth.codexCalls(), []);
  // the Claude home is signed out: the codex worker writes the cards, and the log says why
  const only = world();
  const cx = addCodexWorker(only);
  seed(only.env, [1, 2].map((i) => statementRow(i)));
  const b = await recall(["enrich"], only.env);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(JSON.parse(b.stdout).worker, "codex");
  assert.match(b.stderr, new RegExp(`card writer: codex worker, home ${cx.codexHome} \\(5% used\\); no claude worker home is eligible: every eligible claude home is walled, errored or needs auth`));
  assert.equal(cx.codexCalls().length, 1);
  assert.deepEqual(only.calls(), [], "no claude worker ran");
  assert.deepEqual([...loadCards(path.join(only.env.RECALL_DATA, "cards.jsonl")).values()].map((c) => c.model), ["codex", "codex"]);
  // the background indexer (`recall index --enrich`) takes the same choice
  const idx = world();
  const cxIdx = addCodexWorker(idx);
  seed(idx.env, [1].map((i) => statementRow(i)));
  const c = await recall(["index", "--no-embed", "--enrich"], { ...idx.env, RECALL_HOMES: path.join(idx.dir, ".claude_empty") });
  assert.equal(c.code, 0, c.stderr);
  assert.equal(cxIdx.codexCalls().length, 1, "index --enrich wrote its cards with codex");
});

test("recall enrich (auto) with neither kind eligible fails before any call and names why for both", async () => {
  const w = world({ usedPercent: 99 });
  seed(w.env, [1].map((i) => statementRow(i)));
  const r = await recall(["enrich"], w.env);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no claude worker home is eligible: every eligible claude home is walled, errored or needs auth .*5h All at 99%.*; no codex worker home is eligible: no eligible codex home in the roster/);
  assert.deepEqual(w.calls(), []);
});
