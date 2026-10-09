// Origin fields on every turn log line (host, home, cwd, project, transcript, turn_key), on synthetic payloads shaped like those of Claude Code, Codex
// and Every Code hooks (test/fixtures/hook-inputs, test/fixtures/headless/hook-payloads.json). No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, V1_ENV } from "../scripts/lib/config.mjs";
import { parseHookInput } from "../scripts/lib/hook-io.mjs";
import { handlePrompt } from "../scripts/lib/prompt-hook.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { homeOfTranscript, turnMeta } from "../scripts/lib/turn-meta.mjs";
import { fakeOpenAI, readFixture, seedIndex, tmpDir } from "./helpers.mjs";

const HOME = "/home/sam";
const recorded = (name) => JSON.parse(readFixture("hook-inputs", name));
const P = JSON.parse(readFixture("headless", "hook-payloads.json"));
const parse = (o) => parseHookInput({ stdin: JSON.stringify(o) });
const EVERY_CODE = { event: "user.prompt_submit", session_id: "sess-code", turn_id: "t1", transcript_path: "/home/sam/.code/sessions/2026/10/08/rollout-2026-10-08T09-00-00-sess-code.jsonl", cwd: "/home/sam/projects/agent-shell/", model: "gpt-6-astra", prompt: "hello" };

test("home is the dot-directory under the user's home dir that holds the transcript, null when unknown", () => {
  assert.equal(homeOfTranscript(recorded("claude-prompt.json").transcript_path, HOME), "~/.claude");
  assert.equal(homeOfTranscript(P.codex_tui.stdin.transcript_path, HOME), "~/.codex");
  assert.equal(homeOfTranscript(EVERY_CODE.transcript_path, HOME), "~/.code");
  assert.equal(homeOfTranscript(null, HOME), null, "Codex's ephemeral and memory agents have no transcript");
  assert.equal(homeOfTranscript(P.codex_memory_agent.stdin.transcript_path, HOME), null);
  assert.equal(homeOfTranscript("/var/folders/x/rollout.jsonl", HOME), null, "outside the home dir");
  assert.equal(homeOfTranscript("/home/sam/projects/notes.jsonl", HOME), null, "inside the home dir but not under a dot-directory");
  assert.equal(homeOfTranscript("/home/samother/.claude/x.jsonl", HOME), null, "a sibling directory that merely shares the prefix");
  assert.equal(homeOfTranscript("/home/sam", HOME), null);
});

test("turnMeta on the recorded payloads of all three hosts", () => {
  const claude = turnMeta(parse(recorded("claude-prompt.json")), { homedir: HOME });
  assert.deepEqual(claude, {
    host: "claude", turn_key: recorded("claude-prompt.json").prompt_id, home: "~/.claude",
    cwd: recorded("claude-prompt.json").cwd, project: "scratchpad", transcript: recorded("claude-prompt.json").transcript_path,
  });
  const tui = turnMeta(parse(P.codex_tui.stdin), { homedir: HOME });
  assert.equal(tui.host, "codex");
  assert.equal(tui.home, "~/.codex");
  assert.equal(tui.project, "icwd");
  assert.equal(tui.turn_key, P.codex_tui.stdin.turn_id);
  const memory = turnMeta(parse(P.codex_memory_agent.stdin), { homedir: HOME });
  assert.deepEqual([memory.home, memory.transcript, memory.project], [null, null, "memories"]);
  const code = turnMeta(parseHookInput({ env: { CODE_HOOK_PAYLOAD: JSON.stringify(EVERY_CODE) } }), { homedir: HOME });
  assert.deepEqual([code.host, code.home, code.project, code.turn_key], ["code", "~/.code", "agent-shell", "t1"], "a trailing slash on cwd does not empty the project");
  const bare = turnMeta(parseHookInput({ env: { CODE_HOOK_PAYLOAD: JSON.stringify({ event: "user.prompt_submit", session_id: "s", prompt: "x" }) } }), { homedir: HOME });
  assert.deepEqual([bare.cwd, bare.project, bare.home, bare.transcript, bare.turn_key], [null, null, null, null, null], "absent fields are explicit nulls");
});

const logLines = (dataDir) => fs.readdirSync(path.join(dataDir, "logs")).flatMap((f) => fs.readFileSync(path.join(dataDir, "logs", f), "utf8").trim().split("\n").map(JSON.parse));

test("the hook writes the origin fields on every line it logs: injected and silent", async () => {
  const dataDir = tmpDir("recall-meta");
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_DAILY_CAP_USD: "5", RECALL_ALLOW_HEADLESS: "1" });
  const fake = fakeOpenAI();
  const runtime = createRuntime(config, { post: fake.post });
  await seedIndex(runtime.store, [{ id: "h1", ts: "2026-09-01T10:00:00Z", text: "We want a proper fix, no fallback things. Do not add random limits, fix the code structure instead.", repo: "web-app" }]);
  const transcript = path.join(os.homedir(), ".claude", "projects", "-home-sam-projects-demo-repo", "s1.jsonl");
  const payload = { ...recorded("claude-prompt.json"), transcript_path: transcript, cwd: "/home/sam/projects/demo-repo", prompt: "The duplicate draft runs come from a re-execution path, so I will add a fallback path with a random limit to stop them." };
  const now = () => new Date("2026-10-08T01:00:00Z");
  await handlePrompt({ input: parse(payload), config, runtime, now });
  // a silent one: the kill switch, which needs no API call and goes through the same base
  const off = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_DISABLED: "1" });
  await handlePrompt({ input: parse({ ...payload, prompt_id: "second-turn" }), config: off, runtime, now });
  const lines = logLines(dataDir);
  assert.deepEqual(lines.map((l) => [l.event, l.outcome]), [["prompt", "injected"], ["prompt", "silent"]]);
  for (const l of lines) {
    assert.equal(l.host, "claude");
    assert.equal(l.home, "~/.claude");
    assert.equal(l.cwd, payload.cwd);
    assert.equal(l.project, "demo-repo");
    assert.equal(l.transcript, transcript);
    assert.ok(typeof l.turn_key === "string" && l.turn_key);
  }
  assert.equal(lines[0].turn_key, payload.prompt_id);
  assert.equal(lines[1].turn_key, "second-turn");
  assert.equal(lines[1].reason, "disabled");
});

test("a Codex session without a transcript logs home and transcript as null, not missing", async () => {
  const dataDir = tmpDir("recall-meta-codex");
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_DISABLED: "1" });
  await handlePrompt({ input: parse(P.codex_memory_agent.stdin), config, runtime: createRuntime(config), now: () => new Date("2026-10-08T01:00:00Z") });
  const [line] = logLines(dataDir);
  assert.deepEqual([line.host, line.home, line.transcript, line.project, line.turn_key], ["codex", null, null, "memories", P.codex_memory_agent.stdin.turn_id]);
  assert.ok(Object.hasOwn(line, "home") && Object.hasOwn(line, "transcript"));
});
