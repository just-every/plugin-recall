// Prompts a host submits on its own and writes as the person's turn (owner-filter.mjs): Claude Desktop's auto-resume after an interruption,
// the /init prompt of Codex and Every Code, Every Code's "not yet fully implemented" notice, and its `[branch created]` marker (taken off, so
// what was typed after it stays; a row left with only a slash command, or a cut-off one, holds no words). The person's own sentences that
// start the same way are kept. Through the indexer too: a Claude transcript turn and Every Code log rows. Synthetic text, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { filterOptions, judgeOwnerText } from "../scripts/lib/owner-filter.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { claudeUser, writeTranscript } from "./transcript-builders.mjs";
import { tmpDir } from "./helpers.mjs";

const options = filterOptions({ minChars: 20 });
const reasonOf = (text) => judgeOwnerText(text, options).reason ?? "kept";

const RESUME = [
  "I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.",
  "The app was quit while you were working. Please continue from where you left off.",
  "My computer went to sleep while you were working. Please continue from where you left off.",
  "The context window filled up while you were working. Please continue from where you left off.",
  "Claude Code was restarted on the remote host while you were working. Please continue from where you left off.",
];
const INIT = "Generate a file named AGENTS.md that serves as a contributor guide for this repository.\nYour goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.";

test("host prompts are dropped as harness text; the person's own sentences that start the same way are kept", () => {
  for (const t of [...RESUME, INIT, "/browser command is not yet fully implemented", "command is not yet fully implemented"]) assert.equal(reasonOf(t), "harness", t);
  for (const t of [
    "I hit my usage limit on the other account, so run the export on this one instead",
    "I hit my usage limit while you were working on the export, so I moved to the other account: carry on there",
    "The app was quit by the updater twice today, check the crash log before the release",
    "Generate a file named CHANGELOG.md with the release notes of the last three tags",
    "The search command is not yet fully implemented in the docs, add a section for it",
  ]) assert.equal(reasonOf(t), "kept", t);
});

test("[branch created]: the marker comes off; a row left with only a slash command or a fragment of one holds no words", () => {
  assert.equal(reasonOf("[branch created] /br"), "harness");
  assert.equal(reasonOf("[branch created] /branc"), "harness");
  assert.equal(reasonOf("[branch created] /branch"), "harness");
  assert.equal(judgeOwnerText("[branch created] make the invoice export stream its rows", options).text, "make the invoice export stream its rows");
});

test("index: Claude Desktop's auto-resume turn and Every Code's host rows are no statements; the turns around them are", async () => {
  const root = tmpDir("recall-host-prompts");
  const project = path.join(root, ".claude", "projects", "-home-sam-projects-shop");
  fs.mkdirSync(project, { recursive: true });
  writeTranscript("5eee0000-0000-4000-8000-000000000001.jsonl", [
    claudeUser("Move the coupon field under the order total on the checkout page", "2026-09-01T10:00:00.000Z"),
    claudeUser(RESUME[0], "2026-09-01T11:41:35.000Z"),
  ], project);
  const code = path.join(root, ".code");
  fs.mkdirSync(code, { recursive: true });
  const ts = Date.parse("2026-09-02T09:00:00.000Z") / 1000;
  const s = "0190e000-cafe-7000-8000-00000000ca01";
  fs.writeFileSync(path.join(code, "history.jsonl"), [
    { session_id: s, ts, text: `/init ${INIT}` },
    { session_id: s, ts: ts + 5, text: INIT },
    { session_id: s, ts: ts + 10, text: "/browser command is not yet fully implemented" },
    { session_id: s, ts: ts + 20, text: "[branch created] /branc" },
    { session_id: s, ts: ts + 30, text: "[branch created] keep the ledger totals in cents everywhere" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  const report = await runIndex({ config, store, homeDir: root, env: {}, embed: false, now: () => Date.parse("2026-10-01T00:00:00.000Z") });
  assert.deepEqual(store.loadStatements().map((x) => x.text).sort(), [
    "Move the coupon field under the order total on the checkout page",
    "keep the ledger totals in cents everywhere",
  ]);
  assert.equal(report.excluded.harness, 5);
});

test("a host prompt is matched whole: the person's words typed after the resume sentence or the notice keep the row", () => {
  const more = "Then also rename the helper to buildCard and update its callers.";
  for (const t of [...RESUME.map((r) => `${r} ${more}`), `/browser command is not yet fully implemented, so ${more.toLowerCase()}`]) {
    assert.equal(reasonOf(t), "kept", t);
  }
});
