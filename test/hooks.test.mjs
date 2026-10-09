// The hook I/O contract for both hosts, on RECORDED hook inputs (test/fixtures/hook-inputs: stdin payloads captured from a real
// `claude -p --plugin-dir` run and a real `codex exec` run on 2026-10-07; only `prompt` / `last_assistant_message` are replaced by
// substantive text in the tests, because the recorded ones were a one-word probe). No network: in-process tests use a fake `post`,
// subprocess tests talk to a local fake OpenAI server through RECALL_OPENAI_BASE_URL.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { maybeStartIndex } from "../scripts/lib/auto-index.mjs";
import { loadConfig, V1_ENV } from "../scripts/lib/config.mjs";
import { CONTEXT_HEADER } from "../scripts/lib/context.mjs";
import { parseHookInput, promptOutput } from "../scripts/lib/hook-io.mjs";
import { handlePrompt } from "../scripts/lib/prompt-hook.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { fakeOpenAI, readFixture, seedIndex, startFakeServer, tmpDir } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const recorded = (name) => JSON.parse(readFixture("hook-inputs", name));

const HISTORY = [
  { id: "h1", ts: "2026-09-01T10:00:00Z", text: "We want a proper fix, no fallback things. Do not add random limits, fix the code structure instead.", repo: "shared-lib" },
  { id: "h2", ts: "2026-09-05T10:00:00Z", text: "Use real prices from the source sheet, never invent artificial unit costs in the quote generator.", repo: "design-kit" },
  { id: "h3", ts: "2026-09-06T10:00:00Z", text: "Totally unrelated: the lunch menu and the weather forecast for the weekend were great.", repo: null },
];
const PROMPT = "The duplicate draft runs come from a re-execution path, so I will add a fallback path with a random limit to stop them.";

async function setup({ env = {}, history = HISTORY, api, runWorker } = {}) {
  const dataDir = tmpDir("recall-hook");
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_DAILY_CAP_USD: "5", RECALL_ALLOW_HEADLESS: "1", ...env });
  const fake = fakeOpenAI(api);
  const runtime = createRuntime(config, { post: fake.post, ...(runWorker ? { runWorker } : {}) });
  if (history) await seedIndex(runtime.store, history);
  return { dataDir, config, fake, runtime };
}
const input = (name, over = {}) => ({ ...parseHookInput({ stdin: JSON.stringify({ ...recorded(name), ...over }) }) });
const logLines = (dataDir) => {
  const dir = path.join(dataDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("turns-")).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map(JSON.parse)) : [];
};

test("recorded inputs: both hosts are recognised and parsed (session, turn key, sub-agent markers)", () => {
  const cp = parseHookInput({ stdin: JSON.stringify(recorded("claude-prompt.json")) });
  assert.equal(cp.host, "claude");
  assert.equal(cp.event, "prompt");
  assert.equal(cp.turn_key, recorded("claude-prompt.json").prompt_id);
  assert.equal(cp.agent_id, null);
  assert.throws(() => parseHookInput({ stdin: JSON.stringify(recorded("claude-stop.json")) }), /unsupported hook event "Stop"/, "the Stop hook is gone: a Stop payload is not a hook event this plugin handles");
  const xp = parseHookInput({ stdin: JSON.stringify(recorded("codex-prompt.json")) });
  assert.equal(xp.host, "codex");
  assert.equal(xp.turn_key, recorded("codex-prompt.json").turn_id);
  assert.equal(xp.transcript_path, null);
  const sub = parseHookInput({ stdin: JSON.stringify({ ...recorded("codex-prompt.json"), agent_id: "a1", agent_type: "worker" }) });
  assert.equal(sub.agent_id, "a1");
  const claudeSub = parseHookInput({ stdin: JSON.stringify({ ...recorded("claude-prompt.json"), transcript_path: "/h/projects/-x/5aaa/subagents/agent-1.jsonl" }) });
  assert.ok(claudeSub.agent_id, "a Claude hook inside a sub-agent is recognised by its transcript path");
  assert.throws(() => parseHookInput({ stdin: "" }), /empty stdin/);
  assert.throws(() => parseHookInput({ stdin: "{}" }), /cannot tell which host/);
  assert.throws(() => parseHookInput({ stdin: JSON.stringify({ ...recorded("codex-prompt.json"), hook_event_name: "PreToolUse" }) }), /unsupported hook event/);
  assert.throws(() => parseHookInput({ stdin: JSON.stringify({ ...recorded("codex-prompt.json"), session_id: undefined }) }), /no session_id/);
});

test("Every Code: the payload arrives in CODE_HOOK_PAYLOAD and the output is plain text / exit 2", () => {
  const p = parseHookInput({ env: { CODE_HOOK_PAYLOAD: JSON.stringify({ event: "user.prompt_submit", session_id: "s", turn_id: "t", cwd: "/x", model: "m", prompt: "hello" }) } });
  assert.deepEqual([p.host, p.event, p.turn_key, p.prompt], ["code", "prompt", "t", "hello"]);
  assert.throws(() => parseHookInput({ env: { CODE_HOOK_PAYLOAD: JSON.stringify({ event: "stop", session_id: "s", last_assistant_message: "x" }) } }), /unsupported hook event "stop"/);
  assert.deepEqual(promptOutput("code", "CTX"), { stdout: "CTX\n", stderr: "", exitCode: 0 });
  assert.deepEqual(promptOutput("code", null), { stdout: "", stderr: "", exitCode: 0 });
});

test("output contract: UserPromptSubmit JSON per host", () => {
  assert.deepEqual(JSON.parse(promptOutput("claude", null).stdout), { continue: true });
  assert.deepEqual(JSON.parse(promptOutput("codex", null).stdout), { continue: true });
  assert.deepEqual(JSON.parse(promptOutput("claude", "CTX").stdout), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "CTX" } });
  assert.deepEqual(JSON.parse(promptOutput("codex", "CTX").stdout), { continue: true, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "CTX" } });
});

for (const host of ["claude", "codex"]) {
  test(`${host} UserPromptSubmit: injects the earlier statement that matters, as additional context with date and repo`, async () => {
    const { config, runtime, dataDir } = await setup();
    const out = await handlePrompt({ input: input(`${host}-prompt.json`, { prompt: PROMPT }), config, runtime, now: () => new Date("2026-10-07T12:00:00Z") });
    const parsed = JSON.parse(out.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(parsed.continue === true, host === "codex");
    assert.ok(ctx.includes(CONTEXT_HEADER), ctx);
    assert.ok(ctx.startsWith("<recall-context>") && ctx.endsWith("</recall-context>"));
    assert.match(ctx, /- 2026-09-01 \(repo: shared-lib\): "We want a proper fix, no fallback things\./);
    assert.ok(!ctx.includes("lunch menu"), "the unrelated statement is below the gate");
    assert.equal(out.exitCode, 0);
    // the per-turn log
    const [entry] = logLines(dataDir).filter((l) => l.event === "prompt");
    assert.equal(entry.outcome, "injected");
    assert.equal(entry.host, host);
    assert.ok(entry.query.startsWith("The duplicate draft runs"));
    assert.ok(entry.candidates.length >= 2 && entry.candidates[0].score !== undefined && entry.candidates[0].parts);
    assert.deepEqual(entry.injected, ["h1"]);
    assert.ok(entry.latency_ms >= 0 && entry.context === ctx);
  });
}

test("UserPromptSubmit: at most RECALL_K statements, whatever the judge says", async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, ts: `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00Z`, text: `Rule ${i}: never add a fallback path or random limit when fixing the code structure, case ${i}.`, repo: "r" }));
  const a = await setup({ history: many, env: { RECALL_K: "3" } });
  const out = JSON.parse((await handlePrompt({ input: input("claude-prompt.json", { prompt: PROMPT }), config: a.config, runtime: a.runtime })).stdout);
  assert.equal(out.hookSpecificOutput.additionalContext.split("\n").filter((l) => l.startsWith("- ")).length, 3);
  const b = await setup({ history: many });
  const out5 = JSON.parse((await handlePrompt({ input: input("claude-prompt.json", { prompt: PROMPT }), config: b.config, runtime: b.runtime })).stdout);
  assert.equal(out5.hookSpecificOutput.additionalContext.split("\n").filter((l) => l.startsWith("- ")).length, 5, "default K is 5");
});

test("UserPromptSubmit: never recalls the live conversation or anything from the future", async () => {
  const hist = [...HISTORY, { id: "live", ts: "2026-10-07T11:00:00Z", text: "Right now in this very conversation: no fallback things and no random limits, fix the structure.", session_id: recorded("claude-prompt.json").session_id }];
  const { config, runtime } = await setup({ history: hist });
  const out = JSON.parse((await handlePrompt({ input: input("claude-prompt.json", { prompt: PROMPT }), config, runtime, now: () => new Date("2026-10-07T12:00:00Z") })).stdout);
  assert.ok(!out.hookSpecificOutput.additionalContext.includes("this very conversation"));
  const early = JSON.parse((await handlePrompt({ input: input("codex-prompt.json", { prompt: PROMPT }), config, runtime, now: () => new Date("2026-08-01T00:00:00Z") })).stdout);
  assert.deepEqual(early, { continue: true }, "before any history existed there is nothing to recall");
});

test("UserPromptSubmit: silent (and nothing is spent) for the kill switch, a child worker, a sub-agent, automation briefs, trivial prompts and an empty index", async () => {
  const cases = [
    ["kill switch", { RECALL_DISABLED: "1" }, {}, "disabled"],
    ["child worker", { RECALL_CHILD: "1" }, {}, "child"],
    ["sub-agent turn", {}, { agent_id: "agent-1", agent_type: "worker" }, "subagent"],
    ["automation brief (fleet profile on)", { RECALL_FILTER_PROFILES: "fleet" }, { prompt: "# Lane: web-app search requests a page-sized k instead of 480\n\nRead the brief and fix the retrieval path with no fallbacks please." }, "not-owner-text:agent-brief"],
    ["a turn matching a dropPattern", { RECALL_DROP_PATTERNS: JSON.stringify(["^nightly report:"]) }, { prompt: "Nightly report: fixed the retrieval path with no fallbacks please." }, "not-owner-text:drop-pattern"],
    ["task notification", {}, { prompt: "<task-notification>\n<task-id>b7e</task-id>\n<summary>Monitor event: new files</summary>\n</task-notification>" }, "not-owner-text:agent-completion"],
    ["trivial prompt", {}, { prompt: "yes please go ahead" }, "not-owner-text:too-short"],
    ["skill button", {}, { prompt: "[$release](/home/x/.codex/skills/release/SKILL.md)" }, "not-owner-text:skill-invocation"],
  ];
  for (const [name, env, over, reason] of cases) {
    const { config, runtime, fake, dataDir } = await setup({ env });
    const out = await handlePrompt({ input: input("codex-prompt.json", { prompt: PROMPT, ...over }), config, runtime });
    assert.deepEqual(JSON.parse(out.stdout), { continue: true }, name);
    assert.equal(fake.calls.length, 0, `${name}: no API call`);
    assert.equal(logLines(dataDir).at(-1).reason, reason, name);
  }
  const empty = await setup({ history: null });
  const out = await handlePrompt({ input: input("claude-prompt.json", { prompt: PROMPT }), config: empty.config, runtime: empty.runtime });
  assert.deepEqual(JSON.parse(out.stdout), { continue: true });
  assert.equal(logLines(empty.dataDir).at(-1).reason, "empty-index");
});

test("UserPromptSubmit: without the fleet profile a brief-shaped prompt is a prompt like any other (searched, not silenced)", async () => {
  const { config, runtime, fake, dataDir } = await setup({});
  const prompt = "# Lane: web-app search requests a page-sized k instead of 480\n\nRead the brief and fix the retrieval path with no fallbacks please.";
  await handlePrompt({ input: input("codex-prompt.json", { prompt }), config, runtime });
  assert.notEqual(logLines(dataDir).at(-1).reason, "not-owner-text:agent-brief");
  assert.ok(fake.calls.length > 0, "the prompt reached the search");
});

test("UserPromptSubmit: an API failure or timeout means NO injection and a LOUD log entry; nothing is invented", async () => {
  const { config, dataDir } = await setup();
  for (const [name, err] of [["server error", new Error("POST https://api.openai.com/v1/decisions: 503 after 7 attempts")], ["timeout", Object.assign(new Error("no response within 20000ms"), { name: "RecallTimeoutError" })]]) {
    const fake = fakeOpenAI();
    const runtime = createRuntime(config, { post: async (url, body) => { if (url.endsWith("/v1/decisions")) throw err; return fake.post(url, body); } });
    const out = await handlePrompt({ input: input("claude-prompt.json", { prompt: PROMPT }), config, runtime });
    assert.deepEqual(JSON.parse(out.stdout), { continue: true }, name);
    const e = logLines(dataDir).filter((l) => l.level === "error").at(-1);
    assert.equal(e.reason, "retrieval-failed", name);
    assert.ok(e.error.includes(err.name) && e.error.includes(err.message), e.error);
    assert.equal(e.outcome, "silent");
  }
});

test("UserPromptSubmit: the hard deadline cuts a stuck retrieval short (silent + loud log)", async () => {
  const { dataDir } = await setup();
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_TIMEOUT_MS: "1000", RECALL_DAILY_CAP_USD: "5", RECALL_ALLOW_HEADLESS: "1" });
  const fake = fakeOpenAI();
  const runtime = createRuntime(config, { post: (url, body) => (url.endsWith("/v1/decisions") ? new Promise(() => {}) : fake.post(url, body)) });
  const t0 = Date.now();
  const out = await handlePrompt({ input: input("claude-prompt.json", { prompt: PROMPT }), config, runtime });
  assert.ok(Date.now() - t0 < 4000);
  assert.deepEqual(JSON.parse(out.stdout), { continue: true });
  assert.match(logLines(dataDir).filter((l) => l.level === "error").at(-1).error, /RecallDeadline.*exceeded 1000ms/);
});

test("UserPromptSubmit: a cap hit is also silent plus a loud log", async () => {
  const { dataDir } = await setup();
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_DAILY_CAP_USD: "0.0000001", RECALL_ALLOW_HEADLESS: "1" });
  const out = await handlePrompt({ input: input("claude-prompt.json", { prompt: PROMPT }), config, runtime: createRuntime(config, { post: fakeOpenAI().post }) });
  assert.deepEqual(JSON.parse(out.stdout), { continue: true });
  assert.match(logLines(dataDir).filter((l) => l.level === "error").at(-1).error, /CapExceededError.*daily/);
});

test("auto-index: started in the background at most once per interval, guarded by a lock; off with RECALL_AUTO_INDEX=0", async () => {
  const dataDir = tmpDir("recall-auto");
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "1", RECALL_AUTO_INDEX_MINUTES: "30" });
  const runtime = createRuntime(config, { post: fakeOpenAI().post });
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => { spawned.push({ args, opts }); return { unref() {} }; };
  assert.equal(maybeStartIndex({ config, store: runtime.store, spawnImpl }).started, true);
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(spawned[0].opts.env.RECALL_AUTO_INDEX, "0", "the background index never starts another");
  assert.equal(maybeStartIndex({ config, store: runtime.store, spawnImpl }).reason, "index-running");
  fs.rmSync(path.join(dataDir, "state", "index.lock"));
  runtime.store.saveState({ files: {}, lastIndexAt: new Date().toISOString() });
  assert.equal(maybeStartIndex({ config, store: runtime.store, spawnImpl }).reason, "indexed-recently");
  const off = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0" });
  assert.equal(maybeStartIndex({ config: off, store: runtime.store, spawnImpl }).reason, "auto-index-off");
  assert.equal(spawned.length, 1);
});

// ---- the real scripts, as a host runs them: stdin in, stdout out, a local fake OpenAI behind RECALL_OPENAI_BASE_URL ----
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

test("scripts: user-prompt-submit.mjs as a subprocess, for both hosts, stdout is exactly one JSON document", async () => {
  const server = await startFakeServer({ decide: ({ instructions }) => (/fallback/.test(instructions) ? 0.99 : 0.04) });
  try {
    const dataDir = tmpDir("recall-sub");
    const base = { ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", OPENAI_API_KEY: "sk-test", RECALL_OPENAI_BASE_URL: server.url, RECALL_DAILY_CAP_USD: "5", RECALL_ALLOW_HEADLESS: "1", HOME: dataDir };
    await seedIndex((await import("../scripts/lib/store.mjs")).createStore(dataDir), HISTORY);
    for (const host of ["claude", "codex"]) {
      const p = await runScript("user-prompt-submit.mjs", { stdin: JSON.stringify({ ...recorded(`${host}-prompt.json`), prompt: PROMPT }), env: base });
      assert.equal(p.code, 0, p.stderr);
      const out = JSON.parse(p.stdout);
      assert.ok(out.hookSpecificOutput.additionalContext.includes(CONTEXT_HEADER));
      assert.equal(p.stdout.trim().split("\n").length, 1, "one line of JSON, nothing else on stdout");
    }
    const killed = await runScript("user-prompt-submit.mjs", { stdin: JSON.stringify({ ...recorded("claude-prompt.json"), prompt: PROMPT }), env: { ...base, RECALL_DISABLED: "1" } });
    assert.deepEqual(JSON.parse(killed.stdout), { continue: true });
    const garbage = await runScript("user-prompt-submit.mjs", { stdin: "not json", env: base });
    assert.equal(garbage.code, 0);
    assert.deepEqual(JSON.parse(garbage.stdout), { continue: true });
    assert.match(garbage.stderr, /\[recall ERROR\]/);
    const code = await runScript("user-prompt-submit.mjs", { stdin: "", env: { ...base, CODE_HOOK_PAYLOAD: JSON.stringify({ event: "user.prompt_submit", session_id: "sess-code", turn_id: "t1", cwd: "/x", model: "m", prompt: PROMPT }) } });
    assert.equal(code.code, 0, code.stderr);
    assert.ok(code.stdout.startsWith("<recall-context>") && code.stdout.includes(CONTEXT_HEADER), "Every Code: plain stdout is injected raw as context");
    // the billed calls were ledgered (repeats of an identical request are served from the response cache and cost nothing)
    const ledger = fs.readFileSync(path.join(dataDir, "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(ledger.length >= 2 && ledger.every((l) => l.experiment === "plugin-recall" && l.costUsd > 0));
  } finally {
    await server.close();
  }
});
