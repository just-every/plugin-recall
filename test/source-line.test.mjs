// The source line on each injected memory card (and the one sentence in the block header), the plugin root it names, and v1's block untouched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendCards, cardsPath } from "../scripts/lib/cards/cards-file.mjs";
import { buildCard } from "../scripts/lib/cards/schema.mjs";
import { CARD_HEADER, CONTEXT_HEADER, SOURCE_SENTENCE, formatCards, formatInjection } from "../scripts/lib/context.mjs";
import { loadConfig, V1_ENV } from "../scripts/lib/config.mjs";
import { parseHookInput } from "../scripts/lib/hook-io.mjs";
import { handlePrompt } from "../scripts/lib/prompt-hook.mjs";
import { pluginRoot, shellWord, tildePath } from "../scripts/lib/plugin-root.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { fakeOpenAI, readFixture, seedIndex, tmpDir } from "./helpers.mjs";

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir().replace(/\/$/, "");
const SRC_ZST = `${HOME}/.codex/sessions/2026/09/12/rollout-2026-09-12T10-00-00-0199aaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl.zst:L1234`;
const SRC_CLAUDE = `${HOME}/.claude/projects/-home-sam-projects-web-app/0a1b2c3d-0000-4000-8000-000000000001.jsonl:L871`;
const card = (kind = "rule", scope = "global", gist = "the agent had just added a fallback path") => ({ kind, scope, gist });
const item = (id, src, over = {}) => ({ id, ts: "2026-09-12T10:00:00.000Z", repo: "myrepo", text: "Never add a fallback path.", src, card: card(), ...over });

test("a card with a transcript source gets one extra line after the quote: the source with ~ for the home dir, and the command that reads around it", () => {
  const block = formatCards([item("codex-aaa111", SRC_ZST), item("claude-bbb222", SRC_CLAUDE)], "myrepo", {}, { root: "/opt/plugins/plugin-recall", homedir: HOME });
  const lines = block.split("\n");
  assert.equal(lines[0], "<recall-context>");
  assert.equal(lines[1], `${CARD_HEADER} Each card names its source; run its context command only if a memory matters here and the card is not enough.`);
  assert.equal(SOURCE_SENTENCE, "Each card names its source; run its context command only if a memory matters here and the card is not enough.");
  assert.deepEqual(lines.slice(2, 5), [
    "• Rule, all projects (said 12 Sep, the agent had just added a fallback path):",
    '  "Never add a fallback path."',
    "  source: ~/.codex/sessions/2026/09/12/rollout-2026-09-12T10-00-00-0199aaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl.zst:L1234 · context: node /opt/plugins/plugin-recall/scripts/recall.mjs show codex-aaa111",
  ]);
  assert.equal(lines[7], "  source: ~/.claude/projects/-home-sam-projects-web-app/0a1b2c3d-0000-4000-8000-000000000001.jsonl:L871 · context: node /opt/plugins/plugin-recall/scripts/recall.mjs show claude-bbb222");
  assert.equal(lines.length, 9);
});

test("without a plugin root, or for a statement with no transcript source, the card is the card as it was (evaluation replays have no transcripts)", () => {
  const plain = formatCards([item("a", SRC_CLAUDE)], "myrepo");
  assert.equal(plain, ["<recall-context>", CARD_HEADER, "• Rule, all projects (said 12 Sep, the agent had just added a fallback path):", '  "Never add a fallback path."', "</recall-context>"].join("\n"));
  const noSrc = formatCards([item("a", "test"), item("b", null), item("c", undefined)], "myrepo", {}, { root: "/r" });
  assert.ok(!noSrc.includes("source:") && !noSrc.includes(SOURCE_SENTENCE));
  // a mixed block: only the card that has a source gets the line
  const mixed = formatCards([item("a", "test"), item("b", SRC_CLAUDE)], "myrepo", {}, { root: "/r", homedir: HOME }).split("\n");
  assert.equal(mixed.filter((l) => l.startsWith("  source: ")).length, 1);
  assert.ok(mixed[1].endsWith(SOURCE_SENTENCE));
});

test("paths: ~ only for the home dir itself, a root with spaces or shell characters is quoted, a trailing slash is dropped", () => {
  assert.equal(tildePath(`${HOME}/a/b`, HOME), "~/a/b");
  assert.equal(tildePath(`${HOME}x/a`, HOME), `${HOME}x/a`, "a sibling directory is not the home");
  assert.equal(tildePath("/tmp/a", HOME), "/tmp/a");
  assert.equal(tildePath(HOME, `${HOME}/`), "~");
  assert.equal(shellWord("/a/b-c_d.e/scripts/recall.mjs"), "/a/b-c_d.e/scripts/recall.mjs");
  assert.equal(shellWord("/home/sam/a b/plug$in/recall.mjs"), '"/home/sam/a b/plug\\$in/recall.mjs"');
  const quoted = formatCards([item("a", SRC_CLAUDE)], "myrepo", {}, { root: "/home/sam/a b/plugin-recall/", homedir: HOME });
  assert.match(quoted, / context: node "\/home\/sam\/a b\/plugin-recall\/scripts\/recall\.mjs" show a$/m);
});

test("pluginRoot: CLAUDE_PLUGIN_ROOT, then PLUGIN_ROOT, then the root the running script lives in", () => {
  assert.equal(pluginRoot({ CLAUDE_PLUGIN_ROOT: "/c/root", PLUGIN_ROOT: "/p/root" }), "/c/root");
  assert.equal(pluginRoot({ PLUGIN_ROOT: "/p/root" }), "/p/root");
  assert.equal(pluginRoot({ CLAUDE_PLUGIN_ROOT: "", PLUGIN_ROOT: "" }), OWN_ROOT);
  assert.equal(pluginRoot({}), OWN_ROOT);
  assert.ok(fs.existsSync(path.join(OWN_ROOT, "scripts", "recall.mjs")), "the command the card prints exists in the root the script is in");
});

// ---- the hook, end to end ----
const AT = "2026-10-08T12:00:00.000Z";
const NOW = () => new Date("2026-10-07T12:00:00Z");
const PROMPT = "The nightly export sometimes writes duplicate rows, so I will add a fallback path that retries with a random delay to stop them.";
const ROWS = [
  { id: "claude-1111111111111111", ts: "2026-09-01T10:00:00.000Z", repo: "web-app", text: "Never add a fallback path or a retry loop to hide a failure, fix the code structure instead.", card: { kind: "rule", scope: "global", gist: "the agent had just added a fallback path to hide a failure" }, src: SRC_CLAUDE },
  { id: "codex-2222222222222222", ts: "2026-09-02T10:00:00.000Z", repo: "ledger-cli", text: "I prefer a proper fix over a fallback path: keep the code structure simple.", card: { kind: "preference", scope: "global", gist: "the agent offered two ways to fix the duplicate rows" }, src: SRC_ZST },
];

async function hookWorld({ env = {}, home = HOME } = {}) {
  const dataDir = tmpDir("recall-source");
  const config = loadConfig({ RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_DAILY_CAP_USD: "5", RECALL_ALLOW_HEADLESS: "1", RECALL_K: "3", ...env });
  const runtime = createRuntime(config, { post: fakeOpenAI({ decide: () => 0.99 }).post });
  await seedIndex(runtime.store, ROWS.map(({ card: _c, src: _s, ...r }) => r));
  runtime.store.updateStatements((rows) => rows.map((r) => ({ ...r, src: ROWS.find((x) => x.id === r.id).src })));
  appendCards(cardsPath(dataDir), ROWS.map((r) => buildCard({ statement: r, entry: { n: 1, ...r.card }, model: "haiku", at: AT, gistSource: "transcript" })));
  return { dataDir, config, runtime };
}
const logLines = (dataDir) => fs.readdirSync(path.join(dataDir, "logs")).filter((f) => f.startsWith("turns-")).flatMap((f) => fs.readFileSync(path.join(dataDir, "logs", f), "utf8").trim().split("\n").map(JSON.parse));
const prompt = (extra = {}) => parseHookInput({ stdin: JSON.stringify({ ...JSON.parse(readFixture("hook-inputs/claude-prompt.json")), prompt: PROMPT, cwd: tmpDir("recall-cwd"), ...extra }) });
const sourceLines = (ctx) => ctx.split("\n").filter((l) => l.startsWith("  source: "));

test("the prompt hook names the plugin root it is running from in each card's command (CLAUDE_PLUGIN_ROOT, PLUGIN_ROOT, else its own location)", async () => {
  for (const [env, root] of [[{ CLAUDE_PLUGIN_ROOT: "/h/.claude/plugins/cache/just-every/plugin-recall/0.3.0", PLUGIN_ROOT: "/ignored" }, "/h/.claude/plugins/cache/just-every/plugin-recall/0.3.0"], [{ PLUGIN_ROOT: "/h/.codex/plugins/plugin-recall" }, "/h/.codex/plugins/plugin-recall"], [{}, OWN_ROOT]]) {
    const w = await hookWorld();
    const out = await handlePrompt({ input: prompt(), config: w.config, runtime: w.runtime, now: NOW, env });
    const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
    const [entry] = logLines(w.dataDir);
    assert.equal(entry.context, ctx);
    assert.equal(entry.injected.length, 2);
    assert.ok(ctx.split("\n")[1].endsWith(SOURCE_SENTENCE), "the header carries the sentence");
    const lines = sourceLines(ctx);
    assert.equal(lines.length, 2, "one source line per card");
    for (const id of entry.injected) {
      const row = ROWS.find((r) => r.id === id);
      const shown = row.src.replace(`${HOME}/`, "~/");
      assert.ok(lines.includes(`  source: ${shown} · context: node ${root}/scripts/recall.mjs show ${id}`), `${id} in ${lines.join("\n")}`);
    }
    // each source line comes right after its quote
    const all = ctx.split("\n");
    for (const i of all.keys()) if (all[i].startsWith("  source: ")) assert.ok(all[i - 1].startsWith('  "'));
  }
});

test("the log keeps each candidate's source for the monitor", async () => {
  const w = await hookWorld();
  await handlePrompt({ input: prompt(), config: w.config, runtime: w.runtime, now: NOW, env: {} });
  const [entry] = logLines(w.dataDir);
  assert.deepEqual(entry.candidates.map((c) => [c.id, c.src]).sort(), ROWS.map((r) => [r.id, r.src]).sort());
});

test("v1 (every v2 setting at its v1 value) injects the same block as before: dated quotes, no source line, no sentence", async () => {
  const w = await hookWorld({ env: { ...V1_ENV, RECALL_K: "5" } });
  const out = await handlePrompt({ input: prompt(), config: w.config, runtime: w.runtime, now: NOW, env: { CLAUDE_PLUGIN_ROOT: "/h/plugin-recall" } });
  const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  const [entry] = logLines(w.dataDir);
  const items = entry.injected.map((id) => { const r = ROWS.find((x) => x.id === id); return { text: r.text, ts: r.ts, repo: r.repo }; });
  assert.equal(ctx, formatInjection(items, entry.session_id));
  assert.ok(ctx.includes(CONTEXT_HEADER) && !ctx.includes("source:") && !ctx.includes("recall.mjs") && !ctx.includes(SOURCE_SENTENCE));
  assert.match(ctx, /^- 2026-09-0\d \(repo: /m);
});
