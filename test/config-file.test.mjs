// <dataDir>/config.json: precedence (env, then file, then default), loud validation, hooks silent with a logged reason on a bad file, the file
// changing the pipeline and the caps, the removed Stop keys being invalid, and total-cap silence. No network (OPENAI_API_KEY is a dummy; the API is the in-process fake).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_KEYS, ConfigError, effectiveSettings, loadConfig, V1_ENV, V2_FLAGS } from "../scripts/lib/config.mjs";
import { parseHookInput } from "../scripts/lib/hook-io.mjs";
import { handlePrompt } from "../scripts/lib/prompt-hook.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { SESSION_PREDICATE } from "../scripts/lib/pipelines/sessions-nodes.mjs";
import { fakeOpenAI, readFixture, seedIndex, tmpDir } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const recorded = (name) => JSON.parse(readFixture("hook-inputs", name));
const input = (name, over = {}) => parseHookInput({ stdin: JSON.stringify({ ...recorded(name), ...over }) });
const HISTORY = [{ id: "h1", ts: "2026-09-01T10:00:00Z", text: "We want a proper fix, no fallback things. Do not add random limits, fix the code structure instead.", repo: "shared-lib" }];
const PROMPT = "The duplicate draft runs come from a re-execution path, so I will add a fallback path with a random limit to stop them.";
const writeFile = (dataDir, body) => fs.writeFileSync(path.join(dataDir, "config.json"), typeof body === "string" ? body : JSON.stringify(body));
const logs = (dataDir) => {
  const dir = path.join(dataDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("turns-")).sort().flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map(JSON.parse)) : [];
};
const BASE = { ...V1_ENV, RECALL_AUTO_INDEX: "0", RECALL_ALLOW_HEADLESS: "1" };

// ---- precedence ----
test("config.json: env beats the file, the file beats the default, and every field reports its source", () => {
  const dataDir = tmpDir("recall-cfg");
  assert.equal(loadConfig({ RECALL_DATA: dataDir }).configFile, null, "no file: pure defaults");
  writeFile(dataDir, { dailyCapUsd: 5, totalCapUsd: 20, pipeline: "embeddings", k: 4, queryContext: false });
  const file = loadConfig({ RECALL_DATA: dataDir });
  assert.equal(file.configFile, path.join(dataDir, "config.json"));
  assert.deepEqual([file.dailyCapUsd, file.totalCapUsd, file.pipeline, file.k, file.queryContext], [5, 20, "embeddings", 4, false]);
  assert.deepEqual([file.sources.dailyCapUsd, file.sources.totalCapUsd, file.sources.pipeline, file.sources.k, file.sources.queryContext, file.sources.scopeFilter], ["file", "file", "file", "file", "file", "default"]);
  assert.equal(file.scopeFilter, true, "a field the file does not name keeps its default");

  const env = loadConfig({ RECALL_DATA: dataDir, RECALL_DAILY_CAP_USD: "7", RECALL_PIPELINE: "compose-lean", RECALL_TOTAL_CAP_USD: "9", RECALL_SCOPE_FILTER: "0" });
  assert.deepEqual([env.dailyCapUsd, env.totalCapUsd, env.pipeline, env.scopeFilter], [7, 9, "compose-lean", false]);
  assert.deepEqual([env.sources.dailyCapUsd, env.sources.totalCapUsd, env.sources.pipeline, env.sources.k, env.sources.scopeFilter], ["env", "env", "env", "file", "env"]);
  const eff = effectiveSettings(env);
  assert.deepEqual([eff.dailyCapUsd, eff.totalCapUsd, eff.pipeline, eff.k, eff.scopeFilter], [{ value: 7, source: "env" }, { value: 9, source: "env" }, { value: "compose-lean", source: "env" }, { value: 4, source: "file" }, { value: false, source: "env" }]);
  assert.deepEqual(Object.keys(eff).sort(), ["dailyCapUsd", "k", "pipeline", "totalCapUsd", ...V2_FLAGS].sort(), "the settings a log line records: caps, pipeline, k and the v2 flags");

  const empty = loadConfig({ RECALL_DATA: dataDir, RECALL_DAILY_CAP_USD: "", RECALL_PIPELINE: "" });
  assert.deepEqual([empty.dailyCapUsd, empty.pipeline, empty.sources.dailyCapUsd], [5, "embeddings", "file"], "an empty variable is unset, as before");

  writeFile(dataDir, { totalCapUsd: null });
  const none = loadConfig({ RECALL_DATA: dataDir });
  assert.deepEqual([none.totalCapUsd, none.sources.totalCapUsd], [null, "file"], "null is an explicit 'no total cap'");
  assert.equal(loadConfig({ RECALL_DATA: dataDir }).dailyCapUsd, 1, "default daily cap");
});

test("config.json: the file lives in RECALL_DATA, else ~/.plugin-recall; a bare {} env never reads the real home", () => {
  const home = tmpDir("recall-cfg-home");
  fs.mkdirSync(path.join(home, ".plugin-recall"));
  writeFile(path.join(home, ".plugin-recall"), { k: 9 });
  assert.equal(loadConfig({ HOME: home }).k, 9);
  const data = tmpDir("recall-cfg-data");
  assert.equal(loadConfig({ HOME: home, RECALL_DATA: data }).k, 3, "RECALL_DATA wins, its (absent) file is the one read");
  assert.equal(loadConfig({}).configFile, null);
});

test("config.json: re-read on every call, nothing cached", () => {
  const dataDir = tmpDir("recall-cfg");
  writeFile(dataDir, { dailyCapUsd: 2 });
  assert.equal(loadConfig({ RECALL_DATA: dataDir }).dailyCapUsd, 2);
  writeFile(dataDir, { dailyCapUsd: 6 });
  assert.equal(loadConfig({ RECALL_DATA: dataDir }).dailyCapUsd, 6);
  fs.rmSync(path.join(dataDir, "config.json"));
  assert.equal(loadConfig({ RECALL_DATA: dataDir }).dailyCapUsd, 1);
});

test("config.json: every settable field is accepted with its own type (numbers, strings, booleans); dataDir and child are not keys", () => {
  const dataDir = tmpDir("recall-cfg");
  const all = {
    disabled: false, allowHeadless: true, openaiBaseUrl: "http://127.0.0.1:9/", pipeline: "embeddings", k: 4, promptThreshold: 0.9,
    embThreshold: 0.3, minChars: 10, ownerEmails: ["me@example.com"], ownerNames: ["me", "sam"], filterProfiles: ["fleet"], dropPatterns: ["^todo:", "nightly\\s+report"], excludeKinds: ["status", "other"], scopeFilter: false, repoAliases: { "web-app-v2": "web-app" }, queryContext: false, itemGist: true, noRepeat: false, hubMaxSessions: 5, hubWindowDays: 7, excludeNewSessionGist: false, excludeCitations: false, crossRepoMaxChars: 250, ruleMaxChars: 600, applyGate: false, applyThreshold: 0.3,
    timeoutMs: 15000, dailyCapUsd: 5, totalCapUsd: 50, noCache: true, autoIndex: false, autoIndexMinutes: 60, homes: ["/a", "/b"], homesRoster: "/r.json", claudeHome: "/c", codexHome: "/x", usageCmd: "u",
    usageTtlMs: 5, usageMaxPercent: 80, workerTimeoutMs: 5000,
  };
  assert.deepEqual(Object.keys(all).sort(), [...CONFIG_KEYS].sort(), "the test covers every key");
  writeFile(dataDir, all);
  const c = loadConfig({ RECALL_DATA: dataDir });
  for (const [k, v] of Object.entries(all)) assert.deepEqual(c[k], k === "openaiBaseUrl" ? "http://127.0.0.1:9" : v, k);
  assert.ok(!CONFIG_KEYS.includes("dataDir") && !CONFIG_KEYS.includes("child"));
  assert.throws(() => (writeFile(dataDir, { child: true }), loadConfig({ RECALL_DATA: dataDir })), /unknown key "child"/);
});

test("config.json: the keys of the removed Stop hook are invalid now, not ignored (a file that still has one makes the hooks silent until it is removed)", () => {
  const dataDir = tmpDir("recall-cfg");
  for (const key of ["stopPipeline", "stopThreshold", "stopCandidates", "stopVerify", "stopVerifyMax", "stopMinChars", "stopInjectThreshold"]) {
    writeFile(dataDir, { dailyCapUsd: 5, [key]: key === "stopPipeline" ? "default" : 1 });
    assert.throws(() => loadConfig({ RECALL_DATA: dataDir }), (e) => e instanceof ConfigError && e.message.includes(`unknown key "${key}"`), key);
    assert.ok(!CONFIG_KEYS.includes(key));
  }
});

// ---- a bad file is loud, never a default and never ignored ----
test("config.json: bad JSON, an unknown key, a wrong type or an out-of-range value throws a ConfigError naming the file and the key", () => {
  const dataDir = tmpDir("recall-cfg");
  const file = path.join(dataDir, "config.json");
  const bad = (body, re) => {
    writeFile(dataDir, body);
    assert.throws(() => loadConfig({ RECALL_DATA: dataDir }), (e) => e instanceof ConfigError && e.name === "ConfigError" && e.message.includes(file) && re.test(e.message), `${JSON.stringify(body)} -> ${re}`);
  };
  bad("{not json", /not valid JSON/);
  bad("", /not valid JSON/);
  bad("[1, 2]", /must be a JSON object/);
  bad("null", /must be a JSON object/);
  bad({ dailyCapUSD: 5 }, /unknown key "dailyCapUSD" \(known keys: .*dailyCapUsd/);
  bad({ RECALL_DAILY_CAP_USD: 5 }, /unknown key "RECALL_DAILY_CAP_USD"/);
  bad({ dailyCapUsd: "5" }, /"dailyCapUsd" is "5" but must be a number/);
  bad({ dailyCapUsd: -1 }, /"dailyCapUsd" is -1 but must be a number in \[0, Infinity\]/);
  bad({ dailyCapUsd: null }, /"dailyCapUsd" is null/);
  bad({ totalCapUsd: "none" }, /"totalCapUsd" is "none" but must be a number .*or null/);
  bad({ k: 2.5 }, /"k" is 2.5 but must be an integer in \[1, 20\]/);
  bad({ pipeline: 5 }, /"pipeline" is 5 but must be a string/);
  bad({ pipeline: null }, /"pipeline" is null but must be a string/);
  bad({ scopeFilter: "yes" }, /"scopeFilter" is "yes" but must be true or false/);
  bad({ disabled: "yes" }, /"disabled" is "yes" but must be true or false/);
  bad({ dailyCapUsd: 5, promptThreshold: 1.5 }, /"promptThreshold" is 1.5/);
  // a bad file stays bad even when the environment sets the same key: the file is validated as a whole
  writeFile(dataDir, { dailyCapUsd: "5" });
  assert.throws(() => loadConfig({ RECALL_DATA: dataDir, RECALL_DAILY_CAP_USD: "5" }), ConfigError);
  // a directory where the file should be is unreadable, not "absent"
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => loadConfig({ RECALL_DATA: dataDir }), (e) => e instanceof ConfigError && /cannot be read/.test(e.message));
  // env errors are ConfigErrors too, so the hooks treat them the same way
  assert.throws(() => loadConfig({ RECALL_K: "lots" }), ConfigError);
});

function runScript(script, { stdin, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", script)], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

test("hooks (real scripts): a bad config.json makes the hook silent with a logged config-invalid reason; no stack trace, exit 0, one JSON document", async () => {
  const dataDir = tmpDir("recall-cfg-hooks");
  const env = { RECALL_DATA: dataDir, HOME: dataDir, OPENAI_API_KEY: "sk-test-no-network", RECALL_OPENAI_BASE_URL: "http://127.0.0.1:9", ...BASE };
  const bodies = ["{oops", { pipelines: "default" }, { dailyCapUsd: "5" }, { dailyCapUsd: 5, stopMinChars: 1000000000 }];
  for (const [i, body] of bodies.entries()) {
    writeFile(dataDir, body);
    const p = await runScript("user-prompt-submit.mjs", { stdin: JSON.stringify({ ...recorded("claude-prompt.json"), prompt: PROMPT }), env });
    for (const r of [p]) {
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout), { continue: true });
      assert.match(r.stderr, /^\[recall ERROR\] prompt ConfigError: /);
      assert.ok(!/\n\s+at /.test(r.stderr), `no stack trace on stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes(path.join(dataDir, "config.json")));
    }
    const lines = logs(dataDir).filter((l) => l.reason === "config-invalid");
    assert.equal(lines.length, i + 1);
    assert.deepEqual(lines.slice(-1).map((l) => [l.event, l.level, l.outcome]), [["prompt", "error", "silent"]]);
    assert.match(lines.at(-1).error, /^ConfigError: .*config\.json/);
  }
  assert.ok(!fs.existsSync(path.join(dataDir, "ledger.jsonl")), "nothing was requested");
  // fixing the file brings the hooks back on the very next run (here: silent for the ordinary reason, an empty index)
  writeFile(dataDir, { dailyCapUsd: 5 });
  const ok = await runScript("user-prompt-submit.mjs", { stdin: JSON.stringify({ ...recorded("claude-prompt.json"), prompt: PROMPT }), env });
  assert.deepEqual(JSON.parse(ok.stdout), { continue: true });
  assert.ok(!/config-invalid/.test(ok.stderr));
  assert.equal(logs(dataDir).at(-1).reason, "empty-index");
  assert.equal(logs(dataDir).at(-1).settings.dailyCapUsd.source, "file");
});

// ---- the file changes the pipeline and the caps; the log says which settings were live ----
async function session(dataDir, { clock = () => new Date("2026-10-07T12:00:00Z") } = {}) {
  const load = () => loadConfig({ RECALL_DATA: dataDir, ...BASE });
  const fake = fakeOpenAI({ decide: () => 0.2 });
  const first = createRuntime(load(), { post: fake.post, now: () => clock() });
  await seedIndex(first.store, HISTORY);
  // like a fresh hook process: config and runtime are rebuilt from disk on every run
  const run = (fn, name, over) => {
    const config = load();
    const runtime = createRuntime(config, { post: fake.post, now: () => clock() });
    return fn({ input: input(name, over), config, runtime, now: () => clock() });
  };
  return {
    fake, first, load,
    prompt: () => run(handlePrompt, "claude-prompt.json", { prompt: PROMPT }),
  };
}
const nodeCalls = (fake) => fake.calls.filter((c) => c.pathname === "/v1/decisions" && c.body.questions.some((q) => q.instructions.endsWith(SESSION_PREDICATE))).length;

test("config.json changes the pipeline: edited between runs, the next prompt uses the new one; every log line records the live caps, pipeline, flags and sources", async () => {
  const dataDir = tmpDir("recall-cfg-pipe");
  const s = await session(dataDir);
  writeFile(dataDir, { pipeline: "default", dailyCapUsd: 5, totalCapUsd: 50 });
  await s.prompt();
  assert.equal(nodeCalls(s.fake), 0, "default has no session-chunk node questions");
  let line = logs(dataDir).filter((l) => l.event === "prompt").at(-1);
  assert.equal(line.pipeline, "default");
  assert.deepEqual([line.settings.dailyCapUsd, line.settings.totalCapUsd, line.settings.pipeline], [{ value: 5, source: "file" }, { value: 50, source: "file" }, { value: "default", source: "file" }]);
  assert.deepEqual(line.settings.excludeKinds, { value: [], source: "env" }, "the flags are recorded with where they came from");

  writeFile(dataDir, { pipeline: "compose-lean", dailyCapUsd: 5 });
  await s.prompt();
  assert.ok(nodeCalls(s.fake) >= 1, "compose-lean asks the session-chunk node questions");
  line = logs(dataDir).filter((l) => l.event === "prompt").at(-1);
  assert.equal(line.pipeline, "compose-lean");
  assert.deepEqual(line.settings.pipeline, { value: "compose-lean", source: "file" });
  assert.deepEqual(line.settings.totalCapUsd, { value: null, source: "default" });

  // env still wins over the file, and the log says so
  const env = loadConfig({ RECALL_DATA: dataDir, RECALL_PIPELINE: "default", RECALL_DAILY_CAP_USD: "3", ...BASE });
  assert.deepEqual(effectiveSettings(env).pipeline, { value: "default", source: "env" });
  assert.deepEqual(effectiveSettings(env).dailyCapUsd, { value: 3, source: "env" });
});

test("config.json changes the daily cap: below today's spend the hooks are silent, raised in the file they work again on the next run", async () => {
  const dataDir = tmpDir("recall-cfg-daily");
  const s = await session(dataDir);
  s.first.ledger.record({ endpoint: "/v1/decisions", inputTokens: 1, costUsd: 0.6 });
  writeFile(dataDir, { dailyCapUsd: 0.5 });
  await s.prompt();
  assert.equal(s.fake.calls.length, 0, "no request over the file's cap");
  let line = logs(dataDir).at(-1);
  assert.deepEqual([line.reason, line.level, line.settings.dailyCapUsd], ["cap-reached", "error", { value: 0.5, source: "file" }]);
  assert.match(line.error, /daily spend cap reached: spent \$0\.600000 of \$0\.5 \(RECALL_DAILY_CAP_USD\).*"dailyCapUsd" in <data dir>\/config\.json/);

  writeFile(dataDir, { dailyCapUsd: 5 });
  await s.prompt();
  line = logs(dataDir).at(-1);
  assert.notEqual(line.reason, "cap-reached");
  assert.ok(s.fake.calls.length > 0, "requests flow again");
  assert.deepEqual(line.settings.dailyCapUsd, { value: 5, source: "file" });
});

// ---- the total cap: the data dir's whole ledger, silent with one loud line per hour ----
test("totalCapUsd (file) is a cap on the whole ledger total, across days: hooks silent, no request, one loud line per hour", async () => {
  const dataDir = tmpDir("recall-cfg-total");
  let now = new Date("2026-10-05T09:00:00Z");
  const s = await session(dataDir, { clock: () => now });
  writeFile(dataDir, { dailyCapUsd: 5, totalCapUsd: 1 });
  s.first.ledger.record({ endpoint: "/v1/decisions", inputTokens: 1, costUsd: 0.6 }); // two days ago
  now = new Date("2026-10-06T09:00:00Z");
  s.first.ledger.record({ endpoint: "/v1/decisions", inputTokens: 1, costUsd: 0.5 }); // yesterday: the ledger now holds 1.1 in total
  now = new Date("2026-10-07T12:00:00Z");
  assert.equal(s.first.ledger.spentToday(), 0, "nothing spent today, so the daily cap (5) is nowhere near");
  assert.ok(Math.abs(s.first.ledger.spentTotal() - 1.1) < 1e-9);

  for (let i = 0; i < 3; i++) {
    const out = await s.prompt();
    assert.deepEqual(JSON.parse(out.stdout), { continue: true });
    now = new Date(now.getTime() + 60_000);
  }
  assert.equal(s.fake.calls.length, 0, "no request while the total cap is reached");
  let lines = logs(dataDir).filter((l) => l.reason === "cap-reached");
  assert.equal(lines.length, 3, "every silenced turn is logged");
  assert.deepEqual(lines.map((l) => l.level), ["error", "info", "info"], "one loud line");
  assert.match(lines[0].error, /total spend cap reached: spent \$1\.100000 of \$1 \(RECALL_TOTAL_CAP_USD\)/);
  assert.ok(lines.every((l) => l.outcome === "silent" && l.settings.totalCapUsd.value === 1 && l.settings.totalCapUsd.source === "file"));

  now = new Date(now.getTime() + 3_600_000);
  await s.prompt();
  lines = logs(dataDir).filter((l) => l.reason === "cap-reached");
  assert.deepEqual(lines.filter((l) => l.level === "error").length, 2, "an hour later the warning repeats once");

  writeFile(dataDir, { dailyCapUsd: 5, totalCapUsd: 10 }); // "refreshing the budget": raising the cap brings the hooks back
  await s.prompt();
  assert.notEqual(logs(dataDir).at(-1).reason, "cap-reached");
  assert.ok(s.fake.calls.length > 0);
});


// ---- nothing about the person who wrote the plugin is a default ----
test("defaults are generic: no owner identity, no roster, no filter profile, no extra homes, no usage command", () => {
  const c = loadConfig({ RECALL_DATA: tmpDir("recall-cfg-defaults") });
  assert.deepEqual([...c.ownerEmails], []);
  assert.deepEqual([...c.ownerNames], []);
  assert.deepEqual([...c.filterProfiles], []);
  assert.deepEqual([...c.dropPatterns], []);
  assert.deepEqual([...c.homes], []);
  assert.equal(c.homesRoster, "");
  assert.equal(c.usageCmd, "");
  assert.equal(c.claudeHome, "");
  assert.equal(c.codexHome, "");
  assert.equal(c.dailyCapUsd, 1);
  assert.ok(!("ownerEmail" in c), "the old single-address setting is gone");
});

test("config lists: comma separated in the environment (the path delimiter for homes, JSON for dropPatterns), arrays in the file, each value checked", () => {
  const env = { RECALL_DATA: tmpDir("recall-cfg-lists"), RECALL_OWNER_EMAILS: "a@example.com, b@example.com", RECALL_OWNER_NAMES: "sam,samuel", RECALL_FILTER_PROFILES: "fleet", RECALL_HOMES: `/x${path.delimiter}/y`, RECALL_DROP_PATTERNS: '["^wip:","a,b"]' };
  const c = loadConfig(env);
  assert.deepEqual([[...c.ownerEmails], [...c.ownerNames], [...c.filterProfiles], [...c.homes], [...c.dropPatterns]], [["a@example.com", "b@example.com"], ["sam", "samuel"], ["fleet"], ["/x", "/y"], ["^wip:", "a,b"]]);
  assert.equal(c.sources.ownerEmails, "env");
  for (const [key, value, re] of [
    ["RECALL_OWNER_EMAILS", "not-an-address", /RECALL_OWNER_EMAILS: "not-an-address" is not an email address/],
    ["RECALL_FILTER_PROFILES", "bogus", /"bogus" is not one of fleet/],
    ["RECALL_DROP_PATTERNS", "[(", /not a JSON array/],
    ["RECALL_DROP_PATTERNS", '["("]', /is not a regular expression/],
    ["RECALL_OWNER_NAMES", "sam,sam", /listed twice/],
  ]) assert.throws(() => loadConfig({ RECALL_DATA: env.RECALL_DATA, [key]: value }), (e) => e instanceof ConfigError && re.test(e.message), `${key}=${value}`);
  const dataDir = tmpDir("recall-cfg-lists-file");
  for (const [body, re] of [
    [{ ownerEmails: "me@example.com" }, /"ownerEmails" is "me@example.com" but must be a list of strings/],
    [{ filterProfiles: ["fleet", "nope"] }, /"nope" is not one of fleet/],
    [{ dropPatterns: ["["] }, /is not a regular expression/],
    [{ homes: [1] }, /1 is not a string/],
  ]) {
    writeFile(dataDir, body);
    assert.throws(() => loadConfig({ RECALL_DATA: dataDir }), (e) => e instanceof ConfigError && re.test(e.message), JSON.stringify(body));
  }
});
