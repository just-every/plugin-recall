// `recall uninstall` in a sandbox HOME: Recall removed from every home through the hosts' own CLIs, then its copy and the recall command;
// another copy of Recall never touched; --purge; run from the installed copy itself; nothing installed; a decline and a failure.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakeClis } from "./fake-cli.mjs";
import { startFakeServer } from "./helpers.mjs";
import { claudeState } from "./host-sim.mjs";
import { KEY, recall, sandboxHome, waitForCards } from "./sandbox.mjs";

const V = "0.5.2";

async function installedHome(server, { claude = [".claude", ".claude_work"], before = () => {} } = {}) {
  const home = sandboxHome({ claude, codex: [".codex", ".codex_work"] });
  before(home);
  const r = await recall(["--yes"], { home, clis: fakeClis(), env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  await waitForCards(path.join(home, ".plugin-recall"));
  return home;
}

test("uninstall --yes, run from the recall command itself: every home, then the copy and the command; the data and the key stay", async () => {
  const server = await startFakeServer();
  try {
    const home = await installedHome(server);
    const launcher = path.join(home, ".local", "bin", "recall");
    const clis = fakeClis();
    const r = await recall(["uninstall", "--yes"], { home, clis, script: launcher });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, [
      `Recall ${V} · uninstall`, "", "Recall is installed in 4 homes:",
      "  ~/.claude       Claude Code", "  ~/.claude_work  Claude Code", "  ~/.codex        Codex", "  ~/.codex_work   Codex",
      "Remove Recall from 4 homes? [--yes] yes",
      "  ✓ ~/.claude       Claude Code  removed", "  ✓ ~/.claude_work  Claude Code  removed", "  ✓ ~/.codex        Codex        removed", "  ✓ ~/.codex_work   Codex        removed",
      "  ✓ Removed ~/.plugin-recall/marketplace", "  ✓ Removed the recall command (~/.local/bin/recall)", "",
      "Recall is uninstalled.", "  Kept: your index, summaries and logs in ~/.plugin-recall.",
      "    Delete them with: rm -rf ~/.plugin-recall", "    or: npx -y @just-every/plugin-recall uninstall --purge",
      "  Kept: OPENAI_API_KEY in ~/.env, which other tools may use.", "",
    ].join("\n"));
    const lines = clis.log().filter((c) => c.args[0] === "plugin").map((c) => `${c.bin} ${c.args.join(" ")}`).sort();
    assert.deepEqual(lines, [
      ...Array(2).fill("claude plugin marketplace remove plugin-recall --json"), ...Array(2).fill("claude plugin uninstall recall@plugin-recall --json"),
      ...Array(2).fill("codex plugin marketplace remove plugin-recall --json"), ...Array(2).fill("codex plugin remove recall@plugin-recall --json"),
    ]);
    for (const p of [".local", ".plugin-recall/marketplace", ".plugin-recall/state/installs.json"]) assert.ok(!fs.existsSync(path.join(home, p)), p);
    for (const h of [".claude", ".claude_work", ".codex", ".codex_work"]) assert.ok(!fs.existsSync(path.join(home, h, "plugins", "cache", "plugin-recall")), `${h}: no cache left (Claude Code's copies all orphaned)`);
    for (const p of [".plugin-recall/statements.jsonl", ".plugin-recall/config.json", ".env"]) assert.ok(fs.existsSync(path.join(home, p)), p);
    const again = await recall(["uninstall"], { home, clis: fakeClis() });
    assert.equal(again.code, 0);
    assert.equal(again.stdout, `Recall ${V} · uninstall\n\nRecall is not installed in any agent home.\nYour data is still in ~/.plugin-recall. To delete it:\n  npx -y @just-every/plugin-recall uninstall --purge\n`);
  } finally {
    await server.close();
  }
});

test("another copy of Recall is shown and left alone; --purge also deletes the data dir", async () => {
  const server = await startFakeServer();
  try {
    const mine = (home) => path.join(home, ".local", "bin", "my-tool");
    const home = await installedHome(server, { claude: [".claude"], before: (h) => { fs.mkdirSync(path.dirname(mine(h)), { recursive: true }); fs.writeFileSync(mine(h), ""); } });
    const side = path.join(home, ".claude_side");
    fs.mkdirSync(side);
    fs.writeFileSync(path.join(side, ".claude.json"), "{}");
    claudeState(side, { other: "recall@someone-else" });
    const clis = fakeClis();
    const r = await recall(["uninstall", "--purge"], { home, clis, stdin: "y\n" });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}· {2}~\/\.claude_side {2}Claude Code {2}has recall@someone-else; left alone\n/);
    assert.match(r.stdout, /\nRemove Recall from 3 homes and delete ~\/\.plugin-recall \(index, summaries, logs, settings\)\? \[y\/N\] \n/);
    assert.match(r.stdout, /\n {2}✓ Deleted ~\/\.plugin-recall\n\nRecall is uninstalled\.\n {2}Kept: OPENAI_API_KEY in ~\/\.env/);
    assert.ok(!fs.existsSync(path.join(home, ".plugin-recall")));
    assert.ok(fs.existsSync(mine(home)) && !fs.existsSync(path.join(home, ".local", "bin", "recall")), "a ~/.local/bin setup did not make stays");
    assert.ok(!clis.log().some((c) => c.claudeConfigDir === side));
    assert.ok(JSON.parse(fs.readFileSync(path.join(side, "plugins", "installed_plugins.json"), "utf8")).plugins["recall@someone-else"]);
  } finally {
    await server.close();
  }
});

test("the default is no; end of input changes nothing; a home that fails keeps the copy and exits 1", async () => {
  const server = await startFakeServer();
  try {
    const home = await installedHome(server);
    let r = await recall(["uninstall"], { home, clis: fakeClis(), stdin: "\n" });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.endsWith("Remove Recall from 4 homes? [y/N] \nStopped. Nothing was changed.\n"), r.stdout);
    r = await recall(["uninstall"], { home, clis: fakeClis(), stdin: "" });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /No answer on stdin, so nothing was changed\. To run without questions, add --yes\.\n$/);
    const failing = fakeClis({ fail: { "codex plugin remove recall@plugin-recall": "config.toml is locked" } });
    r = await recall(["uninstall", "-y"], { home, clis: failing });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /✗ ~\/\.codex {8}Codex {8}failed: config\.toml is locked\n/);
    assert.match(r.stdout, /✓ ~\/\.claude {7}Claude Code {2}removed\n/);
    assert.ok(fs.existsSync(path.join(home, ".plugin-recall", "marketplace")) && fs.existsSync(path.join(home, ".local", "bin", "recall")));
  } finally {
    await server.close();
  }
});

test("--purge refuses a data dir that is the home folder", async () => {
  const home = sandboxHome();
  const r = await recall(["uninstall", "--purge", "--yes"], { home, clis: fakeClis(), env: { RECALL_DATA: home } });
  assert.equal(r.code, 1);
  assert.ok(r.stdout.endsWith("\n--purge refuses to delete ~: it is the home folder or holds it. Nothing was changed.\n"), r.stdout);
  assert.ok(fs.existsSync(path.join(home, ".claude")));
});

test("Claude Code's cached copies: removed when every version is orphaned (an update's old one included); else the summary says Claude Code clears them", async () => {
  const server = await startFakeServer();
  try {
    const home = await installedHome(server, { claude: [".claude", ".claude_work"] });
    const cache = (h) => path.join(home, h, "plugins", "cache", "plugin-recall");
    // an older copy Claude Code orphaned at an update, next to the current one it orphans at uninstall
    fs.mkdirSync(path.join(cache(".claude"), "recall", "0.4.9"), { recursive: true });
    fs.writeFileSync(path.join(cache(".claude"), "recall", "0.4.9", ".orphaned_at"), "1");
    assert.ok(fs.existsSync(path.join(cache(".claude"), "recall", V, ".claude-plugin", "plugin.json")), "the fake claude caches the installed copy");
    // a copy in ~/.claude_work that is not marked (still in use by a session that has not seen the uninstall)
    fs.mkdirSync(path.join(cache(".claude_work"), "recall", "0.5.1-dev"), { recursive: true });
    fs.writeFileSync(path.join(cache(".claude_work"), "recall", "0.5.1-dev", "README.md"), "a copy");
    const r = await recall(["uninstall", "--yes"], { home, clis: fakeClis() });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(cache(".claude")), "every version orphaned: the folder is gone");
    assert.ok(fs.existsSync(path.join(cache(".claude_work"), "recall", "0.5.1-dev")), "an unmarked copy is left to Claude Code");
    assert.match(r.stdout, /\n {2}· ~\/\.claude_work\/plugins\/cache\/plugin-recall: Claude Code deletes its cached copy there itself\n/);
    assert.ok(!r.stdout.includes("~/.claude/plugins/cache"), r.stdout);
  } finally {
    await server.close();
  }
});
