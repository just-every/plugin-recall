// The conversation turns of a live transcript, read from its tail for the prompt-time situation (synthetic lines in fixtures/tail-lines.json).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { conversationTurns } from "../scripts/lib/transcripts/tail.mjs";
import { readFixture, tmpDir } from "./helpers.mjs";

const L = JSON.parse(readFixture("tail-lines.json"));
const write = (name, lines) => { const f = path.join(tmpDir("recall-tail"), name); fs.writeFileSync(f, `${lines.join("\n")}\n`); return f; };
const withText = (line, text) => { const r = JSON.parse(line); r.message.content = r.message.content.map((b) => (b.type === "text" ? { ...b, text } : b)); return JSON.stringify(r); };

test("claude: the text turns in order; tool calls and tool results are not turns", () => {
  const typed = JSON.parse(L.user_typed);
  const user = (text) => JSON.stringify({ ...typed, message: { role: "user", content: text } });
  const file = write("c.jsonl", [
    user("first owner message that is old"),
    withText(L.assistant_text, "an early assistant reply"),
    L.assistant_tool_use, L.tool_result,
    user("the owner's latest request"),
    L.assistant_tool_use, L.tool_result,
    withText(L.assistant_text, "interim assistant text"),
    L.assistant_tool_use, L.tool_result,
    withText(L.assistant_text, "the last message"),
  ]);
  assert.deepEqual(conversationTurns({ host: "claude", file }), [
    { role: "user", text: "first owner message that is old" }, { role: "assistant", text: "an early assistant reply" },
    { role: "user", text: "the owner's latest request" }, { role: "assistant", text: "interim assistant text" }, { role: "assistant", text: "the last message" },
  ]);
});

test("claude: sub-agent records, harness turns and programmatic prompts are not conversation; a recall-context block is stripped", () => {
  const typed = JSON.parse(L.user_typed);
  const file = write("c2.jsonl", [
    JSON.stringify({ ...typed, isSidechain: true, message: { role: "user", content: "a sub-agent brief" } }),
    JSON.stringify({ ...typed, isMeta: true, message: { role: "user", content: "a meta record" } }),
    JSON.stringify({ ...typed, origin: { kind: "task-notification" }, message: { role: "user", content: "<task-notification>x</task-notification>" } }),
    JSON.stringify({ ...typed, message: { role: "user", content: "keep this <recall-context>injected stuff</recall-context> typed text" } }),
  ]);
  const turns = conversationTurns({ host: "claude", file });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text.replace(/\s+/g, " ").trim(), "keep this typed text");
});

test("codex: UserMessage and AgentMessage events are the turns; commands are not", () => {
  const file = write("rollout.jsonl", [L.codex_user, L.codex_command, L.codex_agent]);
  const turns = conversationTurns({ host: "codex", file });
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant"]);
  assert.equal(turns[0].text.trim(), "yo");
  assert.ok(turns[1].text.startsWith("Done"));
});

test("no transcript (Codex --ephemeral gives transcript_path null) or an unreadable path means no turns, not an error; a cut first line is skipped", () => {
  assert.deepEqual(conversationTurns({ host: "codex", file: null }), []);
  assert.deepEqual(conversationTurns({ host: "claude", file: "/nonexistent/x.jsonl" }), []);
  const file = write("big.jsonl", [`${"{".repeat(10)}${"x".repeat(5000)}`, withText(L.assistant_text, "tail text")]);
  const turns = conversationTurns({ host: "claude", file, maxBytes: 2000 });
  assert.deepEqual(turns, [{ role: "assistant", text: "tail text" }]);
});
