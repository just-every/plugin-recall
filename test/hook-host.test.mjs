// The host is read off the payload; a payload without the usual marker keys is still classified by where its transcript lives.
import test from "node:test";
import assert from "node:assert/strict";
import { parseHookInput } from "../scripts/lib/hook-io.mjs";

const base = { session_id: "s1", cwd: "/home/sam/projects/billing-api", hook_event_name: "UserPromptSubmit", prompt: "hello there" };
const parse = (o, env = {}) => parseHookInput({ stdin: JSON.stringify({ ...base, ...o }), env });

test("a Claude payload without prompt_id or scratchpad_dir is recognised by its transcript path, in any home", () => {
  assert.equal(parse({ transcript_path: "/home/sam/.claude/projects/-home-sam-projects-billing-api/s1.jsonl" }).host, "claude");
  assert.equal(parse({ transcript_path: "/srv/agents/work-home/projects/-home-sam-projects-billing-api/s1.jsonl" }).host, "claude");
});

test("a Codex payload without turn_id or model is recognised by its rollout path", () => {
  assert.equal(parse({ transcript_path: "/home/sam/.codex/sessions/2026/09/02/rollout-2026-09-02T15-02-46-0190a000-aaaa-7000-8000-00000000c001.jsonl" }).host, "codex");
});

test("a payload that names no host at all is still refused loudly", () => {
  assert.throws(() => parse({ transcript_path: "/tmp/x.jsonl" }), /cannot tell which host/);
});
