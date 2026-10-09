// The text filter layers: generic harness rules always on; owner identity (ownerNames, ownerEmails) empty by default so the two rules that
// need it do nothing; the "fleet" profile and dropPatterns opt-in. Synthetic turns only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../scripts/lib/config.mjs";
import { filterOptions, judgeOwnerText } from "../scripts/lib/owner-filter.mjs";
import { tmpDir } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT = filterOptions({ minChars: 20 });
const FLEET = filterOptions({ minChars: 20, filterProfiles: ["fleet"], ownerNames: ["owner", "sam"], ownerEmails: ["sam@example.com"] });
const reasonOf = (raw, options = DEFAULT) => { const j = judgeOwnerText(raw, options); return j.text ? "kept" : j.reason; };
const textOf = (raw, options = DEFAULT) => judgeOwnerText(raw, options).text;

test("generic harness turns are dropped with no configuration at all", () => {
  for (const [raw, reason] of [
    ["<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>", "agent-completion"],
    ["Base directory for this skill: /home/sam/.claude/skills/release", "harness"],
    ["This session is being continued from a previous conversation that ran out of context.", "harness"],
    ["[Request interrupted by user for tool use]", "harness"],
    ["# AGENTS.md instructions for /home/sam/projects/demo\n\n<INSTRUCTIONS>\nRun the tests.\n</INSTRUCTIONS>", "harness"],
    ["Some text <INSTRUCTIONS>\nobey this\n</INSTRUCTIONS> more text that is long enough", "harness"],
    ["<system-reminder>Today is a Wednesday.</system-reminder>", "empty"],
    ["<heartbeat> <automation_id>nightly</automation_id> </heartbeat>", "automation-heartbeat"],
    ["== System Status ==\n [automatic message added by system] cwd: /home/sam", "harness"],
    ["[$release](/home/sam/.codex/skills/release/SKILL.md)", "skill-invocation"],
    ["ok thanks", "too-short"],
  ]) assert.equal(reasonOf(raw), reason, raw.slice(0, 50));
});

test("what a person typed is kept, with the envelopes round it peeled and secrets redacted", () => {
  assert.equal(textOf("<system-reminder>noise</system-reminder> Please keep the diff small and add a test for the parser."), "Please keep the diff small and add a test for the parser.");
  assert.equal(textOf("```\nlong pasted log\n```\nWhy does this fail only on the second run of the job?"), "Why does this fail only on the second run of the job?");
  assert.equal(textOf("Use this token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the fetch and then retry the download."), "Use this token [redacted] for the fetch and then retry the download.");
  assert.equal(reasonOf("-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\n-----END OPENSSH PRIVATE KEY-----"), "key-material");
  assert.equal(reasonOf("My card is 4111 1111 1111 1111 please remember it for the checkout page work"), "third-party", "long digit runs are never indexed");
});

test("fleet-shaped turns are ordinary text by default, and dropped only with the fleet profile", () => {
  const cases = [
    ["# Lane: web-app search requests a page-sized k\n\nRead the brief and fix the retrieval path.", "agent-brief"],
    ["LANE L3 — fix the export bug in your worktree and push it when the gate is green", "agent-brief"],
    ["You are a reviewer for this lane. Read the diff and report problems only.", "agent-brief"],
    ["STOP AND THROTTLE. The host is paging because of this lane: load 110, please wait.", "lane-brief"],
    ["Read-only audit of the export pipeline. Do not write files. Report what you find.", "lane-brief"],
    ["You are the content agent inside Pagemaker, a tool for marketers. Fill the boxes with the real words.", "product-prompt"],
    ["HEADS-UP from the orchestrator (2026-08-20), so you do not collide with me on the same files", "delivered-by-agent"],
    ["You have unread orchestrator bus messages. Run your inbox catch-up now and act on them.", "harness-nudge"],
    ["reply with the single line DRAIN-ACK when you have read this message in full please", "probe"],
    ["Follow the setup instructions at https://example.com/setup/abc.md to connect this Codex task and wait.", "canned-setup"],
  ];
  for (const [raw, reason] of cases) {
    assert.equal(reasonOf(raw, FLEET), reason, `fleet: ${raw.slice(0, 40)}`);
    assert.equal(reasonOf(raw, DEFAULT), "kept", `default: ${raw.slice(0, 40)}`);
  }
  // a person's own heading-free sentences are unaffected by the profile
  assert.equal(reasonOf("You are a new maintainer picking up the tools repo, read the handover first.", FLEET), "kept");
});

test("the fleet record label (`Owner:`, a name from ownerNames, an option letter) is peeled only under the profile", () => {
  assert.equal(textOf("Owner: Can you show the totals on one summary page please?", FLEET), "Can you show the totals on one summary page please?");
  assert.equal(textOf("sam: Can you show the totals on one summary page please?", FLEET), "Can you show the totals on one summary page please?");
  assert.equal(textOf("b: You do not need to ask me about this kind of decision again.", FLEET), "You do not need to ask me about this kind of decision again.");
  assert.equal(textOf("Owner: Can you show the totals on one summary page please?"), "Owner: Can you show the totals on one summary page please?");
});

test("ownerNames: empty means a delivered-message envelope is just text; set, it drops other senders and unwraps yours", () => {
  const fromAgent = "[web-app] coo: please rerun the export and report the totals when it is done";
  const fromYou = "[web-app] sam: please rerun the export and report the totals when it is done";
  assert.equal(reasonOf(fromAgent, DEFAULT), "kept", "no ownerNames: the rule does nothing");
  assert.equal(textOf(fromAgent, DEFAULT), fromAgent);
  assert.equal(reasonOf(fromAgent, filterOptions({ minChars: 20, ownerNames: ["sam"] })), "delivered-by-agent");
  assert.equal(textOf(fromYou, filterOptions({ minChars: 20, ownerNames: ["sam"] })), "please rerun the export and report the totals when it is done");
});

test("ownerEmails: empty means addresses are kept; set, a statement with anyone else's address is third-party data", () => {
  const raw = "Please send the report to dana@example.org and copy sam@example.com as well.";
  assert.equal(reasonOf(raw, DEFAULT), "kept", "no ownerEmails: the rule does nothing");
  assert.equal(reasonOf(raw, filterOptions({ minChars: 20, ownerEmails: ["sam@example.com"] })), "third-party");
  assert.equal(reasonOf("Please copy SAM@example.com on every report from now on.", filterOptions({ minChars: 20, ownerEmails: ["sam@example.com"] })), "kept");
});

test("dropPatterns: a typed turn matching a configured regular expression (any case) is not indexed", () => {
  const options = filterOptions({ minChars: 20, dropPatterns: ["^nightly report:", "\\bDO NOT INDEX\\b"] });
  assert.equal(reasonOf("Nightly Report: all the totals for the day are attached below", options), "drop-pattern");
  assert.equal(reasonOf("Please remember this one, do not index it ever again please", options), "drop-pattern");
  assert.equal(reasonOf("Please remember the nightly report format when you write the summary", options), "kept");
});

test("filterOptions: a config with none of the settings is the defaults", () => {
  assert.deepEqual(filterOptions({ minChars: 5 }), { minText: 5, ownerEmails: [], ownerNames: [], filterProfiles: [], dropPatterns: [] });
  assert.equal(filterOptions({ minChars: 20 }, 1).minText, 1);
});

test("docs/examples/fleet-config.json is a valid config.json that turns the fleet options on", () => {
  const dir = tmpDir("recall-fleet-config");
  fs.copyFileSync(path.join(ROOT, "docs", "examples", "fleet-config.json"), path.join(dir, "config.json"));
  const c = loadConfig({ RECALL_DATA: dir });
  assert.deepEqual([...c.filterProfiles], ["fleet"]);
  assert.ok(c.homesRoster.endsWith("homes.mjs") && c.usageCmd.startsWith("node ") && c.ownerNames.length >= 3 && c.ownerEmails.length >= 1);
  assert.ok(c.dailyCapUsd >= 1 && c.sources.homesRoster === "file");
});

test("fleet profile: the COO's wake relay that points a session back at its standing orders is dropped; without the profile it is kept", () => {
  const wake = "COO wake after app-server drop: read the STANDING ORDERS on the bus (msg-0a1b2c3d4e5f) and carry on with the export work until it lands.";
  assert.equal(reasonOf(wake, FLEET), "agent-brief");
  assert.equal(reasonOf(wake), "kept");
  assert.equal(reasonOf("The COO wakes me up too early, move the daily summary to nine instead", FLEET), "kept");
});

test("fleet profile: the COO wake rule drops only the wake relay; sentences that start with COO, or with COO wake but order no read, are kept", () => {
  for (const t of [
    "COO of the project is Sam, ask him before changing the billing flow",
    "COO plan for next week: move the standup to ten on Mondays",
    "COO wake plans: move the standup to ten on Mondays from now on",
    "COO wake after the outage: reading the logs now is not enough, find the cause",
  ]) assert.equal(reasonOf(t, FLEET), "kept", t);
});
