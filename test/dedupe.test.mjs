// Injection-layer dedupe (no network): the same statement stored twice (mirrored homes/sessions, or typed twice) takes ONE slot of the
// prompt injection; the slot is refilled from the next candidates. Pipelines and `recall eval`
// are untouched (dedupe is applied after ranking, in the hooks only).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dedupeKey, dedupeRanked } from "../scripts/lib/dedupe.mjs";
import { loadConfig, V1_ENV } from "../scripts/lib/config.mjs";
import { parseHookInput } from "../scripts/lib/hook-io.mjs";
import { handlePrompt } from "../scripts/lib/prompt-hook.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { fakeOpenAI, readFixture, seedIndex, tmpDir } from "./helpers.mjs";

const recorded = (name) => JSON.parse(readFixture("hook-inputs", name));
const input = (name, over = {}) => parseHookInput({ stdin: JSON.stringify({ ...recorded(name), ...over }) });
const PROMPT = "The duplicate draft runs come from a re-execution path, so I will add a fallback path with a random limit to stop them.";
const NOW = () => new Date("2026-10-07T12:00:00Z");
const rule = (i) => `Rule ${i}: never add a fallback path or random limit when fixing the code structure, case ${i}.`;
const distinct = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, ts: `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00Z`, text: rule(i), repo: "r" }));

async function setup(history, env = {}) {
  const dataDir = tmpDir("recall-dedupe");
  const config = loadConfig({ ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_DAILY_CAP_USD: "5", RECALL_ALLOW_HEADLESS: "1", ...env });
  const fake = fakeOpenAI();
  const runtime = createRuntime(config, { post: fake.post });
  await seedIndex(runtime.store, history);
  return { dataDir, config, fake, runtime };
}
const lines = (out) => JSON.parse(out.stdout).hookSpecificOutput.additionalContext.split("\n").filter((l) => l.startsWith("- "));
const prompt = async (s) => handlePrompt({ input: input("claude-prompt.json", { prompt: PROMPT }), config: s.config, runtime: s.runtime, now: NOW });

test("dedupeKey: lowercase, collapsed whitespace, trimmed", () => {
  assert.equal(dedupeKey("  Is  there\tanything\n you'd LIKE? "), "is there anything you'd like?");
  assert.notEqual(dedupeKey("a b"), dedupeKey("a, b"));
});

test("dedupeRanked: keeps the highest-scored copy at its own rank, leaves distinct texts and their order alone", () => {
  const text = { a: "Same thing", b: "other", c: "same   THING", d: "third", e: "Other " };
  const ranked = [["a", 0.9], ["b", 0.8], ["c", 0.95], ["d", 0.7], ["e", 0.6]].map(([id, score]) => ({ id, score }));
  assert.deepEqual(dedupeRanked(ranked, (e) => text[e.id]).map((e) => e.id), ["b", "c", "d"]);
  assert.deepEqual(dedupeRanked(ranked.filter((e) => e.id !== "c" && e.id !== "e"), (e) => text[e.id]).map((e) => e.id), ["a", "b", "d"]);
  const tie = [{ id: "x", score: 0.5 }, { id: "y", score: 0.5 }];
  assert.deepEqual(dedupeRanked(tie, () => "same").map((e) => e.id), ["x"], "a tie keeps the earlier rank");
  assert.deepEqual(dedupeRanked([], () => ""), []);
});

test("prompt hook: a duplicate pair yields one line and the freed slot is refilled from the next candidate", async () => {
  const dup = { id: "dupB", ts: "2026-09-01T00:00:00Z", text: distinct[0].text, repo: "r", session_id: "s-mirror" };
  const s = await setup([...distinct, dup], { RECALL_K: "5" });
  const out = await prompt(s);
  const got = lines(out);
  assert.equal(got.length, 5);
  assert.equal(new Set(got).size, 5);
  assert.equal(got.filter((l) => l.includes(rule(0))).length, 1, "the repeated statement appears once");
  const inj = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  assert.ok(inj.includes(rule(5)) || inj.includes(rule(4)) || inj.includes(rule(3)) || inj.includes(rule(2)) || inj.includes(rule(1)));
  // without the duplicate the same 5 distinct statements are injected: the duplicate cost nothing
  const base = await setup(distinct, { RECALL_K: "5" });
  const baseLines = lines(await prompt(base));
  assert.equal(baseLines.length, 5);
  assert.deepEqual([...got].sort(), [...baseLines].sort());
});

test("prompt hook: texts differing only in case or whitespace are merged; the log lists one injected id", async () => {
  const hist = [
    ...distinct.slice(0, 4),
    { id: "caseDup", ts: "2026-09-25T00:00:00Z", text: rule(1).toUpperCase(), repo: "r" },
    { id: "wsDup", ts: "2026-09-26T00:00:00Z", text: `  ${rule(2).replace(/ /g, "  ")}\n`, repo: "r" },
  ];
  const s = await setup(hist, { RECALL_K: "5" });
  const got = lines(await prompt(s));
  assert.equal(got.length, 4, "6 stored, 4 distinct");
  const entry = fs.readdirSync(path.join(s.dataDir, "logs")).flatMap((f) => fs.readFileSync(path.join(s.dataDir, "logs", f), "utf8").trim().split("\n").map(JSON.parse)).find((l) => l.event === "prompt");
  assert.equal(entry.injected.length, 4);
  assert.equal(new Set(entry.injected).size, 4);
});

test("prompt hook: distinct statements are untouched (same count, same set as the full gated list)", async () => {
  const s = await setup(distinct, { RECALL_K: "5" });
  assert.equal(lines(await prompt(s)).length, 5);
  const s6 = await setup(distinct, { RECALL_K: "6" });
  assert.equal(lines(await prompt(s6)).length, 6);
});
