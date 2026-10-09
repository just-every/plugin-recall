// Homes read for indexing only: a config `homes` entry written {path, kind} (a backup, a copy from another machine, an old home whose name does
// not say its kind, an account no worker may use). It is indexed like any home, never a worker's: the router, with or without a roster, never
// places card or judge work there. With no config.json, no such home is read. Synthetic homes under a temp HOME; no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ConfigError, loadConfig } from "../scripts/lib/config.mjs";
import { indexedHomes, indexOnlyHomes, minedHomes } from "../scripts/lib/homes.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { createRouter } from "../scripts/lib/router.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { diagnose } from "../scripts/onboarding/diagnose.mjs";
import { claudeUser, codexUser, writeTranscript } from "./transcript-builders.mjs";
import { tmpDir } from "./helpers.mjs";

const writeConfig = (dataDir, body) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(body)); };
const meta = (id) => JSON.stringify({ timestamp: "2026-03-01T08:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2026-03-01T08:00:00.000Z", cwd: "/home/sam/projects/web-app", originator: "codex_cli_rs", cli_version: "0.140.0", source: "cli", thread_source: "user" } });

/** A HOME with the standard homes and three kinds of old home: a backup named like a Codex home, an Every Code copy from another machine, a folder whose name says nothing. */
function world() {
  const root = tmpDir("recall-index-only");
  const claude = path.join(root, ".claude", "projects", "-home-sam-projects-web-app");
  fs.mkdirSync(claude, { recursive: true });
  writeTranscript("5ddd0000-0000-4000-8000-000000000001.jsonl", [claudeUser("The live home's own statement about the web app layout", "2026-09-30T08:00:00.100Z")], claude);
  const homes = { backup: path.join(root, ".codex_backup"), copy: path.join(root, "machine-copy", "home", "sam", ".code"), plain: path.join(root, "codex_old"), claudeSpare: path.join(root, ".claude_spare") };
  for (const [name, dir] of Object.entries(homes)) {
    if (name === "claudeSpare") {
      const p = path.join(dir, "projects", "-home-sam-projects-web-app");
      fs.mkdirSync(p, { recursive: true });
      writeTranscript("5ddd0000-0000-4000-8000-000000000002.jsonl", [claudeUser("A statement typed in the spare account about the invoices page", "2026-09-29T08:00:00.100Z")], p);
      continue;
    }
    const day = path.join(dir, "sessions", "2026", "03", "01");
    fs.mkdirSync(day, { recursive: true });
    const id = `0190f000-aaaa-7000-8000-0000000000${name === "backup" ? "01" : name === "copy" ? "02" : "03"}`;
    writeTranscript(`rollout-2026-03-01T08-00-00-${id}.jsonl`, [meta(id), codexUser(`A statement from the ${name} home about the ledger export`, "2026-03-01T08:01:00.100Z")], day);
    fs.writeFileSync(path.join(dir, "history.jsonl"), `${JSON.stringify({ session_id: `0190f000-bbbb-7000-8000-0000000000${id.slice(-2)}`, ts: 1772352000, text: `A history row of the ${name} home about the ledger totals` })}\n`);
  }
  const entries = [{ path: homes.backup, kind: "codex" }, { path: "~/machine-copy/home/sam/.code", kind: "code" }, { path: homes.plain, kind: "codex" }, { path: homes.claudeSpare, kind: "claude" }];
  return { root, homes, entries };
}

test("config homes: a path or {path, kind}, validated loudly (kind, fields, empty path, a home twice); the environment takes a JSON array too", () => {
  const dataDir = tmpDir("recall-cfg-homes");
  writeConfig(dataDir, { homes: ["~/.claude_work", { path: "~/old/codex", kind: "codex" }] });
  assert.deepEqual(loadConfig({ RECALL_DATA: dataDir }).homes, ["~/.claude_work", { path: "~/old/codex", kind: "codex" }]);
  for (const [body, re] of [
    [[{ path: "~/x", kind: "gemini" }], /kind "gemini", not one of claude, codex, code/],
    [[{ path: "~/x", kind: "codex", worker: true }], /unknown field "worker"/],
    [[{ path: "", kind: "codex" }], /needs a non-empty "path"/],
    [[{ kind: "codex" }], /needs a non-empty "path"/],
    [["~/x", { path: "~/x", kind: "codex" }], /listed twice/],
    [[null], /null is not a string/],
  ]) {
    writeConfig(dataDir, { homes: body });
    assert.throws(() => loadConfig({ RECALL_DATA: dataDir }), (e) => e instanceof ConfigError && re.test(e.message), JSON.stringify(body));
  }
  const env = loadConfig({ RECALL_DATA: tmpDir("recall-cfg-homes-env"), RECALL_HOMES: '[{"path":"/old/code","kind":"code"},"/a"]' });
  assert.deepEqual(env.homes, [{ path: "/old/code", kind: "code" }, "/a"]);
  assert.throws(() => loadConfig({ RECALL_DATA: tmpDir(), RECALL_HOMES: "[oops" }), /RECALL_HOMES=.* is not a JSON array of homes/);
});

test("homes: an index-only home is indexed (indexedHomes) but is no mined home, so it is neither a worker candidate nor reported as skipped", async () => {
  const w = world();
  const config = { homes: w.entries, homesRoster: "" };
  const mined = await minedHomes(config, { homeDir: w.root, env: {} });
  assert.deepEqual(mined.homes.map((h) => path.relative(w.root, h.dir)), [".claude"]);
  assert.deepEqual(mined.skipped, [], ".codex_backup and .claude_spare are listed, so they are not 'found but not read'");
  assert.deepEqual(indexOnlyHomes(config, { homeDir: w.root }).map((h) => [path.relative(w.root, h.dir), h.kind]), [[".codex_backup", "codex"], ["machine-copy/home/sam/.code", "code"], ["codex_old", "codex"], [".claude_spare", "claude"]]);
  const read = await indexedHomes(config, { homeDir: w.root, env: {} });
  assert.equal(read.homes.length, 5);
  assert.deepEqual((await indexedHomes({ homes: [{ path: path.join(w.root, "gone"), kind: "codex" }], homesRoster: "" }, { homeDir: w.root, env: {} })).homes.length, 1, "a home that does not exist is skipped");
});

test("index: with no config.json, none of the old homes is read; with them in config homes, all are, by their stated kind", async () => {
  const w = world();
  const bare = loadConfig({ RECALL_DATA: path.join(w.root, "data-bare"), HOME: w.root });
  assert.equal(bare.configFile, null);
  const logs = [];
  const none = await runIndex({ config: bare, store: createStore(bare.dataDir), homeDir: w.root, env: {}, embed: false, dryRun: true, log: (s) => logs.push(s) });
  assert.deepEqual(none.homes, [path.join(w.root, ".claude")]);
  assert.equal(none.statements, 1);
  assert.ok(logs.some((l) => /not read/.test(l) && l.includes(".codex_backup") && l.includes(".claude_spare")), "the agent homes found are reported, not read");
  const dataDir = path.join(w.root, "data");
  writeConfig(dataDir, { homes: w.entries });
  const config = loadConfig({ RECALL_DATA: dataDir, HOME: w.root });
  const all = await runIndex({ config, store: createStore(config.dataDir), homeDir: w.root, env: {}, embed: false, now: () => Date.parse("2026-10-01T00:00:00.000Z") });
  const texts = createStore(dataDir).loadStatements().map((s) => `${s.host}: ${s.text}`).sort();
  assert.deepEqual(texts, [
    "claude: A statement typed in the spare account about the invoices page",
    "claude: The live home's own statement about the web app layout",
    "code: A history row of the copy home about the ledger totals",
    "code: A statement from the copy home about the ledger export",
    "codex: A history row of the backup home about the ledger totals",
    "codex: A history row of the plain home about the ledger totals",
    "codex: A statement from the backup home about the ledger export",
    "codex: A statement from the plain home about the ledger export",
  ]);
  assert.equal(all.homes.length, 5);
});

test("router: an index-only home is never picked for card or judge work, by usage (usageCmd) or by the roster", async () => {
  const w = world();
  const claudeHomes = [path.join(w.root, ".claude"), w.homes.claudeSpare];
  const usage = { results: [
    { path: claudeHomes[0], windows: [{ label: "1w", usedPercent: 70, elapsedPercent: 50 }] },
    { path: w.homes.claudeSpare, windows: [{ label: "1w", usedPercent: 1, elapsedPercent: 50 }] },
    { path: w.homes.backup, windows: [{ label: "1w", usedPercent: 1, elapsedPercent: 50 }] },
  ] };
  const withUsage = loadConfig({ RECALL_DATA: tmpDir("recall-router-io"), RECALL_USAGE_CMD: "my-usage", RECALL_HOMES: JSON.stringify(w.entries) });
  const r = createRouter({ config: withUsage, homeDir: w.root, env: {}, run: async () => usage, hasCli: () => true });
  const claude = await r.pick("claude");
  assert.equal(claude.home, claudeHomes[0], "the spare account has more headroom, but it is index-only");
  assert.ok(!claude.considered.some((c) => c.home === w.homes.claudeSpare));
  const codex = await r.pick("codex");
  assert.equal(codex.home, null, "the only codex homes are index-only: no codex worker at all");
  assert.ok(!codex.considered.some((c) => Object.values(w.homes).includes(c.home)));

  const roster = path.join(w.root, "roster.json");
  fs.writeFileSync(roster, JSON.stringify([{ id: "main", kind: "claude", home: claudeHomes[0], protected: false, manual: false }]));
  const withRoster = loadConfig({ RECALL_DATA: tmpDir("recall-router-io"), RECALL_HOMES_ROSTER: roster, RECALL_HOMES: JSON.stringify(w.entries) });
  const rr = createRouter({ config: withRoster, homeDir: w.root, env: {}, run: async () => usage, hasCli: () => true });
  assert.equal((await rr.pick("claude")).home, claudeHomes[0]);
  assert.equal((await rr.pick("codex")).home, null);
  // pinning an index-only home is refused like any home outside the roster
  const pinned = loadConfig({ RECALL_DATA: tmpDir("recall-router-io"), RECALL_HOMES_ROSTER: roster, RECALL_HOMES: JSON.stringify(w.entries), RECALL_CLAUDE_HOME: w.homes.claudeSpare });
  assert.match((await createRouter({ config: pinned, homeDir: w.root, env: {}, run: async () => usage, hasCli: () => true }).pick("claude")).reason, /is not an eligible roster home/);
});

test("doctor lists an index-only home among the homes read, marked as such", async () => {
  const w = world();
  const dataDir = path.join(w.root, ".plugin-recall");
  writeConfig(dataDir, { homes: w.entries });
  const { checks } = await diagnose({ env: { PATH: "", OPENAI_API_KEY: "sk-test-no-network" }, homeDir: w.root, offline: true });
  const homes = checks.find((c) => c.id === "homes");
  assert.match(homes.title, /^5 agent homes, \d+ transcript files$/);
  const shown = (p) => `~/${path.relative(w.root, p)}`; // doctor shows paths under the home folder with ~, as setup does
  assert.ok(homes.lines.some((l) => l.startsWith(`${shown(w.homes.backup)}  (codex, read for indexing only,`)), homes.lines.join("\n"));
  assert.ok(homes.lines.some((l) => l.startsWith("~/.claude  (claude, 1 transcript file)")));
});
