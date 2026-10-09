// `recall eval` for the v1/v2 comparison: per-case context, --cards, --inject-out, and the flags that switch behaviour. No network: the fake
// OpenAI (in process, or over HTTP for the CLI) answers.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendCards } from "../scripts/lib/cards/cards-file.mjs";
import { buildCard } from "../scripts/lib/cards/schema.mjs";
import { CARD_HEADER, CONTEXT_HEADER } from "../scripts/lib/context.mjs";
import { loadConfig, V1_ENV } from "../scripts/lib/config.mjs";
import { runEval, validateCase } from "../scripts/lib/eval.mjs";
import { caseQuery, ownerMessageOf } from "../scripts/lib/eval-situation.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { contextSituation, promptSituation, PROMPT_HEAD, STOP_HEAD } from "../scripts/lib/situations.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { fakeOpenAI, startFakeServer, tmpDir } from "./helpers.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "recall.mjs");
const AT = "2026-10-08T12:00:00.000Z";
const writeJsonl = (file, rows) => fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
const readJsonl = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const rows = [
  { id: "g1", text: "Never add a fallback path or a random limit, fix the code structure instead.", ts: "2026-01-01T00:00:00Z", session_id: "A", repo: "shared-lib", host: "claude", card: { kind: "rule", scope: "global", gist: "the agent had just added a fallback path" } },
  { id: "d1", text: "In this repo the replay code may not get a fallback path without my sign-off.", ts: "2026-01-02T00:00:00Z", session_id: "A", repo: "billing-api", host: "claude", card: { kind: "decision", scope: "repo", gist: "the agent was changing the replay code" } },
  { id: "c1", text: "Never push in this repo, a fallback path is no reason to push.", ts: "2026-01-03T00:00:00Z", session_id: "B", repo: "payments", host: "codex", card: { kind: "rule", scope: "repo", gist: "the agent had pushed a hotfix" } },
  { id: "q1", text: "Why did the fallback path fail on this run when the previous run passed?", ts: "2026-01-04T00:00:00Z", session_id: "B", repo: "billing-api", host: "claude", card: { kind: "question", scope: "repo", gist: "the agent reported a failed run" } },
  { id: "p1", text: "I prefer a simple code structure over a fallback path every time.", ts: "2026-01-05T00:00:00Z", session_id: "C", repo: "billing-api", host: "code", card: { kind: "preference", scope: "global", gist: "the agent offered two ways to fix it" } },
];
const MESSAGE = "I will add a fallback path with a random limit to stop the duplicate draft runs.";
const EARLIER = "Please look at why the draft runs are duplicated.";
const REPLY = "The duplicates come from a re-execution path in the worker. Remove it or guard it?";
const PRIOR = [{ role: "user", text: EARLIER }, { role: "assistant", text: REPLY }];
const cases = [
  { case_id: "k1", mode: "prompt", query: MESSAGE, decision_ts: "2026-02-01T00:00:00Z", session_id: "Z", exclude_ids: [], context: { project: "billing-api", prior: PRIOR } },
  { case_id: "k2", mode: "prompt", query: `${PROMPT_HEAD}\n\nOWNER: ${MESSAGE}`, decision_ts: "2026-02-01T00:00:00Z", session_id: "Z", exclude_ids: [], context: { project: "payments", prior: [{ role: "owner", text: EARLIER }] } },
  { case_id: "k3", mode: "prompt", query: MESSAGE, decision_ts: "2026-02-01T00:00:00Z", session_id: "Z", exclude_ids: [] },
  { case_id: "k4", mode: "stop", query: `${STOP_HEAD}\n\nASSISTANT (latest message): ${MESSAGE}`, decision_ts: "2026-02-01T00:00:00Z", session_id: "Z", exclude_ids: [], context: { project: "billing-api" } },
];

function files() {
  const dir = tmpDir("recall-eval-v2");
  writeJsonl(path.join(dir, "corpus.jsonl"), rows.map(({ card, ...r }) => r));
  writeJsonl(path.join(dir, "cases.jsonl"), cases);
  const cardsFile = path.join(dir, "cards.jsonl");
  appendCards(cardsFile, rows.map((r) => buildCard({ statement: r, entry: { n: 1, ...r.card }, model: "haiku", at: AT, gistSource: "index" })));
  return { dir, corpusPath: path.join(dir, "corpus.jsonl"), casesPath: path.join(dir, "cases.jsonl"), cardsFile, outPath: path.join(dir, "out.jsonl"), injectOutPath: path.join(dir, "inject.jsonl") };
}
async function evaluate(over = {}, env = {}) {
  const f = files();
  const config = loadConfig({ RECALL_DATA: path.join(f.dir, "data"), RECALL_DAILY_CAP_USD: "5", ...env });
  const fake = fakeOpenAI({ decide: () => 0.99 });
  const runtime = createRuntime(config, { post: fake.post });
  const result = await runEval({ ...f, pipeline: "default", config, runtime, store: createStore(path.join(f.dir, "eval-store")), concurrency: 1, ...over });
  return { ...f, config, fake, result, out: readJsonl(f.outPath), inject: fs.existsSync(f.injectOutPath) ? readJsonl(f.injectOutPath) : null };
}
const byCase = (rows_) => Object.fromEntries(rows_.map((r) => [r.case_id, r]));

test("a case's context builds the v2 situation (the hook's own function); a bare query and x3's prompt layout both work; other cases keep their query", () => {
  const cfg = loadConfig({});
  const expected = contextSituation({ project: "billing-api", prevOwner: EARLIER, assistant: REPLY, ownerText: MESSAGE });
  assert.equal(caseQuery(cases[0], cfg), expected);
  assert.equal(expected, `${STOP_HEAD}\n\nPROJECT: billing-api\n\nOWNER (earlier): ${EARLIER}\n\nASSISTANT: ${REPLY}\n\nOWNER (latest message, before the agent has acted): ${MESSAGE}`);
  assert.equal(caseQuery(cases[1], cfg), contextSituation({ project: "payments", prevOwner: EARLIER, ownerText: MESSAGE }), "'owner' is a user turn; the OWNER line of x3's layout is the message");
  assert.equal(caseQuery(cases[2], cfg), MESSAGE, "no context: the query as it was (v1 wraps it)");
  assert.equal(caseQuery(cases[3], cfg), cases[3].query, "a stop-mode case keeps its situation");
  assert.equal(caseQuery(cases[0], loadConfig(V1_ENV)), MESSAGE, "queryContext off: context ignored");
  assert.equal(ownerMessageOf(promptSituation("hello"), "c"), "hello");
  assert.throws(() => ownerMessageOf(`${STOP_HEAD}\n\nASSISTANT (latest message): x`, "k9"), /case k9: the query is a situation that is not the prompt-time layout/);
});

test("context is validated: a malformed context is a loud error naming the case", () => {
  const ok = { ...cases[0] };
  validateCase(ok, 0);
  const bad = (context, re) => assert.throws(() => validateCase({ ...ok, context }, 0), re);
  bad("billing-api", /case k1: context must be an object/);
  bad({ project: 5 }, /project must be a repo name/);
  bad({ prior: "x" }, /prior must be an array/);
  bad({ prior: [{ role: "robot", text: "x" }] }, /prior\[0\] must be \{role: user\|owner\|assistant, text/);
  bad({ prior: [{ role: "user", text: " " }] }, /prior\[0\]/);
  validateCase({ ...ok, context: undefined }, 0);
});

test("v2.1: scope from the case's project, excluded kinds, the card format in --inject-out; the output file keeps the contract", async () => {
  const e = await evaluate({ cardsFile: undefined, injectOutPath: undefined }, {}).catch((err) => err);
  assert.match(e.message, /this configuration needs statement cards .*pass --cards <cards.jsonl>, or --v1/, "v2 without cards is a loud error");
  const r = await evaluate();
  assert.deepEqual(r.result, { cases: 4, written: 4, failed: 0, notRun: 0 });
  for (const row of r.out) assert.deepEqual(Object.keys(row), ["case_id", "ranked"]);
  const ids = (id) => byCase(r.out)[id].ranked.map((x) => x.id).sort();
  assert.deepEqual(ids("k1"), ["d1", "g1", "p1"], "billing-api: global + its own directives; no other repo's, no question");
  assert.deepEqual(ids("k2"), ["c1", "g1", "p1"], "payments");
  assert.deepEqual(ids("k3"), ["g1", "p1"], "no project: only what holds everywhere");
  const inj = byCase(r.inject);
  assert.deepEqual(inj.k1.situation, caseQuery(cases[0], r.config));
  assert.equal(inj.k3.situation, promptSituation(MESSAGE), "the situation is recorded as it was sent");
  assert.equal(inj.k1.current_repo, "billing-api");
  for (const id of ["k1", "k2", "k3"]) {
    const row = inj[id];
    assert.deepEqual(Object.keys(row).slice(0, 5), ["case_id", "mode", "current_repo", "situation", "ranked"]);
    assert.ok(row.ranked.every((x) => typeof x.id === "string" && typeof x.score === "number" && x.d === 0.99), "the ranking carries the judge's probability");
    assert.deepEqual(row.ranked.map((x) => x.id), byCase(r.out)[id].ranked.map((x) => x.id), "same ranking as the output file");
    assert.equal(row.picked.length, Math.min(3, ids(id).length), "k = 3");
    assert.ok(row.context.startsWith(`<recall-context>\n${CARD_HEADER}\n• `) && row.context.endsWith("\n</recall-context>"));
    assert.equal(row.context.split("\n").filter((l) => l.startsWith("• ")).length, row.picked.length);
    for (const pid of row.picked) assert.ok(row.context.includes(`"${rows.find((x) => x.id === pid).text}"`));
  }
  assert.ok(inj.k1.context.includes("this repo (billing-api)") && inj.k1.context.includes("all projects"));
  assert.ok(inj.k1.context.includes("(said 1 Jan, the agent had just added a fallback path)") || inj.k1.context.includes("(said 5 Jan, the agent offered two ways to fix it)"));
  // the judge was asked with k1's context-rich situation, and without the gist (itemGist is off by default)
  const bodies = r.fake.calls.filter((c) => c.pathname === "/v1/decisions").map((c) => c.body);
  assert.ok(bodies.some((b) => b.input === caseQuery(cases[0], r.config)));
  assert.ok(bodies.every((b) => b.questions.every((q) => !q.instructions.includes("(said while "))));
  // with itemGist on, every question carries it
  const gist = await evaluate({}, { RECALL_ITEM_GIST: "1" });
  assert.ok(gist.fake.calls.filter((c) => c.pathname === "/v1/decisions").every((c) => c.body.questions.every((q) => q.instructions.includes("(said while "))));
});

test("v1 (the flags at their v1 values): no cards needed, context ignored, v1's questions and block - the comparison's baseline", async () => {
  const r = await evaluate({ cardsFile: null }, V1_ENV);
  const ids = (id) => byCase(r.out)[id].ranked.map((x) => x.id).sort();
  assert.deepEqual(ids("k1"), ["c1", "d1", "g1", "p1", "q1"], "every statement before the decision time, whatever repo or kind");
  const inj = byCase(r.inject);
  assert.equal(inj.k1.situation, promptSituation(MESSAGE));
  assert.equal(inj.k1.picked.length, 5, "k = 5");
  assert.ok(inj.k1.context.includes(CONTEXT_HEADER) && /- 2026-01-0\d \(repo: /.test(inj.k1.context));
  assert.ok(!inj.k1.context.includes("said while"));
  const bodies = r.fake.calls.filter((c) => c.pathname === "/v1/decisions").map((c) => c.body);
  assert.ok(bodies.every((b) => b.questions.every((q) => /^Past owner statement: ".*"\n/s.test(q.instructions))));
  // cards given to a v1 run are inert
  const withCards = await evaluate({}, V1_ENV);
  assert.deepEqual(withCards.out, r.out);
  assert.deepEqual(withCards.inject.map((x) => x.context), r.inject.map((x) => x.context));
});

test("--inject-out is resumable: a case with a ranking but no injection line is run again, the files end complete and in case order", async () => {
  const r = await evaluate();
  const dropped = r.inject.filter((x) => x.case_id !== "k2");
  writeJsonl(r.injectOutPath, dropped);
  const config = loadConfig({ RECALL_DATA: path.join(r.dir, "data"), RECALL_DAILY_CAP_USD: "5" });
  const again = await runEval({ corpusPath: r.corpusPath, casesPath: r.casesPath, pipeline: "default", outPath: r.outPath, cardsFile: r.cardsFile, injectOutPath: r.injectOutPath, config, runtime: createRuntime(config, { post: fakeOpenAI({ decide: () => 0.99 }).post }), store: createStore(path.join(r.dir, "eval-store")), concurrency: 1 });
  assert.equal(again.written, 4);
  assert.deepEqual(readJsonl(r.injectOutPath), r.inject);
  assert.deepEqual(readJsonl(r.outPath), r.out);
});

// ---- the CLI ----
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

test("recall eval --cards --inject-out --v1/--v2, as a user runs it", async () => {
  const server = await startFakeServer({ decide: () => 0.99 });
  try {
    const f = files();
    // the environment says v1; the command line says v2: the command line wins
    const env = { ...V1_ENV, RECALL_DATA: path.join(f.dir, "data"), RECALL_OPENAI_BASE_URL: server.url, RECALL_DAILY_CAP_USD: "5", HOME: f.dir };
    const base = ["eval", "--corpus", f.corpusPath, "--cases", f.casesPath, "--pipeline", "default"];
    const v2 = await recall([...base, "--out", f.outPath, "--cards", f.cardsFile, "--inject-out", f.injectOutPath, "--v2"], env);
    assert.equal(v2.code, 0, v2.stderr);
    assert.match(v2.stderr, /5 of 5 corpus items have a card/);
    const inj = byCase(readJsonl(f.injectOutPath));
    assert.ok(inj.k1.context.includes(CARD_HEADER));
    // and the other way round: v2 in the environment, --v1 on the command line, no cards
    const out1 = path.join(f.dir, "out-v1.jsonl");
    const inject1 = path.join(f.dir, "inject-v1.jsonl");
    const v1 = await recall([...base, "--out", out1, "--inject-out", inject1, "--v1"], { ...env, RECALL_EXCLUDE_KINDS: "question,status", RECALL_K: "3" });
    assert.equal(v1.code, 0, v1.stderr);
    assert.ok(byCase(readJsonl(inject1)).k1.context.includes(CONTEXT_HEADER));
    // the configuration's behaviour without any flag: v2 needs cards
    const noCards = await recall([...base, "--out", path.join(f.dir, "o3.jsonl")], { ...env, RECALL_EXCLUDE_KINDS: "question,status", RECALL_SCOPE_FILTER: "1", RECALL_ITEM_GIST: "1" });
    assert.notEqual(noCards.code, 0);
    assert.match(noCards.stderr, /pass --cards/);
    const both = await recall([...base, "--out", path.join(f.dir, "o4.jsonl"), "--v1", "--v2"], env);
    assert.match(both.stderr, /--v1 and --v2 are exclusive/);
  } finally {
    await server.close();
  }
});
