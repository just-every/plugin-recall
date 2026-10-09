// Envelopes and automatic turns of the hosts. The desktop apps' (scripts/lib/text-filter/desktop.mjs), on the synthetic turns in
// fixtures/desktop-envelopes.json: the Codex app's context sections ahead of `## My request for Codex:`, and the Claude desktop app's quote
// replies; each case says what is left of the turn (or why it is dropped), with the default text rules and with the fleet profile alike.
// Then the Codex app's review command and Every Code's review loop and expanded multi-agent commands.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildStatement, runIndex } from "../scripts/lib/indexer.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { judgeOwnerText } from "../scripts/lib/owner-filter.mjs";
import { ownerText } from "../scripts/lib/text-filter/owner-text.mjs";
import { peelAppEnvelope, peelQuoteReply } from "../scripts/lib/text-filter/desktop.mjs";
import { claudeUser, codexUser, writeTranscript } from "./transcript-builders.mjs";
import { readFixture, tmpDir } from "./helpers.mjs";

const CASES = JSON.parse(readFixture("desktop-envelopes.json"));
const norm = (s) => s.replace(/\s+/g, " ").trim();
const DEFAULTS = { minText: 20 };
const FLEET = { minText: 20, filterProfiles: ["fleet"], ownerNames: ["sam"] };

for (const [group, cases] of Object.entries(CASES)) {
  for (const [name, c] of Object.entries(cases)) {
    test(`${group} ${name}: ${c.text ? "keeps the person's words" : `is dropped (${c.reason})`}, with the default rules and with the fleet profile`, () => {
      for (const options of [DEFAULTS, FLEET]) {
        const got = judgeOwnerText(c.raw, options);
        if (c.text) {
          assert.equal(got.text, norm(c.text), JSON.stringify(options));
          assert.deepEqual(got.peeled, [group === "codexApp" ? "codex-app-envelope" : "quote-reply"]);
        } else assert.equal(got.reason, c.reason, JSON.stringify(options));
      }
    });
  }
}

test("Codex app envelope: nothing of the app's survives (browser state, file paths, selections, findings, comment metadata)", () => {
  for (const c of Object.values(CASES.codexApp)) {
    if (!c.text) continue;
    const { text } = ownerText(c.raw, DEFAULTS);
    for (const leak of ["In app browser", "Current URL", "My request", "Files mentioned", "Selection 1", "Finding 1", "Node position", "Target selector", "appshot", "response-annotations", "ambient UI state"]) {
      assert.ok(!text.includes(leak), `${leak} leaked into ${JSON.stringify(text)}`);
    }
  }
});

test("Codex app envelope: a turn that is not one is left alone, and a request heading at the head is still cut", () => {
  const plain = "Please add the export button to the invoices table and keep the order of the columns";
  assert.deepEqual(peelAppEnvelope(plain), { text: plain, peeled: false });
  assert.deepEqual(peelAppEnvelope("## My request for Codex:\nShip the export behind a flag first"), { text: "Ship the export behind a flag first", peeled: true });
  // a `Comment:` the person wrote inside the request is the request, never counted twice as a comment
  const r = ownerText("# Diff comments:\n\n## Comment 1\nFile: a.ts\nComment:\nrename this\n\n## My request for Codex:\nAlso add a comment: the limit is per user", DEFAULTS);
  assert.equal(r.text, "rename this Also add a comment: the limit is per user");
});

test("Claude quote reply: only a turn that starts with a marker is peeled, and only the quoted block right after each marker goes", () => {
  const plain = "> a line the person quoted on purpose\nand what they think of it, which is a sentence";
  assert.deepEqual(peelQuoteReply(plain), { text: plain, peeled: false });
  assert.equal(ownerText(CASES.quoteReply.ownQuoteLater.raw, DEFAULTS).text, norm(CASES.quoteReply.ownQuoteLater.text));
});

test("index: a Codex app turn and a Claude quote reply become statements; the dry run counts them by peel", async () => {
  const root = tmpDir("recall-desktop-index");
  const claudeFile = path.join(root, ".claude", "projects", "-home-sam-projects-web-app", "5ccc0000-0000-4000-8000-000000000001.jsonl");
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  writeTranscript(path.basename(claudeFile), [claudeUser(CASES.quoteReply.reply.raw, "2026-09-20T08:00:00.100Z"), claudeUser(CASES.quoteReply.attach.raw, "2026-09-20T08:05:00.100Z")], path.dirname(claudeFile));
  const rollouts = path.join(root, ".codex", "sessions", "2026", "09", "20");
  fs.mkdirSync(rollouts, { recursive: true });
  const meta = JSON.stringify({ timestamp: "2026-09-20T09:00:00.000Z", type: "session_meta", payload: { id: "0190f000-6666-7000-8000-00000000a001", timestamp: "2026-09-20T09:00:00.000Z", cwd: "/home/sam/projects/web-app", originator: "Codex Desktop", cli_version: "0.160.1", source: "vscode", thread_source: "user" } });
  writeTranscript("rollout-2026-09-20T09-00-00-0190f000-6666-7000-8000-00000000a001.jsonl", [meta, codexUser(CASES.codexApp.diffComments.raw, "2026-09-20T09:01:00.200Z"), codexUser(CASES.codexApp.envelopeOnly.raw, "2026-09-20T09:02:00.200Z")], rollouts);
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  const dry = await runIndex({ config, store, homeDir: root, env: {}, dryRun: true });
  assert.deepEqual(dry.byPeel, { "quote-reply": { statements: 2, added: 2 }, "codex-app-envelope": { statements: 1, added: 1 } });
  assert.equal(dry.excluded.envelope, 1);
  await runIndex({ config, store, homeDir: root, env: {}, embed: false });
  const texts = store.loadStatements().map((s) => s.text).sort();
  assert.deepEqual(texts, [norm(CASES.codexApp.diffComments.text), norm(CASES.quoteReply.attach.text), norm(CASES.quoteReply.reply.text)].sort());
  // buildStatement says which peel kept the words; the stored statement does not carry it
  const b = buildStatement({ raw: CASES.quoteReply.reply.raw, ts: "2026-09-20T08:00:00.100Z", host: "claude", session_id: "s", repo: null, src: "x:L1" }, config);
  assert.deepEqual(b.peeled, ["quote-reply"]);
  assert.ok(!("peeled" in b.statement));
});

test("the Codex app's review command is the app's from end to end, its canned request included: never a statement", () => {
  const raw = "## Code review guidelines:\n# Review guidelines:\n\nYou are reviewing a proposed change. Flag only real bugs.\n\n## Output schema — MUST MATCH _exactly_\n{\"findings\": []}\n\n## My request for Codex:\nReview the current uncommitted changes";
  assert.equal(judgeOwnerText(raw, DEFAULTS).reason, "harness");
  assert.equal(judgeOwnerText(raw, FLEET).reason, "agent-brief", "the fleet profile reads its heading as a brief first; dropped either way");
});

test("Every Code's review loop turns (the relayed review, the fix check, the commit handoff) are the host's, not the person's", () => {
  for (const raw of [
    "<user_action>\n  <context>User initiated a review task. Here's the full review output from reviewer model.</context>\n  <findings>[P2] the export limit is read too early</findings>\n</user_action>",
    "You are evaluating whether the latest fixes resolved the findings from `/review`. Respond with a structured verdict.",
    "You have permission to commit and push. Repository snapshot: `git status --short`: M src/export.ts",
  ]) assert.equal(judgeOwnerText(raw, DEFAULTS).reason, "harness", raw.slice(0, 40));
});

test("Every Code's expanded multi-agent command keeps only the task typed after it", () => {
  const raw = "Create a comprehensive plan by leveraging multiple state-of-the-art LLMs working in parallel.\n\nUse the agent tool to start a group of agents with agent_run:\n- models: an array containing [\"claude\", \"gemini\", \"codex\"]\n- read_only: true (planning mode - no file modifications)\n\nOnce all models have completed:\n1. Analyze all the different plans\n\nTask to plan:\nsplit the invoices exporter into a reader and a writer and keep the CLI flags";
  assert.equal(judgeOwnerText(raw, DEFAULTS).text, "split the invoices exporter into a reader and a writer and keep the CLI flags");
  const code = "Perform a coding task with multiple LLMs and compare the results.\n\n- read_only: false\n\nCoding task to perform:\nadd retries to the ledger upload with a backoff";
  assert.equal(judgeOwnerText(code, DEFAULTS).text, "add retries to the ledger upload with a backoff");
});
