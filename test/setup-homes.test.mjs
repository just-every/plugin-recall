// Choosing homes at setup: --exclude (recorded, kept on later runs), home numbers typed at the go-ahead, --homes (only these, even a home
// left out before), a path that is not a home (exit 2), every home left out, and a home that holds another copy of Recall.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakeClis } from "./fake-cli.mjs";
import { startFakeServer, tmpDir } from "./helpers.mjs";
import { claudeState } from "./host-sim.mjs";
import { KEY, recall, sandboxHome, waitForCards } from "./sandbox.mjs";

const installs = (home) => JSON.parse(fs.readFileSync(path.join(home, ".plugin-recall", "state", "installs.json"), "utf8")).homes.map((h) => `${path.basename(h.home)} ${h.status}`).sort();
/** The homes a plugin install or add ran in. */
const installedIn = (clis) => [...new Set(clis.log().filter((c) => c.args[0] === "plugin" && ["install", "add"].includes(c.args[1]))
  .map((c) => path.basename(c.bin === "claude" ? c.claudeConfigDir ?? ".claude" : c.codexHome)))].sort();

test("--exclude leaves a home out and records it; a later run keeps it out; --homes names it back in", async () => {
  const server = await startFakeServer();
  const home = sandboxHome({ claude: [".claude", ".claude_work"], codex: [".codex", ".codex_work"] });
  const env = { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url };
  try {
    let clis = fakeClis();
    let r = await recall(["--yes", "--exclude", "~/.claude_work,~/.codex_work"], { home, clis, env });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}2 {2}~\/\.claude_work {2}Claude Code {2}1 session {2}left out\n/);
    assert.ok(r.stdout.replace(/\n +/g, " ").includes(" To add the left-out homes later: npx -y @just-every/plugin-recall --homes ~/.claude_work,~/.codex_work\n\n"), r.stdout);
    assert.match(r.stdout, /Install Recall 0\.5\.1 in 2 homes: ~\/\.claude, ~\/\.codex\n/);
    assert.deepEqual(installedIn(clis), [".claude", ".codex"]);
    assert.deepEqual(installs(home), [".claude installed", ".claude_work left-out", ".codex installed", ".codex_work left-out"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".plugin-recall", "config.json"), "utf8")), { dailyCapUsd: 1 }, "a left-out home is not added to the homes read");
    await waitForCards(path.join(home, ".plugin-recall"));

    clis = fakeClis();
    r = await recall([], { home, clis, env, stdin: "" });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /~\/\.codex_work {3}Codex {8}1 session {2}left out\n {2}To add the left-out homes later:[\s\S]*Everything is up to date: Recall 0\.5\.1 in 2 homes\./);

    clis = fakeClis();
    r = await recall(["--homes", "~/.codex_work", "--yes"], { home, clis, env });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}· {2}~\/\.claude {7}Claude Code {2}1 session {2}not named in --homes; left as it is\n/);
    assert.match(r.stdout, /\n {2}1 {2}~\/\.codex_work {3}Codex {8}1 session {2}new\n/);
    assert.deepEqual(installedIn(clis), [".codex_work"]);
    assert.deepEqual(installs(home), [".claude installed", ".claude_work left-out", ".codex installed", ".codex_work installed"]);
  } finally {
    await server.close();
  }
});

test("typing home numbers at the go-ahead leaves those out, shows the homes and the plan again and goes ahead without asking again", async () => {
  const server = await startFakeServer();
  const home = sandboxHome({ claude: [".claude", ".claude_work"], codex: [".codex", ".codex_work"] });
  const clis = fakeClis();
  try {
    const r = await recall([], { home, clis, stdin: "9\n2, 4\n", env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const asks = r.stdout.split("Go ahead? [Y/n, or numbers to leave homes out]").length - 1;
    assert.equal(asks, 2, "asked again after a number that names no home, and not again after leaving two out");
    assert.match(r.stdout, /\nLeaving out ~\/\.claude_work, ~\/\.codex_work\.\n\nAgent homes \(4\)\n/);
    assert.match(r.stdout, /\nType y, n, or home numbers such as 2,4\.\n/);
    assert.match(r.stdout, /\n\nAgent homes \(4\)\n {2}1 {2}~\/\.claude {7}Claude Code {2}1 session {2}new\n {2}2 {2}~\/\.claude_work {2}Claude Code {2}1 session {2}left out\n[\s\S]*\n {2}Install Recall 0\.5\.1 in 2 homes: ~\/\.claude, ~\/\.codex\n/);
    assert.deepEqual(installedIn(clis), [".claude", ".codex"]);
    assert.deepEqual(installs(home), [".claude installed", ".claude_work left-out", ".codex installed", ".codex_work left-out"]);
    await waitForCards(path.join(home, ".plugin-recall"));
  } finally {
    await server.close();
  }
});

test("a default home left out is still read for memory, and says so; leaving every home out ends the run with nothing changed", async () => {
  const server = await startFakeServer();
  const home = sandboxHome();
  const all = sandboxHome();
  try {
    const r = await recall([], { home, clis: fakeClis(), stdin: "2\n", env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("\n  2  ~/.codex   Codex        1 session  left out; still read for memory\n  To add the left-out home later: npx -y @just-every/plugin-recall --homes ~/.codex\n"), r.stdout);
    assert.match(r.stdout, /\n {2}Install Recall 0\.5\.1 in 1 home: ~\/\.claude\n/);
    await waitForCards(path.join(home, ".plugin-recall"));
    const none = await recall([], { home: all, clis: fakeClis(), stdin: "1,2\n", env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(none.code, 0);
    assert.ok(none.stdout.endsWith("Go ahead? [Y/n, or numbers to leave homes out] \nNo homes left to install into. Nothing was changed.\n"), none.stdout);
    assert.deepEqual(fs.readdirSync(all).sort(), [".claude", ".codex"]);
  } finally {
    await server.close();
  }
});

test("--homes or --exclude with a path that is not a discovered home is a usage error (exit 2)", async () => {
  const home = sandboxHome();
  for (const flag of ["--homes", "--exclude"]) {
    const r = await recall([flag, "~/.claude,~/nowhere", "--dry-run"], { home, clis: fakeClis(), env: { OPENAI_API_KEY: KEY } });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.equal(r.stderr, `recall setup: ${flag}: ~/nowhere is not an agent home Recall found on this machine\n`);
  }
});

test("a home with another copy of Recall is listed with · and never touched", async () => {
  const server = await startFakeServer();
  const home = sandboxHome({ claude: [".claude", ".claude_side"] });
  claudeState(path.join(home, ".claude_side"), { other: "recall@someone-else" });
  const clis = fakeClis();
  try {
    const r = await recall(["--yes"], { home, clis, env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Agent homes \(3\)\n {2}1 {2}~\/\.claude {7}Claude Code {2}1 session {2}new\n {2}· {2}~\/\.claude_side {2}Claude Code {2}1 session {2}has recall@someone-else; left alone\n {2}2 {2}~\/\.codex {8}Codex {8}1 session {2}new\n/);
    assert.ok(!clis.log().some((c) => c.claudeConfigDir?.endsWith(".claude_side")));
    assert.deepEqual(installs(home), [".claude installed", ".codex installed"]);
    await waitForCards(path.join(home, ".plugin-recall"));
  } finally {
    await server.close();
  }
});

test("a home outside ~ with a long path gets its own line in the table, so no row runs wide", async () => {
  const home = sandboxHome();
  const elsewhere = path.join(tmpDir("recall-a-home-kept-somewhere-else-on-this-machine"), "claude-config-home");
  fs.mkdirSync(elsewhere);
  const r = await recall(["--dry-run"], { home, clis: fakeClis(), env: { OPENAI_API_KEY: KEY, CLAUDE_CONFIG_DIR: elsewhere } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const table = r.stdout.split("Agent homes (3)\n")[1].split("\n\n")[0].split("\n");
  assert.deepEqual(table.map((l) => l.replace(/ +/g, " ")), [" 1 ~/.claude Claude Code 1 session new", ` 2 ${elsewhere}`, " Claude Code 0 sessions new", " 3 ~/.codex Codex 1 session new"]);
  assert.ok(table.every((l) => l.length <= Math.max(100, elsewhere.length + 5)), table.join("\n"));
  assert.equal(table[2].indexOf("Claude Code"), table[0].indexOf("Claude Code"), "the row goes on under its own column");
});
