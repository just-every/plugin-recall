// The prompt-time situation carries prose only: fenced code, tool output, file dumps, diffs and URLs are taken out of the earlier owner message
// and the assistant reply before they are clipped (x7: those parts raised the Decisions API's refusals from 7 to 186).
import test from "node:test";
import assert from "node:assert/strict";
import { plainProse } from "../scripts/lib/plain-prose.mjs";
import { ASSISTANT_CLIP, contextSituation, PREV_OWNER_CLIP, STOP_HEAD } from "../scripts/lib/situations.mjs";
import { clip } from "../scripts/lib/text.mjs";

test("plainProse: fenced code (closed or not), tool-output wrappers, file dumps, diffs, shell lines and indented code go; prose and lists stay", () => {
  assert.equal(plainProse("Fixed it.\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n\nNow run the tests."), "Fixed it.\n\nNow run the tests.");
  assert.equal(plainProse("~~~\nraw\n~~~\nafter"), "after");
  assert.equal(plainProse("Before\n```\nnever closed\nstill code"), "Before", "an unterminated fence runs to the end");
  assert.equal(plainProse("Ran it: <tool_result>line\nline\nline</tool_result> and it passed."), "Ran it:\n and it passed.");
  assert.equal(plainProse("<function_results>\nbig output"), "", "an unterminated wrapper runs to the end");
  assert.equal(plainProse("See the file:\n   12\tconst a = 1;\n   13\tconst b = 2;\nthat is all."), "See the file:\nthat is all.", "cat -n style line numbers");
  assert.equal(plainProse("diff --git a/x b/x\nindex 83db48f..bf2a3c1 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\nThe change is small."), "The change is small.");
  assert.equal(plainProse("Run:\n$ npm test\nand look."), "Run:\nand look.");
  assert.equal(plainProse("Steps:\n    indented();\n\tcode();\n- one\n    - nested\n    1. nested number\nend"), "Steps:\n- one\n    - nested\n    1. nested number\nend", "indented code goes, indented list items stay");
});

test("plainProse: URLs and markdown links to URLs go (the link text stays unless it is the URL), long tokens go, short paths stay", () => {
  assert.equal(plainProse("Open [the lab](http://127.0.0.1:4173/dev/lab?runId=0f3c2d1e-5b7a) now"), "Open the lab now");
  assert.equal(plainProse("Open [http://127.0.0.1:4173/dev/lab](http://127.0.0.1:4173/dev/lab) now"), "Open  now");
  assert.equal(plainProse("Go to https://example.com/a/b?c=d#e, then back."), "Go to  then back.");
  assert.equal(plainProse(`token ${"a".repeat(120)} ends`), "token  ends");
  assert.equal(plainProse("Edit scripts/lib/situations.mjs and test/plain-prose.test.mjs."), "Edit scripts/lib/situations.mjs and test/plain-prose.test.mjs.");
  assert.equal(plainProse("```\nonly code\n```"), "");
  assert.equal(plainProse(null), "");
  assert.equal(plainProse(undefined), "");
});

const NOISY_REPLY = [
  "Open it here:", "", "[http://127.0.0.1:4173/dev/preview-lab](http://127.0.0.1:4173/dev/preview-lab)", "",
  "```", "GET /dev/preview-lab 200", "```", "", "The refine lab route is wired and the older extract lab still has a rerender warning.",
].join("\n");

test("contextSituation: the reply is 400 characters of prose, the earlier owner message 300, both cleaned BEFORE they are clipped", () => {
  assert.equal(ASSISTANT_CLIP, 400);
  assert.equal(PREV_OWNER_CLIP, 300);
  const s = contextSituation({ project: "p", prevOwner: "Look at the logs:\n```\nERROR boom\n```\nand tell me why.", assistant: NOISY_REPLY, ownerText: "go on" });
  assert.equal(s, `${STOP_HEAD}\n\nPROJECT: p\n\nOWNER (earlier): Look at the logs:\n\nand tell me why.\n\nASSISTANT: Open it here:\n\nThe refine lab route is wired and the older extract lab still has a rerender warning.\n\nOWNER (latest message, before the agent has acted): go on`);
  // a long reply: the budget is spent on words, not on the code block at its start
  const longReply = `\`\`\`\n${"x = 1;\n".repeat(200)}\`\`\`\n${"Then the real point. ".repeat(40)}`;
  const reply = /ASSISTANT: ([\s\S]*?)\n\nOWNER \(latest/.exec(contextSituation({ project: null, assistant: longReply, ownerText: "m" }))[1];
  assert.equal(reply, clip(plainProse(longReply), 400));
  assert.ok(reply.startsWith("Then the real point.") && reply.length <= 406);
  // the latest message is the owner's own words, left exactly as typed
  const typed = "Run this:\n```\nnpm test\n```\nhttps://example.com";
  assert.ok(contextSituation({ project: null, ownerText: typed }).endsWith(typed));
  // a part that is only code or links is left out, never invented
  assert.equal(contextSituation({ project: null, prevOwner: "```\ncode\n```", assistant: "https://example.com/only-a-link", ownerText: "hi" }), `${STOP_HEAD}\n\nOWNER (latest message, before the agent has acted): hi`);
});
