// Hub suppression: the pure rule, the live index (built from the turn logs, updated on each injection), the hook, and the eval's explicit history.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appendCards, cardsPath } from "../scripts/lib/cards/cards-file.mjs";
import { buildCard } from "../scripts/lib/cards/schema.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runEval } from "../scripts/lib/eval.mjs";
import { parseHookInput } from "../scripts/lib/hook-io.mjs";
import { createHubIndex, entriesFromLogs, hubIndexPath } from "../scripts/lib/hub-index.mjs";
import { DAY_MS, hubIds } from "../scripts/lib/hubs.mjs";
import { selectInjection } from "../scripts/lib/injection.mjs";
import { handlePrompt } from "../scripts/lib/prompt-hook.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { fakeOpenAI, readFixture, seedIndex, tmpDir } from "./helpers.mjs";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const row = (id, session_id, daysAgo) => ({ id, session_id, ts: new Date(T0 - daysAgo * DAY_MS).toISOString() });
const rule = { nowMs: T0, windowDays: 14, maxSessions: 3 };

test("hubIds: a statement injected into maxSessions distinct other sessions within the window is a hub", () => {
  const h = [row("hub", "s1", 1), row("hub", "s2", 2), row("hub", "s3", 3), row("two", "s1", 1), row("two", "s2", 1)];
  assert.deepEqual([...hubIds(h, { ...rule, sessionId: "me" })], ["hub"]);
  assert.deepEqual([...hubIds(h, { ...rule, sessionId: "me", maxSessions: 2 })].sort(), ["hub", "two"]);
  assert.deepEqual([...hubIds(h, { ...rule, sessionId: "me", maxSessions: 0 })], [], "0 is off");
});

test("hubIds: the current session does not count (noRepeat's business), a session counts once, the window and the future are respected", () => {
  assert.deepEqual([...hubIds([row("x", "s1", 1), row("x", "s2", 1), row("x", "me", 1)], { ...rule, sessionId: "me" })], [], "two other sessions plus mine is two");
  assert.deepEqual([...hubIds([row("x", "s1", 1), row("x", "s1", 2), row("x", "s1", 3), row("x", "s2", 1)], { ...rule, sessionId: "me" })], [], "the same session three times is one session");
  assert.deepEqual([...hubIds([row("x", "s1", 1), row("x", "s2", 1), row("x", "s3", 14.5)], { ...rule, sessionId: "me" })], [], "older than the window");
  assert.deepEqual([...hubIds([row("x", "s1", 1), row("x", "s2", 1), row("x", "s3", 13.5)], { ...rule, sessionId: "me" })], ["x"], "inside it");
  assert.deepEqual([...hubIds([row("x", "s1", 1), row("x", "s2", 1), row("x", "s3", -1)], { ...rule, sessionId: "me" })], [], "a replay does not see its own future");
  // times are parsed, not compared as strings: ".5Z" is earlier than "01Z" although "5" sorts after "0"
  const at = Date.parse("2026-10-01T12:00:01Z");
  const h = [{ id: "x", session_id: "s1", ts: "2026-10-01T12:00:00.500Z" }, { id: "x", session_id: "s2", ts: "2026-10-01T12:00:00.600000Z" }, { id: "x", session_id: "s3", ts: "2026-10-01T12:00:00.999Z" }];
  assert.deepEqual([...hubIds(h, { ...rule, nowMs: at, sessionId: "me" })], ["x"]);
  assert.throws(() => hubIds([{ id: "x", session_id: "s", ts: "yesterday" }], { ...rule, sessionId: "me" }), /unparseable timestamp/);
});

// ---- the live index ----
const logLine = (ts, session_id, injected, over = {}) => JSON.stringify({ ts, level: "info", event: "prompt", session_id, outcome: injected.length ? "injected" : "silent", injected, ...over });
const writeLog = (dataDir, day, lines) => { fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true }); fs.writeFileSync(path.join(dataDir, "logs", `turns-${day}.jsonl`), `${lines.join("\n")}\n`); };

test("the hub index is built once from the turn logs of the window, then kept up to date by the hook", () => {
  const dataDir = tmpDir("recall-hub-index");
  let now = new Date("2026-10-08T12:00:00Z");
  writeLog(dataDir, "2026-10-07", [logLine("2026-10-07T10:00:00.000Z", "s1", ["a", "b"]), logLine("2026-10-07T11:00:00.000Z", "s2", ["a"]), logLine("2026-10-07T11:30:00.000Z", "s3", [], { reason: "nothing" })]);
  writeLog(dataDir, "2026-10-05", [logLine("2026-10-05T10:00:00.000Z", "s3", ["a"]), "{ not json yet", logLine("2026-10-05T10:01:00.000Z", "s4", ["z"], { event: "stop" })]);
  writeLog(dataDir, "2026-09-01", [logLine("2026-09-01T10:00:00.000Z", "s9", ["a"])]); // outside the window
  const index = createHubIndex({ dataDir, windowDays: 14, now: () => now });
  assert.equal(fs.existsSync(hubIndexPath(dataDir)), false, "no file yet: the first read builds from the logs");
  assert.deepEqual([...index.suppressed({ sessionId: "me", maxSessions: 3 })], ["a"], "a: s1, s2, s3 (s9 is too old; the stop event and the torn line are not injections)");
  assert.deepEqual([...index.suppressed({ sessionId: "s3", maxSessions: 3 })], [], "from s3's own point of view only two other sessions said it");
  // the hook records an injection: the file now exists and carries it
  index.record({ sessionId: "me", ids: ["b"] });
  assert.ok(fs.existsSync(hubIndexPath(dataDir)));
  const file = JSON.parse(fs.readFileSync(hubIndexPath(dataDir), "utf8"));
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.entries.a).sort(), ["s1", "s2", "s3"]);
  assert.deepEqual(Object.keys(file.entries.b).sort(), ["me", "s1"]);
  // a file that exists is used as is, even when the logs say more
  writeLog(dataDir, "2026-10-08", [logLine("2026-10-08T09:00:00.000Z", "s5", ["a", "q"])]);
  assert.ok(!("q" in JSON.parse(fs.readFileSync(hubIndexPath(dataDir), "utf8")).entries));
  // pruning: records older than the window drop out on the next write
  now = new Date("2026-10-30T12:00:00Z");
  index.record({ sessionId: "late", ids: ["c"] });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(hubIndexPath(dataDir), "utf8")).entries), ["c"]);
  const rebuilt = entriesFromLogs(dataDir, { sinceMs: Date.parse("2026-10-06T00:00:00Z"), nowMs: Date.parse("2026-10-08T12:00:00Z") });
  assert.deepEqual(Object.keys(rebuilt.a).sort(), ["s1", "s2", "s5"], "a log rebuild keeps the window: s3 (5 Oct) is before it");
  // a damaged file is a loud error naming the way out, never a silent rebuild
  fs.writeFileSync(hubIndexPath(dataDir), "{");
  assert.throws(() => index.suppressed({ sessionId: "x", maxSessions: 3 }), /hub index .* is not valid JSON \(delete it to rebuild it from the turn logs\)/);
  fs.writeFileSync(hubIndexPath(dataDir), JSON.stringify({ version: 2, entries: {} }));
  assert.throws(() => index.record({ sessionId: "x", ids: ["a"] }), /not a version 1 index/);
});

// ---- the choice ----
const corpusOf = (ids) => {
  const items = ids.map((id, i) => ({ id, text: `Distinct statement number ${i} about ${id}`, ts: "2026-09-01T10:00:00.000Z", session_id: "old", repo: "r", card: { kind: "rule", scope: "global", gist: "g" } }));
  return { items, byId: new Map(items.map((it, i) => [it.id, i])) };
};
const rankedOf = (ids) => ids.map((id, i) => ({ id, score: 1 - i / 100, parts: { d: 0.99 } }));

test("selectInjection: a hub is dropped before the k cut, so the next statement takes its slot; the dropped ids are reported", () => {
  const corpus = corpusOf(["a", "b", "c", "d"]);
  const cfg = loadConfig({ RECALL_K: "2", RECALL_PROMPT_THRESHOLD: "0.5" });
  const plain = selectInjection({ ranked: rankedOf(["a", "b", "c", "d"]), corpus, pipeline: "default", cfg, currentRepo: "r" });
  assert.deepEqual(plain.picked.map((e) => e.id), ["a", "b"]);
  assert.deepEqual(plain.hubs, []);
  const hub = selectInjection({ ranked: rankedOf(["a", "b", "c", "d"]), corpus, pipeline: "default", cfg, currentRepo: "r", hubIds: new Set(["a", "c"]) });
  assert.deepEqual(hub.picked.map((e) => e.id), ["b", "d"]);
  assert.deepEqual(hub.hubs, ["a", "c"]);
  assert.ok(!hub.context.includes("about a") && hub.context.includes("about b"));
  const off = selectInjection({ ranked: rankedOf(["a", "b", "c", "d"]), corpus, pipeline: "default", cfg: loadConfig({ RECALL_K: "2", RECALL_PROMPT_THRESHOLD: "0.5", RECALL_HUB_MAX_SESSIONS: "0" }), currentRepo: "r", hubIds: new Set(["a"]) });
  assert.deepEqual(off.picked.map((e) => e.id), ["a", "b"], "hubMaxSessions 0: the set is ignored");
});

// ---- the hook ----
const hookInput = (over) => parseHookInput({ stdin: JSON.stringify({ ...JSON.parse(readFixture("hook-inputs", "claude-prompt.json")), ...over }) });
const PROMPT = "I will add a fallback path with a random limit to stop the duplicate draft runs.";
const AT = "2026-10-08T12:00:00.000Z";
const ROWS = [
  { id: "g1", ts: "2026-09-01T10:00:00.000Z", text: "Never add a fallback path or a random limit, fix the code structure instead.", card: { kind: "rule", scope: "global", gist: "the agent added a fallback path" } },
  { id: "g2", ts: "2026-09-02T10:00:00.000Z", text: "I prefer a proper fix over a fallback path: keep the code structure simple.", card: { kind: "preference", scope: "global", gist: "two ways to fix the duplicate runs" } },
];
async function hookWorld(env = {}) {
  const dataDir = tmpDir("recall-hub-hook");
  const config = loadConfig({ RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_ALLOW_HEADLESS: "1", RECALL_DAILY_CAP_USD: "5", RECALL_K: "1", ...env });
  const runtime = createRuntime(config, { post: fakeOpenAI({ decide: () => 0.99 }).post });
  await seedIndex(runtime.store, ROWS.map(({ card, ...r }) => r));
  appendCards(cardsPath(dataDir), ROWS.map((r) => buildCard({ statement: r, entry: { n: 1, ...r.card }, model: "haiku", at: AT, gistSource: "transcript" })));
  let now = new Date("2026-10-08T12:00:00Z");
  const turn = async (session) => {
    now = new Date(now.getTime() + 60_000); // a clock that moves: a record made at exactly "now" is not yet history
    await handlePrompt({ input: hookInput({ prompt: PROMPT, session_id: session }), config, runtime, now: () => now });
    const dir = path.join(dataDir, "logs");
    return fs.readdirSync(dir).filter((f) => f.startsWith("turns-")).sort().flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map(JSON.parse)).at(-1);
  };
  return { dataDir, turn, advanceDays: (d) => { now = new Date(now.getTime() + d * DAY_MS); } };
}

test("the hook: a statement said into three other sessions is not said into a fourth; the slot goes to the next; the log names the hub", async () => {
  const w = await hookWorld();
  const first = [];
  for (const s of ["s1", "s2", "s3"]) first.push((await w.turn(s)).injected);
  assert.deepEqual(first, [["g1"], ["g1"], ["g1"]], "k 1: the best statement each time");
  const fourth = await w.turn("s4");
  assert.deepEqual(fourth.injected, ["g2"], "g1 is a hub now");
  assert.deepEqual(fourth.hubs, ["g1"]);
  assert.ok(fourth.context.includes("keep the code structure simple") && !fourth.context.includes("Never add a fallback path"));
  assert.ok(fs.existsSync(hubIndexPath(w.dataDir)), "the index was written by the hook");
  // the session that said it stays unaffected by its own history (noRepeat covers within-session repeats)
  const again = await w.turn("s1");
  assert.deepEqual(again.injected, ["g2"], "s1 already had g1 (noRepeat); g2 is its next");
  // g2 has now been said into s4 and s1; a fifth session still gets it, g1 stays a hub
  assert.deepEqual((await w.turn("s5")).injected, ["g2"]);
  // after the window the hub is forgotten
  w.advanceDays(15);
  assert.deepEqual((await w.turn("s6")).injected, ["g1"]);
});

test("the hook: hubMaxSessions 0 turns hub suppression off", async () => {
  const w = await hookWorld({ RECALL_HUB_MAX_SESSIONS: "0" });
  for (const s of ["s1", "s2", "s3", "s4"]) assert.deepEqual((await w.turn(s)).injected, ["g1"]);
  assert.deepEqual((await w.turn("s5")).hubs ?? [], []);
});

test("the hook: the first run after an upgrade counts what the turn logs already say", async () => {
  const w = await hookWorld();
  writeLog(w.dataDir, "2026-10-07", ["s1", "s2", "s3"].map((s, i) => logLine(`2026-10-07T1${i}:00:00.000Z`, s, ["g1"])));
  assert.equal(fs.existsSync(hubIndexPath(w.dataDir)), false);
  const t = await w.turn("s4");
  assert.deepEqual(t.injected, ["g2"]);
  assert.deepEqual(t.hubs, ["g1"]);
});

// ---- the eval ----
test("recall eval: hubs come only from the run's explicit history, so a replay is deterministic; the live index is never read", async () => {
  const dir = tmpDir("recall-hub-eval");
  const write = (file, rows) => fs.writeFileSync(path.join(dir, file), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  write("corpus.jsonl", ROWS.map(({ card, ...r }) => ({ ...r, session_id: "old", repo: "r", host: "claude" })));
  write("cases.jsonl", [{ case_id: "c1", mode: "prompt", query: PROMPT, decision_ts: "2026-10-05T00:00:00Z", session_id: "Z", exclude_ids: [] }]);
  const cardsFile = path.join(dir, "cards.jsonl");
  appendCards(cardsFile, ROWS.map((r) => buildCard({ statement: { ...r, repo: "r" }, entry: { n: 1, ...r.card }, model: "haiku", at: AT, gistSource: "index" })));
  const history = (rows) => write("history.jsonl", rows);
  const run = async (name, historyFile) => {
    const config = loadConfig({ RECALL_DATA: path.join(dir, "data"), RECALL_DAILY_CAP_USD: "5", RECALL_K: "1", RECALL_QUERY_CONTEXT: "0" });
    const injectOutPath = path.join(dir, `${name}-inject.jsonl`);
    // a live hub index in the data dir that says g1 is a hub: the replay must not read it
    fs.mkdirSync(path.join(dir, "data", "state"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", "state", "hub-index.json"), JSON.stringify({ version: 1, entries: { g1: { a: "2026-10-04T00:00:00.000Z", b: "2026-10-04T00:00:00.000Z", c: "2026-10-04T00:00:00.000Z" } } }));
    await runEval({ corpusPath: path.join(dir, "corpus.jsonl"), casesPath: path.join(dir, "cases.jsonl"), pipeline: "default", outPath: path.join(dir, `${name}.jsonl`), cardsFile, injectOutPath, hubHistoryPath: historyFile, config, runtime: createRuntime(config, { post: fakeOpenAI({ decide: () => 0.99 }).post }), store: createStore(path.join(dir, "eval-store")), concurrency: 1 });
    return JSON.parse(fs.readFileSync(injectOutPath, "utf8").trim());
  };
  const none = await run("none");
  assert.deepEqual(none.picked, ["g1"]);
  assert.equal(none.hubs, undefined);
  history([row2("g1", "a", "2026-10-02T00:00:00Z"), row2("g1", "b", "2026-10-03T00:00:00Z"), row2("g1", "c", "2026-10-04T00:00:00Z"), row2("g2", "a", "2026-10-02T00:00:00Z")]);
  const withHistory = await run("with", path.join(dir, "history.jsonl"));
  assert.deepEqual(withHistory.picked, ["g2"]);
  assert.deepEqual(withHistory.hubs, ["g1"]);
  // history after the case's decision time is the future of the replay: ignored
  history([row2("g1", "a", "2026-10-02T00:00:00Z"), row2("g1", "b", "2026-10-03T00:00:00Z"), row2("g1", "c", "2026-10-06T00:00:00Z")]);
  assert.deepEqual((await run("future", path.join(dir, "history.jsonl"))).picked, ["g1"]);
  history([{ id: "g1", session_id: "a" }]);
  await assert.rejects(run("bad", path.join(dir, "history.jsonl")), /hub history row 1: unparseable timestamp undefined/);
});
const row2 = (id, session_id, ts) => ({ id, session_id, ts });
