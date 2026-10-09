// Headless and automation sessions are silent. The evidence: hook payloads, hook-process env, transcript lines and rollout session_meta
// records captured from REAL runs on 2026-10-08 (test/fixtures/headless; docs/hosts.md section 6). No network.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, V1_ENV } from "../scripts/lib/config.mjs";
import { classifySession } from "../scripts/lib/headless.mjs";
import { parseHookInput } from "../scripts/lib/hook-io.mjs";
import { summarizeLogs } from "../scripts/lib/log-summary.mjs";
import { handlePrompt } from "../scripts/lib/prompt-hook.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { createTurnState } from "../scripts/lib/turn-log.mjs";
import { fakeOpenAI, FIXTURES, readFixture, seedIndex, startFakeServer, tmpDir } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = JSON.parse(readFixture("headless", "hook-payloads.json"));
const CLAUDE_LINES = JSON.parse(readFixture("claude-lines.json"));
const NESTED_P_LINE = JSON.parse(readFixture("headless", "claude-transcript-lines.json")).nested_claude_p_user;
const rollout = (name) => path.join(FIXTURES, "headless", "rollouts", name);

/** A transcript file holding the given raw lines, in a temp dir. */
function transcript(...lines) {
  const f = path.join(tmpDir("recall-tx"), "session.jsonl");
  fs.writeFileSync(f, `${lines.join("\n")}\n`);
  return f;
}
// The Claude payloads point at a transcript path that does not exist. Tests use a path that has no file yet (exactly the situation at the
// first UserPromptSubmit of a session) or one built from synthetic lines.
const NO_TRANSCRIPT_YET = () => path.join(tmpDir("recall-tx"), "not-written-yet.jsonl");
const claudeInput = (over = {}, from = "claude_p_nested_in_desktop") => parseHookInput({ stdin: JSON.stringify({ ...P[from].stdin, transcript_path: NO_TRANSCRIPT_YET(), ...over }) });
const codexInput = (from, transcript_path) => parseHookInput({ stdin: JSON.stringify({ ...P[from].stdin, ...(transcript_path !== undefined ? { transcript_path } : {}) }) });
const verdict = async (input, env) => { const v = await classifySession({ input, env }); return [v.interactive, v.reason]; };

test("fixtures are what they say: a nested `claude -p` hook env, an attended desktop env, a codex exec hook env that leaked Claude's variables", () => {
  assert.equal(P.claude_p_nested_in_desktop.env.CLAUDE_CODE_SESSION_ATTENDED, "0");
  assert.equal(P.claude_p_nested_in_desktop.env.CLAUDE_CODE_ENTRYPOINT, "claude-desktop", "the entrypoint env var is inherited from the parent: it cannot tell a nested -p from the parent");
  assert.equal(P.claude_desktop_attended_env.env.CLAUDE_CODE_SESSION_ATTENDED, "1");
  assert.equal(P.codex_exec_hook_env_inherited_from_claude.env.CLAUDE_CODE_SESSION_ATTENDED, "1");
  const nested = JSON.parse(NESTED_P_LINE);
  assert.deepEqual([nested.entrypoint, nested.promptSource, nested.turnOrigin, nested.origin], ["claude-desktop", "sdk", "sdk", undefined]);
  assert.equal(JSON.parse(rollout("codex-exec.jsonl") && fs.readFileSync(rollout("codex-exec.jsonl"), "utf8")).payload.source, "exec");
});

test("Claude: CLAUDE_CODE_SESSION_ATTENDED decides: 0 is a headless session, 1 an attended one", async () => {
  assert.deepEqual(await verdict(claudeInput(), P.claude_p_nested_in_desktop.env), [false, "headless:claude-unattended"]);
  assert.deepEqual(await verdict(claudeInput(), P.claude_desktop_attended_env.env), [true, "interactive:claude-attended"]);
});

test("Claude: the transcript can only make it quieter: a program's newest prompt silences even an 'attended' env", async () => {
  const attended = P.claude_desktop_attended_env.env;
  // the real nested `claude -p` record: entrypoint is the inherited claude-desktop, only turnOrigin sdk gives it away
  const nested = claudeInput({ transcript_path: transcript(NESTED_P_LINE) });
  assert.deepEqual(await verdict(nested, attended), [false, "headless:claude-transcript-turn-origin-sdk"]);
  // a real `claude -p` from a plain shell: entrypoint sdk-cli
  const sdkCli = claudeInput({ transcript_path: transcript(CLAUDE_LINES.sdk_cli) });
  assert.deepEqual(await verdict(sdkCli, attended), [false, "headless:claude-transcript-entrypoint-sdk-cli"]);
  // a human-typed desktop prompt (origin human) stays interactive
  const human = claudeInput({ transcript_path: transcript(CLAUDE_LINES.human_typed) });
  assert.deepEqual(await verdict(human, attended), [true, "interactive:claude-attended"]);
  // only the NEWEST real user record counts: tool results, meta records and queue operations after it are skipped; an older program prompt does not
  const resumed = claudeInput({ transcript_path: transcript(CLAUDE_LINES.sdk_cli, CLAUDE_LINES.human_typed, CLAUDE_LINES.tool_result, CLAUDE_LINES.meta, CLAUDE_LINES.queue_enqueue) });
  assert.deepEqual(await verdict(resumed, attended), [true, "interactive:claude-attended"]);
});

test("Claude: without the attendance env var (older Claude) a human-origin transcript record is the proof, the first turn is 'unknown' and silent", async () => {
  assert.deepEqual(await verdict(claudeInput({ transcript_path: transcript(CLAUDE_LINES.human_typed) }), {}), [true, "interactive:claude-transcript-human"]);
  assert.deepEqual(await verdict(claudeInput({ transcript_path: path.join(tmpDir(), "does-not-exist-yet.jsonl") }), {}), [false, "unknown:claude-no-attendance-signal"]);
  assert.deepEqual(await verdict(claudeInput({ transcript_path: null }), {}), [false, "unknown:claude-no-attendance-signal"]);
  assert.deepEqual(await verdict(claudeInput({ transcript_path: transcript(NESTED_P_LINE) }), {}), [false, "headless:claude-transcript-turn-origin-sdk"]);
  assert.deepEqual(await verdict(claudeInput(), { CLAUDE_CODE_SESSION_ATTENDED: "maybe" }), [false, "unknown:claude-attended-value"]);
  const dir = tmpDir();
  assert.equal((await classifySession({ input: claudeInput({ transcript_path: dir }), env: {} })).reason, "unknown:claude-transcript-unreadable", "a transcript that cannot be read is loud, not a guess");
});

test("Claude: host-declared scheduled runs and background/daemon sessions are headless even when attended", async () => {
  const attended = P.claude_desktop_attended_env.env;
  assert.deepEqual(await verdict(claudeInput(), { ...attended, CLAUDE_CODE_HOST_SCHEDULED_RUN: "1" }), [false, "headless:claude-scheduled-run"]);
  assert.deepEqual(await verdict(claudeInput(), { ...attended, CLAUDE_CODE_SESSION_KIND: "bg" }), [false, "headless:claude-session-kind-bg"]);
  assert.deepEqual(await verdict(claudeInput(), { ...attended, CLAUDE_CODE_SESSION_KIND: "daemon-worker" }), [false, "headless:claude-session-kind-daemon-worker"]);
  assert.deepEqual(await verdict(claudeInput(), { ...attended, CLAUDE_CODE_HOST_SCHEDULED_RUN: "0" }), [true, "interactive:claude-attended"]);
});

test("Codex: the rollout's session_meta decides; Claude's environment variables mean nothing to it", async () => {
  const leaked = P.codex_exec_hook_env_inherited_from_claude.env; // CLAUDE_CODE_SESSION_ATTENDED=1 inside a real codex exec
  assert.deepEqual(await verdict(codexInput("codex_exec", rollout("codex-exec.jsonl")), leaked), [false, "headless:rollout-exec"]);
  assert.deepEqual(await verdict(codexInput("codex_tui", rollout("codex-tui.jsonl")), { CLAUDE_CODE_SESSION_ATTENDED: "0" }), [true, "interactive:rollout-cli"]);
  assert.deepEqual(await verdict(codexInput("codex_tui", rollout("codex-security-scan.jsonl")), {}), [false, "headless:rollout-thread-source-security_scan"]);
  const desktop = path.join(FIXTURES, "codex", "sessions", "2026", "09", "02", "rollout-2026-09-02T15-02-46-0190a000-aaaa-7000-8000-00000000c001.jsonl");
  assert.deepEqual(await verdict(codexInput("codex_tui", desktop), {}), [true, "interactive:rollout-vscode"]);
  const sub = path.join(FIXTURES, "codex", "sessions", "2026", "10", "07", "rollout-2026-10-07T22-22-10-6d42834b-e02f-76a9-b708-386e5678b2e6.jsonl");
  assert.deepEqual(await verdict(codexInput("codex_tui", sub), {}), [false, "headless:rollout-subagent"]);
  const exec2 = path.join(FIXTURES, "codex", "sessions", "2026", "10", "07", "rollout-2026-10-07T22-20-07-7f5988a4-1382-7435-ba91-71ff27dfb3da.jsonl");
  assert.deepEqual(await verdict(codexInput("codex_tui", exec2), {}), [false, "headless:rollout-exec"]);
});

test("Codex: no rollout (codex exec --ephemeral, Codex's internal memory agent) or an unreadable one gives no evidence: silent, 'unknown'", async () => {
  assert.equal(P.codex_memory_agent.stdin.transcript_path, null);
  assert.ok(P.codex_memory_agent.stdin.prompt.startsWith("## Memory Writing Agent"));
  assert.deepEqual(await verdict(codexInput("codex_memory_agent"), {}), [false, "unknown:codex-no-rollout"]);
  assert.deepEqual(await verdict(codexInput("codex_exec", null), {}), [false, "unknown:codex-no-rollout"]);
  assert.deepEqual(await verdict(codexInput("codex_tui", path.join(tmpDir(), "gone.jsonl")), {}), [false, "unknown:codex-rollout-unreadable"]);
  const noMeta = path.join(tmpDir(), "rollout.jsonl");
  fs.writeFileSync(noMeta, '{"type":"turn_context","payload":{}}\n');
  assert.deepEqual(await verdict(codexInput("codex_tui", noMeta), {}), [false, "unknown:codex-no-session-meta"]);
});

test("Every Code: its rollout (source cli, no thread_source) is interactive; source exec is not; no rollout is unknown", async () => {
  const code = path.join(FIXTURES, "code", "sessions", "2026", "05", "29", "rollout-2026-05-29T13-57-42-0190b000-bbbb-7000-8000-00000000e001.jsonl");
  const payload = (transcript_path) => parseHookInput({ env: { CODE_HOOK_PAYLOAD: JSON.stringify({ event: "user.prompt_submit", session_id: "s", turn_id: "t", transcript_path, cwd: "/x", model: "m", prompt: "p" }) } });
  assert.deepEqual(await verdict(payload(code), {}), [true, "interactive:rollout-cli"]);
  const first = fs.readFileSync(code, "utf8").split("\n")[0];
  assert.match(first, /"originator":"code_cli_rs".*"source":"cli"/);
  const exec = path.join(tmpDir(), "rollout-exec.jsonl");
  fs.writeFileSync(exec, `${first.replace('"source":"cli"', '"source":"exec"')}\n`);
  assert.deepEqual(await verdict(payload(exec), {}), [false, "headless:rollout-exec"]);
  assert.deepEqual(await verdict(payload(null), {}), [false, "unknown:code-no-rollout"]);
});

// ---- the hooks themselves ----
const HISTORY = [{ id: "h1", ts: "2026-09-01T10:00:00Z", text: "We want a proper fix, no fallback things. Do not add random limits, fix the code structure instead.", repo: "shared-lib" }];
const PROMPT = "The duplicate draft runs come from a re-execution path, so I will add a fallback path with a random limit to stop them.";
const decide = ({ instructions }) => (/fallback/.test(instructions) ? 0.99 : 0.04);

async function setup(env = {}) {
  const dataDir = tmpDir("recall-headless");
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_DAILY_CAP_USD: "5", ...env });
  const fake = fakeOpenAI({ decide });
  const runtime = createRuntime(config, { post: fake.post });
  await seedIndex(runtime.store, HISTORY);
  return { dataDir, config, fake, runtime };
}
const logLines = (dataDir) => {
  const dir = path.join(dataDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("turns-")).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map(JSON.parse)) : [];
};
const NOW = () => new Date("2026-10-07T12:00:00Z");

test("UserPromptSubmit in a headless Claude session: no API call, nothing injected, the reason logged, no session state", async () => {
  const s = await setup();
  const env = P.claude_p_nested_in_desktop.env;
  const prompt = await handlePrompt({ input: claudeInput({ prompt: PROMPT }), config: s.config, runtime: s.runtime, now: NOW, env });
  assert.deepEqual(JSON.parse(prompt.stdout), { continue: true });
  assert.equal(createTurnState(s.dataDir).read(P.claude_p_nested_in_desktop.stdin.session_id), null, "a silenced headless turn leaves no session state");
  assert.equal(s.fake.calls.length, 0, "no embedding, no Decisions call");
  assert.ok(!fs.existsSync(path.join(s.dataDir, "ledger.jsonl")), "nothing was spent");
  const lines = logLines(s.dataDir);
  assert.deepEqual(lines.map((l) => [l.event, l.outcome, l.reason]), [["prompt", "silent", "headless:claude-unattended"]]);
  assert.equal(lines[0].signals.attended, "0");
  assert.ok(lines.every((l) => l.level === "info" && !("stats" in l) && !("costUsd" in l)), "counts only: no spend, no query text");
});

test("the same hooks in an attended Claude session and an interactive Codex TUI session still work (the gate admits people)", async () => {
  const s = await setup();
  const claude = await handlePrompt({ input: claudeInput({ prompt: PROMPT, session_id: "attended-claude" }), config: s.config, runtime: s.runtime, now: NOW, env: P.claude_desktop_attended_env.env });
  assert.match(JSON.parse(claude.stdout).hookSpecificOutput.additionalContext, /no fallback things/);
  const codex = await handlePrompt({ input: parseHookInput({ stdin: JSON.stringify({ ...P.codex_tui.stdin, prompt: PROMPT, transcript_path: rollout("codex-tui.jsonl") }) }), config: s.config, runtime: s.runtime, now: NOW, env: {} });
  assert.match(JSON.parse(codex.stdout).hookSpecificOutput.additionalContext, /no fallback things/);
  assert.ok(logLines(s.dataDir).every((l) => !String(l.reason ?? "").startsWith("headless:")));
});

test("headless Codex exec, Codex's memory agent and Every Code exec are silent too", async () => {
  const s = await setup();
  const exec = await handlePrompt({ input: parseHookInput({ stdin: JSON.stringify({ ...P.codex_exec.stdin, prompt: PROMPT, transcript_path: rollout("codex-exec.jsonl") }) }), config: s.config, runtime: s.runtime, now: NOW, env: {} });
  const memory = await handlePrompt({ input: parseHookInput({ stdin: JSON.stringify({ ...P.codex_memory_agent.stdin, prompt: PROMPT }) }), config: s.config, runtime: s.runtime, now: NOW, env: {} });
  for (const out of [exec, memory]) assert.deepEqual(JSON.parse(out.stdout), { continue: true });
  assert.equal(s.fake.calls.length, 0);
  assert.deepEqual(logLines(s.dataDir).map((l) => l.reason), ["headless:rollout-exec", "unknown:codex-no-rollout"]);
  const code = parseHookInput({ env: { CODE_HOOK_PAYLOAD: JSON.stringify({ event: "user.prompt_submit", session_id: "s", turn_id: "t", transcript_path: null, prompt: PROMPT }) } });
  const codeOut = await handlePrompt({ input: code, config: s.config, runtime: s.runtime, now: NOW, env: {} });
  assert.deepEqual(codeOut, { stdout: "", stderr: "", exitCode: 0 }, "Every Code: no context");
});

test("RECALL_ALLOW_HEADLESS=1 re-enables the hooks for a deliberate smoke test, in every kind of headless session", async () => {
  const s = await setup({ RECALL_ALLOW_HEADLESS: "1" });
  assert.equal(s.config.allowHeadless, true);
  const out = await handlePrompt({ input: claudeInput({ prompt: PROMPT }), config: s.config, runtime: s.runtime, now: NOW, env: P.claude_p_nested_in_desktop.env });
  assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /no fallback things/);
  const memory = await handlePrompt({ input: parseHookInput({ stdin: JSON.stringify({ ...P.codex_memory_agent.stdin, prompt: PROMPT }) }), config: s.config, runtime: s.runtime, now: NOW, env: {} });
  assert.match(JSON.parse(memory.stdout).hookSpecificOutput.additionalContext, /no fallback things/);
  assert.equal(loadConfig({}).allowHeadless, false, "off by default");
  assert.throws(() => loadConfig({ ...V1_ENV, RECALL_ALLOW_HEADLESS: "sometimes" }), /RECALL_ALLOW_HEADLESS/);
});

test("the kill switch and sub-agent checks still come first, and cost nothing", async () => {
  const s = await setup({ RECALL_DISABLED: "1" });
  await handlePrompt({ input: claudeInput({ prompt: PROMPT }), config: s.config, runtime: s.runtime, now: NOW, env: P.claude_desktop_attended_env.env });
  assert.equal(logLines(s.dataDir).at(-1).reason, "disabled");
});

test("hook scripts as subprocesses with the real environment: headless sessions print exactly {continue:true}, call nothing, and are counted in the log", async () => {
  const server = await startFakeServer({ decide });
  try {
    const dataDir = tmpDir("recall-sub-headless");
    await seedIndex((await import("../scripts/lib/store.mjs")).createStore(dataDir), HISTORY);
    const base = { ...V1_ENV, PATH: process.env.PATH, HOME: dataDir, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", OPENAI_API_KEY: "sk-test", RECALL_OPENAI_BASE_URL: server.url, RECALL_DAILY_CAP_USD: "5" };
    const run = (script, stdin, env) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "scripts", script)], { env: { ...base, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });
    const cases = [
      ["user-prompt-submit.mjs", { ...P.claude_p_nested_in_desktop.stdin, transcript_path: NO_TRANSCRIPT_YET(), prompt: PROMPT }, P.claude_p_nested_in_desktop.env],
      ["user-prompt-submit.mjs", { ...P.codex_exec.stdin, prompt: PROMPT, transcript_path: rollout("codex-exec.jsonl") }, P.codex_exec_hook_env_inherited_from_claude.env],
      ["user-prompt-submit.mjs", { ...P.codex_memory_agent.stdin, prompt: PROMPT }, {}],
    ];
    for (const [script, payload, env] of cases) {
      const r = await run(script, JSON.stringify(payload), env);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { continue: true });
      assert.equal(r.stderr, "", "silent means silent: nothing on stderr either");
    }
    assert.equal(server.calls.length, 0, "not one request reached the API");
    assert.ok(!fs.existsSync(path.join(dataDir, "ledger.jsonl")));
    const counts = summarizeLogs(dataDir, [new Date().toISOString().slice(0, 10)]);
    assert.equal(counts.turns, 3);
    assert.deepEqual(counts.silentReasons, { "headless:claude-unattended": 1, "headless:rollout-exec": 1, "unknown:codex-no-rollout": 1 });
    assert.equal(counts.silencedHeadless, 2);
    assert.equal(counts.silencedUnknown, 1);
    // Every Code through CODE_HOOK_PAYLOAD: plain stdout stays empty and the exit code 0
    const code = await run("user-prompt-submit.mjs", "", { CODE_HOOK_PAYLOAD: JSON.stringify({ event: "user.prompt_submit", session_id: "sc", turn_id: "t", transcript_path: rollout("codex-exec.jsonl"), prompt: PROMPT }) });
    assert.deepEqual([code.code, code.stdout, code.stderr], [0, "", ""]);
    // and with the override the same payload goes through the whole pipeline
    const on = await run("user-prompt-submit.mjs", JSON.stringify({ ...P.claude_p_nested_in_desktop.stdin, transcript_path: NO_TRANSCRIPT_YET(), prompt: PROMPT }), { ...P.claude_p_nested_in_desktop.env, RECALL_ALLOW_HEADLESS: "1" });
    assert.match(JSON.parse(on.stdout).hookSpecificOutput.additionalContext, /no fallback things/);
    assert.ok(server.calls.length > 0);
  } finally {
    await server.close();
  }
});
