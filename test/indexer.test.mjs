// The indexer end to end on fake agent homes laid out like the real ones (default discovery: ~/.claude, ~/.codex, ~/.code under a temp HOME),
// built from the synthetic fixture lines. No network: the fake API answers embeddings in-process.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { minedHomes } from "../scripts/lib/homes.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { FIXTURES, claudeLine, fakeOpenAI, tmpDir } from "./helpers.mjs";

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(path.join(from, e.name), path.join(to, e.name));
    else fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
}

function fakeHomes(root) {
  const claude = path.join(root, ".claude");
  const codex = path.join(root, ".codex");
  const code = path.join(root, ".code");
  const proj = path.join(claude, "projects", "-home-sam-projects-demo-repo");
  const lines = ["human_typed", "tool_result", "queued_human", "task_notification", "queued_no_origin", "meta", "sdk_cli", "sidechain", "legacy_typed"].map((n) => claudeLine(n).toString());
  fs.mkdirSync(path.join(proj, "5aaa0000-0000-0000-0000-000000000001", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(proj, "5aaa0000-0000-0000-0000-000000000001.jsonl"), `${lines.join("\n")}\n`);
  // a sub-agent transcript: its first user record is a parent agent's brief and must never be read
  fs.writeFileSync(path.join(proj, "5aaa0000-0000-0000-0000-000000000001", "subagents", "agent-1.jsonl"), `${claudeLine("human_typed")}\n`);
  copyTree(path.join(FIXTURES, "codex", "sessions"), path.join(codex, "sessions"));
  copyTree(path.join(FIXTURES, "code", "sessions"), path.join(code, "sessions"));
  return { claude, codex, code };
}

function setup() {
  const root = tmpDir("recall-index");
  const homes = fakeHomes(root);
  const dataDir = path.join(root, "data");
  const config = loadConfig({ RECALL_DATA: dataDir, RECALL_MIN_CHARS: "5" });
  const api = fakeOpenAI();
  const runtime = createRuntime(config, { post: api.post });
  // env: {} so a CLAUDE_CONFIG_DIR / CODEX_HOME of the machine running the tests cannot add a home
  const run = () => runIndex({ config, store: runtime.store, api: runtime.api, homeDir: root, env: {} });
  return { root, homes, config, api, runtime, run };
}

test("index: only typed statements, from all three hosts, with ts / session / repo / host", async () => {
  const { runtime, run } = setup();
  const report = await run();
  const rows = runtime.store.loadStatements();
  const texts = rows.map((r) => r.text);
  // claude: typed turn, mid-turn queued message, legacy typed turn
  assert.ok(texts.some((t) => t.startsWith("Please read docs/HANDOVER.md")));
  assert.ok(texts.some((t) => t.startsWith("Use the ledger CLI rather than the HTTP API")));
  assert.ok(texts.some((t) => t.startsWith("That is not quite right yet")));
  // codex interactive: the three typed statements, not the skill link; every statement is typed text
  assert.ok(texts.some((t) => t.startsWith("Please add a CSV export button to the invoices table")));
  assert.ok(texts.some((t) => t.startsWith("Is the export capped at two file sizes")));
  assert.ok(!texts.some((t) => /SKILL\.md/.test(t)), "skill invocation link refused");
  // Every Code
  assert.ok(texts.includes("what's new?"));
  // nothing from tool output, harness envelopes, task notifications, sub-agents, exec or programmatic runs
  for (const bad of ["<task-notification", "<system-reminder", "AGENTS.md instructions", "recommended_plugins", "Reply with exactly: ok", "Synthetic brief for a sub-agent run", "System Status"]) {
    assert.ok(!texts.some((t) => t.includes(bad)), `must not contain ${bad}`);
  }
  assert.equal(report.excluded["exec-session"], 1);
  assert.equal(report.excluded["subagent-session"], 1);
  assert.equal(report.excluded["origin-task-notification"], 1);
  assert.equal(report.excluded["tool-result"], 1);
  assert.equal(report.excluded.sidechain, 1);
  assert.equal(report.excluded.programmatic, 1);
  const byHost = Object.groupBy(rows, (r) => r.host);
  assert.deepEqual(Object.keys(byHost).sort(), ["claude", "code", "codex"]);
  for (const r of rows) {
    assert.ok(r.ts && r.session_id && r.host && r.hash && r.src, JSON.stringify(r));
    assert.ok(!Number.isNaN(Date.parse(r.ts)));
  }
  const claudeRow = rows.find((r) => r.text.startsWith("Please read docs/HANDOVER.md"));
  assert.equal(claudeRow.session_id, "5aaa0000-0000-0000-0000-000000000001");
  assert.match(claudeRow.src, /5aaa0000-0000-0000-0000-000000000001\.jsonl:L1$/);
  const codexRow = rows.find((r) => r.text.startsWith("Please add a CSV export button to the invoices table"));
  assert.equal(codexRow.session_id, "0190a000-aaaa-7000-8000-00000000c001");
  assert.ok(codexRow.repo === null || typeof codexRow.repo === "string");
});

test("repo comes from the checkout's own .git (or a worktree's gitdir file); a path that is not a checkout gives null, never a guess", async () => {
  const { repoOfCwd } = await import("../scripts/lib/repo-of-dir.mjs");
  const root = tmpDir("recall-repo");
  fs.mkdirSync(path.join(root, "myrepo", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "myrepo", "packages", "deep"), { recursive: true });
  assert.equal(repoOfCwd(path.join(root, "myrepo", "packages", "deep")), "myrepo");
  fs.mkdirSync(path.join(root, "wt"), { recursive: true });
  fs.writeFileSync(path.join(root, "wt", ".git"), `gitdir: ${root}/main-repo/.git/worktrees/wt\n`);
  assert.equal(repoOfCwd(path.join(root, "wt")), "main-repo");
  assert.equal(repoOfCwd("relative/path"), null);
  assert.equal(repoOfCwd(null), null);
});

test("index: every candidate the text filter rejected is logged with its reason", async () => {
  const { config, run } = setup();
  await run();
  const dropped = fs.readFileSync(path.join(config.dataDir, "logs", "index-dropped.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(dropped.length > 0);
  for (const d of dropped) assert.ok(d.reason && d.src && d.host);
  assert.ok(dropped.some((d) => d.reason === "skill-invocation"));
});

test("index: each statement is embedded once, and a second run does nothing", async () => {
  const { api, run, runtime } = setup();
  const first = await run();
  const n = runtime.store.loadStatements().length;
  assert.ok(first.embedding.embedded > 0 && first.embedding.embedded <= n);
  const embedCalls = () => api.calls.filter((c) => c.pathname === "/v1/embeddings").reduce((s, c) => s + c.body.input.length, 0);
  assert.equal(embedCalls(), first.embedding.embedded, "texts sent == texts embedded");
  const second = await run();
  assert.equal(second.added, 0);
  assert.equal(second.scanned, 0, "unchanged files are not opened");
  assert.equal(second.skippedUnchanged, second.files);
  assert.equal(embedCalls(), first.embedding.embedded, "no further embedding");
  assert.equal(runtime.store.loadStatements().length, n);
});

test("index: incremental by offset - an appended line is read, nothing before it is re-read, an identical sentence in the same second is one id", async () => {
  const { homes, run, runtime, api } = setup();
  await run();
  const file = path.join(homes.claude, "projects", "-home-sam-projects-demo-repo", "5aaa0000-0000-0000-0000-000000000001.jsonl");
  const before = fs.statSync(file).size;
  const newest = JSON.parse(claudeLine("human_typed"));
  newest.message.content = "Never add a fallback path; remove the deprecated one instead.";
  newest.timestamp = "2026-10-08T01:02:03.456Z";
  newest.origin = { kind: "human" };
  fs.appendFileSync(file, `${JSON.stringify(newest)}\n`);
  const r = await run();
  assert.equal(r.scanned, 1);
  assert.equal(r.added, 1);
  assert.equal(r.embedding.embedded, 1);
  const state = runtime.store.loadState().files[file];
  assert.ok(state.offset > before && state.offset === fs.statSync(file).size);
  assert.equal(state.lines, 10);
  const row = runtime.store.loadStatements().find((s) => s.text.startsWith("Never add a fallback"));
  assert.match(row.src, /:L10$/, "1-based absolute line number survives an incremental pass");
  // the same turn copied into another home (a resumed or forked session) is not added twice
  const copyDir = path.join(homes.claude, "projects", "-Users-nobody-www-demo-fork");
  fs.mkdirSync(copyDir, { recursive: true });
  fs.copyFileSync(file, path.join(copyDir, "5bbb0000-0000-0000-0000-000000000002.jsonl"));
  const r2 = await run();
  assert.equal(r2.added, 0);
  assert.ok(r2.duplicates >= 4);
  assert.ok(api.calls.length > 0);
});

test("index: a partly written last line is left for the next pass", async () => {
  const { homes, run, runtime } = setup();
  await run();
  const file = path.join(homes.claude, "projects", "-home-sam-projects-demo-repo", "5aaa0000-0000-0000-0000-000000000001.jsonl");
  const rec = JSON.parse(claudeLine("human_typed"));
  rec.message.content = "A sentence that is still being written to the transcript right now.";
  rec.timestamp = "2026-10-09T00:00:00.000Z";
  const text = JSON.stringify(rec);
  fs.appendFileSync(file, text.slice(0, 120));
  assert.equal((await run()).added, 0);
  fs.appendFileSync(file, `${text.slice(120)}\n`);
  assert.equal((await run()).added, 1);
  assert.ok(runtime.store.loadStatements().some((s) => s.text.startsWith("A sentence that is still being written")));
});

test("index: a file that shrank is rescanned from the start", async () => {
  const { homes, run } = setup();
  await run();
  const file = path.join(homes.claude, "projects", "-home-sam-projects-demo-repo", "5aaa0000-0000-0000-0000-000000000001.jsonl");
  fs.writeFileSync(file, `${claudeLine("human_typed")}\n`);
  const r = await run();
  assert.equal(r.rescanned, 1);
  assert.equal(r.scanned, 1);
});

test("index: a Codex rollout compressed with zstd is read whole", async () => {
  const { homes, run, runtime } = setup();
  const zlib = await import("node:zlib");
  const src = path.join(homes.codex, "sessions", "2026", "09", "02", "rollout-2026-09-02T15-02-46-0190a000-aaaa-7000-8000-00000000c001.jsonl");
  const dst = path.join(homes.codex, "sessions", "2026", "08", "13", "rollout-2026-08-13T09-00-00-0190a000-aaaa-7000-8000-00000000c002.jsonl.zst");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const text = fs.readFileSync(src, "utf8").replace(/0190a000-aaaa-7000-8000-00000000c001/g, "0190a000-aaaa-7000-8000-00000000c002").replace(/Please add a CSV export button to the invoices table/g, "Please add a CSV export button to the orders table");
  fs.writeFileSync(dst, zlib.zstdCompressSync(Buffer.from(text)));
  await run();
  const rows = runtime.store.loadStatements();
  assert.ok(rows.some((r) => r.text.startsWith("Please add a CSV export button to the orders table") && r.session_id === "0190a000-aaaa-7000-8000-00000000c002"));
});

function oneHome(root, dir, kind, files) {
  const proj = path.join(root, dir, kind === "claude" ? "projects/-x" : "sessions/2026/10/01");
  fs.mkdirSync(proj, { recursive: true });
  for (const [name, line] of Object.entries(files)) fs.writeFileSync(path.join(proj, name), `${line}\n`);
}

test("index: default homes are ~/.claude, ~/.codex and ~/.code under HOME, plus $CLAUDE_CONFIG_DIR and $CODEX_HOME when set; other agent homes are reported, not read", async () => {
  const root = tmpDir("recall-default-homes");
  for (const dir of [".claude", ".claude_work", ".claude_spare", ".codex", ".codex_work", ".code"]) oneHome(root, dir, dir.startsWith(".claude") ? "claude" : "codex", {});
  const homesOf = async (env, extra = {}) => (await minedHomes({ homes: [], homesRoster: "", ...extra }, { homeDir: root, env })).homes.map((h) => path.relative(root, h.dir)).sort();
  assert.deepEqual(await homesOf({}), [".claude", ".code", ".codex"]);
  assert.deepEqual(await homesOf({ CLAUDE_CONFIG_DIR: path.join(root, ".claude_work"), CODEX_HOME: path.join(root, ".codex_work") }), [".claude", ".claude_work", ".code", ".codex", ".codex_work"]);
  const mined = await minedHomes({ homes: [path.join(root, ".claude_spare"), "~/.codex_work", path.join(root, "not-there")], homesRoster: "" }, { homeDir: root, env: {} });
  assert.deepEqual(mined.homes.map((h) => [path.relative(root, h.dir), h.kind]).sort(), [[".claude", "claude"], [".claude_spare", "claude"], [".code", "code"], [".codex", "codex"], [".codex_work", "codex"]], "config homes are added to the standard ones; a missing one is skipped");
  assert.deepEqual(mined.skipped.map((d) => path.relative(root, d)), [".claude_work"], "an agent home that is neither standard nor listed is reported");
  const homeless = await minedHomes({ homes: [], homesRoster: "" }, { homeDir: tmpDir("recall-empty-home"), env: {} });
  assert.deepEqual(homeless, { homes: [], skipped: [] });
});

test("index: RECALL_HOMES is a path-delimited list, added to the defaults", () => {
  const config = loadConfig({ RECALL_DATA: tmpDir(), RECALL_HOMES: `/a${path.delimiter}/b` });
  assert.deepEqual([...config.homes], ["/a", "/b"]);
});

test("index: with a roster (config homesRoster) the roster names the homes; others are reported; credential files are never opened", async () => {
  const root = tmpDir("recall-roster");
  oneHome(root, ".claude_stranger", "claude", { "s.jsonl": claudeLine("human_typed").toString() });
  oneHome(root, ".claude_mine", "claude", { "s.jsonl": claudeLine("human_typed").toString() });
  fs.mkdirSync(path.join(root, ".claude_mine", "projects", "-token-dir"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude_mine", "projects", "-token-dir", "s.jsonl"), `${claudeLine("legacy_typed")}\n`);
  fs.writeFileSync(path.join(root, "roster.json"), JSON.stringify([{ id: "mine", kind: "claude", home: path.join(root, ".claude_mine"), protected: false, manual: false }]));
  const config = loadConfig({ RECALL_DATA: path.join(root, "data"), RECALL_HOMES_ROSTER: path.join(root, "roster.json") });
  const api = fakeOpenAI();
  const runtime = createRuntime(config, { post: api.post });
  const logs = [];
  const report = await runIndex({ config, store: runtime.store, api: runtime.api, homeDir: root, env: {}, log: (s) => logs.push(s) });
  assert.deepEqual(report.homes, [path.join(root, ".claude_mine")]);
  assert.ok(logs.some((l) => l.includes(".claude_stranger") && /not read/.test(l)), logs.join("\n"));
  assert.equal(runtime.store.loadStatements().length, 1);
  assert.ok(!runtime.store.loadStatements().some((s) => s.text.startsWith("That is not quite right yet")), "a path containing 'token' is never opened");
});

test("index: a roster that cannot be read is an error, not a silent fall back to the default homes", async () => {
  const root = tmpDir("recall-bad-roster");
  const config = loadConfig({ RECALL_DATA: path.join(root, "data"), RECALL_HOMES_ROSTER: path.join(root, "missing.json") });
  const runtime = createRuntime(config, { post: fakeOpenAI().post });
  await assert.rejects(() => runIndex({ config, store: runtime.store, api: runtime.api, homeDir: root, env: {} }), /roster file .* does not exist/);
});

test("index --dry-run: scans from scratch, reports what an index would hold and how it differs from the index on disk, and writes nothing", async () => {
  const { config, runtime, root } = setup();
  const before = () => fs.existsSync(config.dataDir) ? fs.readdirSync(config.dataDir, { recursive: true }).sort() : [];
  const dry = await runIndex({ config, store: runtime.store, homeDir: root, env: {}, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.statements >= 6);
  assert.deepEqual(dry.vsIndex, { indexed: 0, added: dry.statements, addedOldest: dry.vsIndex.addedOldest, addedNewest: dry.vsIndex.addedNewest, removed: 0 });
  assert.ok(dry.toEmbed.texts > 0 && dry.toEmbed.chars > 0);
  assert.deepEqual(before(), [], "a dry run creates nothing in the data dir");
  const real = await runIndex({ config, store: runtime.store, api: runtime.api, homeDir: root, env: {} });
  assert.equal(real.added, dry.statements, "the dry run and the real index find the same statements");
  const again = await runIndex({ config, store: runtime.store, homeDir: root, env: {}, dryRun: true });
  assert.deepEqual([again.statements, again.vsIndex.indexed, again.vsIndex.added, again.vsIndex.removed], [dry.statements, dry.statements, 0, 0]);
  assert.equal(again.toEmbed.texts, 0, "everything is embedded already");
  const snapshot = before();
  await runIndex({ config, store: runtime.store, homeDir: root, env: {}, dryRun: true });
  assert.deepEqual(before(), snapshot, "a dry run over an existing index changes nothing");
});
