// One data dir (~/.plugin-recall) is shared by every home and host: concurrent hook processes, locks with stale recovery, the cross-process
// daily cap, the once-per-hour cap warning, the shared index lock. Real child processes; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { maybeStartIndex } from "../scripts/lib/auto-index.mjs";
import { loadConfig, V1_ENV } from "../scripts/lib/config.mjs";
import { logCapSilence, warnOncePerWindow } from "../scripts/lib/cap-guard.mjs";
import { createLedger } from "../scripts/lib/ledger.mjs";
import { acquireLock, adoptLock, LockTimeoutError, readLock, releaseLock, transferLock, withLockSync } from "../scripts/lib/lock.mjs";
import { handlePrompt } from "../scripts/lib/prompt-hook.mjs";
import { parseHookInput } from "../scripts/lib/hook-io.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { createTurnState } from "../scripts/lib/turn-log.mjs";
import { fakeOpenAI, readFixture, seedIndex, tmpDir } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "test", "workers", "writer.mjs");

/** Run N writer processes at once; resolves with each one's parsed result line. */
function runWorkers(specs) {
  return Promise.all(specs.map((spec) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(spec)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => (code === 0 ? resolve({ result: JSON.parse(stdout.trim().split("\n").at(-1)), stderr }) : reject(new Error(`worker ${spec.mode} exited ${code}: ${stderr}`))));
  })));
}
const deadPid = () => { const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }); return Number(r.stdout); };

// ---- locks ----
test("lock: mutual exclusion across processes (6 processes x 40 read-modify-write cycles lose no update)", async () => {
  const dir = tmpDir("recall-lock");
  await runWorkers(Array.from({ length: 6 }, () => ({ mode: "counter", dir, times: 40 })));
  assert.equal(Number(fs.readFileSync(path.join(dir, "counter.txt"), "utf8")), 240);
  assert.ok(!fs.existsSync(path.join(dir, "locks", "counter.lock")), "released");
});

test("lock: a held lock times out loudly; a lock held by a dead process, or for longer than staleMs, is recovered; release never deletes someone else's lock", () => {
  const dir = tmpDir("recall-lock");
  const file = path.join(dir, "locks", "x.lock");
  const mine = acquireLock(file);
  assert.throws(() => acquireLock(file, { timeoutMs: 0 }), (e) => e instanceof LockTimeoutError && e.holder.pid === process.pid && /held by pid/.test(e.message));
  assert.throws(() => acquireLock(file, { timeoutMs: 50 }), LockTimeoutError);
  mine.release();
  assert.ok(!fs.existsSync(file));

  // dead holder: recovered at once, whatever the age
  fs.writeFileSync(file, JSON.stringify({ pid: deadPid(), at: new Date().toISOString(), token: "dead" }));
  const second = acquireLock(file, { timeoutMs: 0 });
  assert.equal(readLock(file).pid, process.pid);
  // stale by age although the pid is alive (a hung holder or a recycled pid)
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 120_000).toISOString(), token: "old" }));
  assert.throws(() => acquireLock(file, { timeoutMs: 0, staleMs: 600_000 }), LockTimeoutError, "a live holder inside staleMs is not touched");
  const third = acquireLock(file, { timeoutMs: 0, staleMs: 60_000 });
  // the recovered holder's late release must not delete the new holder's lock
  assert.equal(releaseLock(file, "old"), false);
  assert.ok(fs.existsSync(file));
  assert.equal(second.release(), false, "second's lock was recovered from under it; its late release is a no-op");
  assert.ok(fs.existsSync(file), "release with a stale token leaves the new holder's lock alone");
  third.release();
  assert.ok(!fs.existsSync(file));
  // the pre-lock-module format (just a pid) is understood; an empty file is given a moment, then recovered
  fs.writeFileSync(file, String(deadPid()));
  acquireLock(file, { timeoutMs: 0 }).release();
  fs.writeFileSync(file, "");
  assert.throws(() => acquireLock(file, { timeoutMs: 0 }), LockTimeoutError, "just created, maybe being written");
  fs.utimesSync(file, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
  acquireLock(file, { timeoutMs: 0 }).release();
});

test("lock: a hook can hand its lock to the process it spawned, which adopts it", () => {
  const file = path.join(tmpDir("recall-lock"), "state", "index.lock");
  const lock = acquireLock(file);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
  try {
    transferLock(file, lock.token, child.pid);
    assert.equal(readLock(file).pid, child.pid);
    assert.equal(adoptLock(file), null, "not ours: the child's");
    assert.deepEqual(adoptLock(file, child.pid).token, lock.token);
    assert.throws(() => acquireLock(file, { timeoutMs: 0 }), LockTimeoutError);
  } finally {
    child.kill();
  }
});

// ---- append-only writes ----
test("concurrent appends: 8 processes appending statement batches leave every line whole, none lost", async () => {
  const dir = tmpDir("recall-append");
  await runWorkers(Array.from({ length: 8 }, (_, worker) => ({ mode: "statements", dir, worker, batches: 10, rowsPerBatch: 25, pad: 3000 })));
  const text = fs.readFileSync(path.join(dir, "statements.jsonl"), "utf8");
  const rows = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 8 * 10 * 25);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.equal(createStore(dir).loadStatements().length, rows.length);
});

test("concurrent appends: 6 processes writing 20 KB turn-log lines leave every line whole", async () => {
  const dir = tmpDir("recall-turnlog");
  await runWorkers(Array.from({ length: 6 }, (_, worker) => ({ mode: "turnlog", dir, worker, lines: 40, pad: 20_000 })));
  const day = fs.readdirSync(path.join(dir, "logs"))[0];
  const rows = fs.readFileSync(path.join(dir, "logs", day), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 240);
  assert.ok(rows.every((r) => r.context.length === 20_000));
});

test("a reader meeting a statement line still being written skips it instead of calling the file corrupt; a complete bad line is still loud", () => {
  const dir = tmpDir("recall-partial");
  const store = createStore(dir);
  store.appendStatements([{ id: "a", text: "first", ts: "2026-09-01T00:00:00Z" }]);
  fs.appendFileSync(store.statementsFile, '{"id":"b","text":"half writ');
  assert.deepEqual(store.loadStatements().map((s) => s.id), ["a"]);
  fs.appendFileSync(store.statementsFile, 'ten"}\n');
  assert.deepEqual(store.loadStatements().map((s) => s.id), ["a", "b"]);
  fs.appendFileSync(store.statementsFile, "{broken}\n");
  assert.throws(() => store.loadStatements(), /corrupt line 3/);
});

// ---- the shared ledger and daily cap ----
test("shared daily cap: 8 processes racing for a $0.05 cap in $0.01 requests spend exactly $0.05, never more", async () => {
  const dir = tmpDir("recall-cap");
  const runs = await runWorkers(Array.from({ length: 8 }, () => ({ mode: "ledger", dir, capUsd: 0.05, usd: 0.01, attempts: 6, holdMs: 20 })));
  const ok = runs.reduce((n, r) => n + r.result.ok, 0);
  const refused = runs.reduce((n, r) => n + r.result.refused, 0);
  assert.equal(ok, 5, "exactly the five requests the cap pays for");
  assert.equal(refused, 8 * 6 - 5);
  const lines = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 5);
  assert.ok(Math.abs(createLedger({ dir, dailyCapUsd: 1 }).spentToday() - 0.05) < 1e-9);
  assert.deepEqual(fs.readdirSync(path.join(dir, "inflight")), [], "every reservation was released");
});

test("ledger reservations of a dead process stop counting (and are deleted); a live process's reservation counts for everyone", () => {
  const dir = tmpDir("recall-resv");
  const ledger = createLedger({ dir, dailyCapUsd: 0.01 });
  fs.mkdirSync(path.join(dir, "inflight"), { recursive: true });
  fs.writeFileSync(path.join(dir, "inflight", "dead.json"), JSON.stringify({ pid: deadPid(), at: new Date().toISOString(), usd: 0.009 }));
  const r = ledger.reserve(0.006); // would fail if the dead process's $0.009 still counted
  assert.ok(!fs.existsSync(path.join(dir, "inflight", "dead.json")));
  const other = createLedger({ dir, dailyCapUsd: 0.01 }); // another "process" (same pid, separate ledger object): sees our file
  assert.throws(() => other.reserve(0.006), /daily spend cap exceeded/);
  r.release();
  other.reserve(0.006).release();
  // an old reservation of a live pid expires too
  fs.writeFileSync(path.join(dir, "inflight", "old.json"), JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 3_600_000).toISOString(), usd: 0.009 }));
  other.reserve(0.006).release();
});

test("capReached: false below the cap, true at it (daily and total), reported with the scope", () => {
  const ledger = createLedger({ dir: tmpDir("recall-cr"), dailyCapUsd: 0.01, totalCapUsd: 5 });
  assert.equal(ledger.capReached(), null);
  ledger.record({ endpoint: "/x", inputTokens: 1, costUsd: 0.01 });
  assert.deepEqual(ledger.capReached(), { scope: "daily", capUsd: 0.01, spentUsd: 0.01 });
  const total = createLedger({ dir: tmpDir("recall-cr"), dailyCapUsd: 5, totalCapUsd: 0.02 });
  total.record({ endpoint: "/x", inputTokens: 1, costUsd: 0.02 });
  assert.equal(total.capReached().scope, "total");
});

// ---- the spend guard in the hooks ----
const HISTORY = [{ id: "h1", ts: "2026-09-01T10:00:00Z", text: "We want a proper fix, no fallback things. Do not add random limits, fix the code structure instead.", repo: "shared-lib" }];
const PROMPT = "The duplicate draft runs come from a re-execution path, so I will add a fallback path with a random limit to stop them.";
const recorded = (name) => JSON.parse(readFixture("hook-inputs", name));
const hookInput = (name, over) => parseHookInput({ stdin: JSON.stringify({ ...recorded(name), ...over }) });
const logLines = (dataDir) => {
  const dir = path.join(dataDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("turns-")).sort().flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map(JSON.parse)) : [];
};

async function cappedSetup() {
  const dataDir = tmpDir("recall-capped");
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_DAILY_CAP_USD: "1", RECALL_ALLOW_HEADLESS: "1" });
  const fake = fakeOpenAI();
  let clock = new Date("2026-10-07T12:00:00Z");
  const runtime = createRuntime(config, { post: fake.post, now: () => clock });
  await seedIndex(runtime.store, HISTORY);
  runtime.ledger.record({ endpoint: "/v1/decisions", inputTokens: 1, costUsd: 1.0 }); // the shared day is already spent (by any home)
  return { dataDir, config, fake, runtime, tick: (ms) => { clock = new Date(clock.getTime() + ms); }, now: () => clock };
}

test("cap hit: every hook turn is silent with no API call; ONE loud line per hour, quiet lines in between, a new loud line after the hour", async () => {
  const s = await cappedSetup();
  for (let i = 0; i < 6; i++) {
    const out = await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT }), config: s.config, runtime: s.runtime, now: s.now });
    assert.deepEqual(JSON.parse(out.stdout), { continue: true });
    s.tick(60_000);
  }
  assert.equal(s.fake.calls.length, 0, "no request while capped");
  let lines = logLines(s.dataDir).filter((l) => l.reason === "cap-reached");
  assert.equal(lines.length, 6, "every silenced turn is logged ...");
  assert.deepEqual(lines.map((l) => l.level), ["error", "info", "info", "info", "info", "info"], "... but only the first of the hour is loud");
  assert.match(lines[0].error, /CapExceededError: daily spend cap reached: spent \$1\.000000 of \$1 \(RECALL_DAILY_CAP_USD\)/);
  assert.ok(lines.slice(1).every((l) => !("error" in l) && l.outcome === "silent"));
  s.tick(3_600_000);
  await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT }), config: s.config, runtime: s.runtime, now: s.now });
  lines = logLines(s.dataDir).filter((l) => l.reason === "cap-reached");
  assert.equal(lines.at(-1).level, "error", "an hour later the warning is repeated once");
  assert.equal(lines.filter((l) => l.level === "error").length, 2);
});

test("cap hit mid-request (another process spent the last cents first) is the same silent turn, not an error per turn", async () => {
  const dataDir = tmpDir("recall-capped2");
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_DAILY_CAP_USD: "0.0000001", RECALL_ALLOW_HEADLESS: "1" });
  const runtime = createRuntime(config, { post: fakeOpenAI().post });
  await seedIndex(runtime.store, HISTORY);
  for (let i = 0; i < 3; i++) await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT }), config, runtime });
  const lines = logLines(dataDir);
  assert.deepEqual(lines.map((l) => [l.reason, l.level]), [["cap-reached", "error"], ["cap-reached", "info"], ["cap-reached", "info"]]);
  assert.match(lines[0].error, /CapExceededError: daily spend cap exceeded/);
});

test("the once-per-hour warning is exact across processes: 6 processes x 5 capped turns in the same hour make one loud line", async () => {
  const dir = tmpDir("recall-warn");
  await runWorkers(Array.from({ length: 6 }, (_, worker) => ({ mode: "capwarn", dir, worker, lines: 5, now: "2026-10-07T12:00:00Z" })));
  const day = fs.readdirSync(path.join(dir, "logs"))[0];
  const rows = fs.readFileSync(path.join(dir, "logs", day), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 30);
  assert.equal(rows.filter((r) => r.level === "error").length, 1);
  const log = { write: () => {} };
  assert.equal(warnOncePerWindow({ dataDir: dir, key: "other-key", now: () => new Date("2026-10-07T12:00:00Z") }), true, "keys are independent");
  assert.equal(logCapSilence({ log, base: {}, dataDir: dir, cap: { scope: "total", capUsd: 1, spentUsd: 1 }, now: () => new Date("2026-10-07T13:00:01Z") }), undefined);
});

// ---- the shared index lock ----
test("auto-index: one indexer at a time across homes; a crashed indexer's lock is recovered", () => {
  const dataDir = tmpDir("recall-auto");
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "1", RECALL_AUTO_INDEX_MINUTES: "30" });
  const store = createStore(dataDir);
  const spawned = [];
  const fakeChild = (pid) => ({ pid, unref() {} });
  assert.equal(maybeStartIndex({ config, store, spawnImpl: (c, a) => { spawned.push(a); return fakeChild(process.pid); } }).started, true);
  assert.deepEqual(spawned[0].slice(-2), ["--lock", path.join(dataDir, "state", "index.lock")]);
  assert.equal(readLock(path.join(dataDir, "state", "index.lock")).pid, process.pid, "the lock now belongs to the spawned indexer");
  assert.equal(maybeStartIndex({ config, store, spawnImpl: () => { throw new Error("must not start a second indexer"); } }).reason, "index-running");
  // the indexer died without releasing: the next hook takes over
  const dead = deadPid();
  fs.writeFileSync(path.join(dataDir, "state", "index.lock"), JSON.stringify({ pid: dead, at: new Date().toISOString(), token: "t" }));
  assert.equal(maybeStartIndex({ config, store, spawnImpl: () => fakeChild(process.pid) }).started, true);
  // a failing spawn does not leave the lock behind
  fs.rmSync(path.join(dataDir, "state", "index.lock"));
  assert.throws(() => maybeStartIndex({ config, store, spawnImpl: () => { throw new Error("spawn failed"); } }), /spawn failed/);
  assert.ok(!fs.existsSync(path.join(dataDir, "state", "index.lock")));
});

const recallCli = (args, env) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "recall.mjs"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, OPENAI_API_KEY: "sk-test", ...env } });

test("`recall index` refuses to run while another index holds the shared lock, names the holder, and a dead holder's lock is recovered", () => {
  const dataDir = tmpDir("recall-cli-lock");
  const home = tmpDir("recall-empty-home");
  const env = { RECALL_DATA: dataDir, RECALL_HOMES: home, HOME: home, RECALL_AUTO_INDEX: "0" };
  const lock = acquireLock(path.join(dataDir, "state", "index.lock"));
  const blocked = recallCli(["index", "--no-embed", "--quiet"], env);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, new RegExp(`another recall index is already running \\(pid ${process.pid}`));
  lock.release();
  fs.writeFileSync(path.join(dataDir, "state", "index.lock"), JSON.stringify({ pid: deadPid(), at: new Date().toISOString(), token: "t" }));
  const ok = recallCli(["index", "--no-embed", "--quiet"], env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!fs.existsSync(path.join(dataDir, "state", "index.lock")), "released at the end");
});

test("`recall logs` counts what the hooks did, by outcome and reason (no query text, no spend)", () => {
  const dataDir = tmpDir("recall-logs");
  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(dataDir, "logs"));
  const rows = [
    { event: "prompt", host: "claude", outcome: "injected", level: "info" },
    { event: "prompt", host: "claude", outcome: "silent", reason: "headless:claude-unattended", level: "info" },
    { event: "prompt", host: "codex", outcome: "silent", reason: "unknown:codex-no-rollout", level: "info" },
    { event: "stop", host: "codex", outcome: "silent", reason: "cap-reached", level: "error" },
    { event: "auto-index", level: "error", error: "x" },
  ].map((r) => JSON.stringify({ ts: `${day}T10:00:00.000Z`, ...r }));
  fs.writeFileSync(path.join(dataDir, "logs", `turns-${day}.jsonl`), `${rows.join("\n")}\n`);
  const r = recallCli(["logs", "--json"], { RECALL_DATA: dataDir });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.turns, 4);
  assert.deepEqual(s.silentReasons, { "headless:claude-unattended": 1, "unknown:codex-no-rollout": 1, "cap-reached": 1 });
  assert.deepEqual([s.silencedHeadless, s.silencedUnknown], [1, 1]);
  assert.deepEqual(s.errors, { "cap-reached": 1 });
  const text = recallCli(["logs"], { RECALL_DATA: dataDir }).stdout;
  assert.match(text, /headless:claude-unattended/);
  assert.equal(recallCli(["logs", "--day", "nonsense"], { RECALL_DATA: dataDir }).status, 1);
});

test("withLockSync releases the lock when the critical section throws", () => {
  const file = path.join(tmpDir("recall-lock"), "l.lock");
  assert.throws(() => withLockSync(file, () => { throw new Error("boom"); }), /boom/);
  assert.ok(!fs.existsSync(file));
});
