// Setup run again and its lighter modes, in a sandbox HOME: a re-run with everything current asks nothing and writes nothing, a newer
// release updates in place, --dry-run changes nothing, --no-index and --skip-key, a new --daily-cap on a re-run, and the hook of the installed
// copy injecting with the key read from ~/.env.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakeClis } from "./fake-cli.mjs";
import { readFixture, startFakeServer } from "./helpers.mjs";
import { addClaudeHome, KEY, packageAtVersion, recall, sandboxHome, snapshot, STATEMENTS, waitForCards } from "./sandbox.mjs";

const V = "0.5.1";
const plugins = (clis) => clis.log().filter((c) => c.args[0] === "plugin").map((c) => `${c.bin} ${c.args.join(" ")}`);
const probesOnly = (clis) => assert.ok(clis.log().every((c) => ["--version", "auth", "login"].includes(c.args[0])), JSON.stringify(clis.log().map((c) => c.args)));

async function installed(server, { stdin = `${KEY}\ny\n` } = {}) {
  const home = sandboxHome({ claude: [".claude", ".claude_work"], codex: [".codex", ".codex_work"] });
  const r = await recall([], { home, clis: fakeClis(), stdin, env: { RECALL_OPENAI_BASE_URL: server.url } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  await waitForCards(path.join(home, ".plugin-recall"));
  return home;
}

test("a re-run with everything current: no question, one free request, no host command, no file written", async () => {
  const server = await startFakeServer();
  try {
    const home = await installed(server);
    const before = snapshot(home);
    const [gets, posts] = [server.gets.length, server.calls.length];
    const clis = fakeClis();
    const r = await recall([], { home, clis, stdin: "", env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(`\n\nEverything is up to date: Recall ${V} in 4 homes.\n  Codex: approve Recall once in each Codex home's Hooks page; Codex asks on its next start:\n    codex                           (~/.codex)\n    CODEX_HOME=~/.codex_work codex  (~/.codex_work)\n`), r.stdout);
    assert.ok(!r.stdout.includes("?"), "nothing was asked");
    assert.match(r.stdout, /~\/\.claude_work {2}Claude Code {2}1 session {2}up to date\n/);
    assert.deepEqual([server.gets.length - gets, server.calls.length - posts], [1, 0]);
    probesOnly(clis);
    assert.deepEqual(snapshot(home), before);
  } finally {
    await server.close();
  }
});

test("a newer release run over an install updates every home in place and keeps the previous copy", async () => {
  const server = await startFakeServer();
  try {
    const home = await installed(server);
    const newer = packageAtVersion("0.5.2");
    const clis = fakeClis();
    const r = await recall(["--yes"], { home, clis, env: { RECALL_OPENAI_BASE_URL: server.url }, script: path.join(newer, "scripts", "recall.mjs") });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /~\/\.claude {7}Claude Code {2}1 session {2}update 0\.5\.1 → 0\.5\.2\n/);
    assert.match(r.stdout, /\nPlan\n {2}Update Recall to 0\.5\.2 in 4 homes\n {2}Use your OpenAI key from ~\/\.env \(sk-\.\.\.0001\)\n {2}Index: 6 statements, kept up to date as you work\n/);
    assert.ok(!r.stdout.includes("Install Recall"), "every home is an update");
    assert.match(r.stdout, /Update the recall command: ~\/\.local\/bin\/recall\n/);
    assert.match(r.stdout, /✓ ~\/\.codex_work {3}Codex {8}updated 0\.5\.1 → 0\.5\.2 · approve Recall once in its Hooks page\n/);
    const M = path.join(home, ".plugin-recall", "marketplace");
    const claudeHome = (c) => c.claudeConfigDir ?? "default";
    for (const h of ["default", path.join(home, ".claude_work")]) {
      assert.deepEqual(clis.log().filter((c) => c.bin === "claude" && c.args[0] === "plugin" && claudeHome(c) === h).map((c) => c.args.join(" ")),
        ["plugin marketplace update plugin-recall --json", "plugin update recall@plugin-recall --json"], h);
    }
    assert.deepEqual(plugins(clis).filter((l) => l.startsWith("codex")), ["codex plugin add recall@plugin-recall --json", "codex plugin add recall@plugin-recall --json"]);
    assert.deepEqual(fs.readdirSync(path.join(M, "plugins")).sort(), ["recall-0.5.1", "recall-0.5.2"]);
    assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "recall")), path.join(M, "plugins", "recall-0.5.2", "bin", "recall"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(M, ".claude-plugin", "marketplace.json"), "utf8")).plugins[0].source, "./plugins/recall-0.5.2");
    assert.equal(server.calls.filter((c) => c.pathname === "/v1/decisions").length, 1, "access was proven once, at the first install");
  } finally {
    await server.close();
  }
});

test("a re-run whose only work is Recall's own copy says so in the plan: restored when its files are gone, copied again when they differ", async () => {
  const server = await startFakeServer();
  try {
    const home = await installed(server);
    const M = path.join(home, ".plugin-recall", "marketplace");
    fs.rmSync(path.join(M, ".claude-plugin", "marketplace.json"));
    let r = await recall(["--yes"], { home, clis: fakeClis(), env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\nPlan\n {2}Restore Recall 0\.5\.1's copy in ~\/\.plugin-recall\/marketplace, which the homes load it from\n/);
    assert.ok(fs.existsSync(path.join(M, ".claude-plugin", "marketplace.json")));
    fs.appendFileSync(path.join(M, "plugins", `recall-${V}`, "README.md"), "\nchanged\n");
    r = await recall(["--yes"], { home, clis: fakeClis(), env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\nPlan\n {2}Copy Recall 0\.5\.1 again into ~\/\.plugin-recall\/marketplace: the copy there has other files\n/);
    assert.match(r.stdout, /\n {2}! Recall 0\.5\.1 was copied again with different files;/);
    r = await recall([], { home, clis: fakeClis(), env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.match(r.stdout, /\n\nEverything is up to date: Recall 0\.5\.1 in 4 homes\.\n/);
  } finally {
    await server.close();
  }
});

test("--dry-run: the plan and nothing else; no request, no host command, no file", async () => {
  const home = sandboxHome();
  fs.writeFileSync(path.join(home, ".env"), `OPENAI_API_KEY=${KEY}\n`, { mode: 0o600 });
  const before = snapshot(home);
  const clis = fakeClis();
  const r = await recall(["--dry-run"], { home, clis, env: { RECALL_OPENAI_BASE_URL: "http://127.0.0.1:1" } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\n {2}Found a key in ~\/\.env \(sk-\.\.\.0001\)\.\n {2}· Not checked \(--dry-run\)\.\n/);
  assert.match(r.stdout, /\nPlan\n {2}Install Recall 0\.5\.1 in 2 homes: ~\/\.claude, ~\/\.codex\n/);
  assert.match(r.stdout, /What leaves this machine/);
  assert.ok(r.stdout.endsWith("\nDry run: nothing was changed.\n"), r.stdout);
  assert.ok(!r.stdout.includes("Go ahead?"));
  probesOnly(clis);
  assert.deepEqual(snapshot(home), before);
});

test("a newer release with a new home next to installed ones: one line installs, one updates", async () => {
  const server = await startFakeServer();
  try {
    const home = await installed(server);
    addClaudeHome(home, ".claude_new");
    const r = await recall(["--dry-run"], { home, clis: fakeClis(), env: { RECALL_OPENAI_BASE_URL: server.url }, script: path.join(packageAtVersion("0.5.2"), "scripts", "recall.mjs") });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\nPlan\n {2}Install Recall 0\.5\.2 in 1 home: ~\/\.claude_new\n {2}Update Recall to 0\.5\.2 in 4 homes\n/);
  } finally {
    await server.close();
  }
});

test("after --skip-key, a run with the key only in the environment saves it to ~/.env (hooks of desktop apps never see the shell's)", async () => {
  const server = await startFakeServer();
  try {
    const home = sandboxHome();
    let r = await recall(["--yes", "--skip-key"], { home, clis: fakeClis(), env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(home, ".plugin-recall", "state", "installs.json")), "not a first run any more");
    r = await recall([], { home, clis: fakeClis(), stdin: "y\n", env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\nPlan\n {2}Use your OpenAI key from the environment \(sk-\.\.\.0001\)\n {2}Save your OpenAI key to ~\/\.env\n/);
    assert.ok(!r.stdout.includes("Not in ~/.env"), r.stdout);
    assert.equal(fs.readFileSync(path.join(home, ".env"), "utf8"), `OPENAI_API_KEY=${KEY}\n`);
    assert.equal(fs.statSync(path.join(home, ".env")).mode & 0o777, 0o600);
    await waitForCards(path.join(home, ".plugin-recall"));
  } finally {
    await server.close();
  }
});

test("--no-index installs without indexing; --skip-key installs without a key, a check or a request", async () => {
  const server = await startFakeServer();
  try {
    let home = sandboxHome();
    let r = await recall(["--yes", "--no-index"], { home, clis: fakeClis(), env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}Index: not now \(--no-index\); Recall builds it in the background after your next prompt\n/);
    assert.match(r.stdout, /\n {2}Index: built in the background after your next prompt\.\n/);
    assert.ok(!server.calls.some((c) => c.pathname === "/v1/embeddings") && !fs.existsSync(path.join(home, ".plugin-recall", "statements.jsonl")));
    assert.ok(!fs.existsSync(path.join(home, ".plugin-recall", "logs", "setup-enrich.log")), "no card writer started");

    home = sandboxHome();
    const [gets, posts] = [server.gets.length, server.calls.length];
    const clis = fakeClis();
    r = await recall(["--yes", "--skip-key"], { home, clis, env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OpenAI key \(Recall uses it to find what you said before\)\n {2}· Skipped \(--skip-key\)\. Recall stays silent until it has a key\.\n/);
    assert.ok(!r.stdout.includes("Each prompt after that") && !r.stdout.includes("Check once"));
    assert.ok(r.stdout.includes("\nNothing leaves this machine until you add a key.\n\nGo ahead?") && !r.stdout.includes("What leaves this machine"), r.stdout);
    assert.ok(r.stdout.includes("\n  Index: not now (--skip-key); run npx -y @just-every/plugin-recall with a key to build it\n"), r.stdout);
    assert.ok(!r.stdout.includes("(--no-index)"), "the plan names the flag that was given");
    assert.ok(r.stdout.includes("\n  Recall stays silent until it has a key: run npx -y @just-every/plugin-recall when you have one.\n"), r.stdout);
    assert.deepEqual([server.gets.length - gets, server.calls.length - posts], [0, 0]);
    assert.equal(plugins(clis).length, 4, "both homes installed");
    assert.ok(!fs.existsSync(path.join(home, ".env")) && !fs.existsSync(path.join(home, ".plugin-recall", "state", "provider-checks.json")));
  } finally {
    await server.close();
  }
});

test("--daily-cap on a re-run changes the cap (and only that)", async () => {
  const server = await startFakeServer();
  try {
    const home = await installed(server);
    const clis = fakeClis();
    const r = await recall(["--daily-cap", "2.5"], { home, clis, stdin: "y\n", env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\nPlan\n {2}Use your OpenAI key from ~\/\.env \(sk-\.\.\.0001\)\n {2}Index: 6 statements, kept up to date as you work\n {2}Each prompt after that: about \$0\.004 \(about 250 prompts per dollar\)\n {2}Daily spend cap: \$1 → \$2\.5\n\nGo ahead\?/);
    assert.match(r.stdout, /✓ Settings: ~\/\.plugin-recall\/config\.json \(daily cap \$2\.5\)/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".plugin-recall", "config.json"), "utf8")).dailyCapUsd, 2.5);
    probesOnly(clis);
  } finally {
    await server.close();
  }
});

test("the installed copy's hook injects an earlier statement, reading the key from ~/.env (no key in its environment)", async () => {
  const server = await startFakeServer();
  try {
    const home = await installed(server);
    const copy = path.join(home, ".plugin-recall", "marketplace", "plugins", `recall-${V}`);
    const payload = { ...JSON.parse(readFixture("hook-inputs", "claude-prompt.json")), cwd: path.join(home, "work", "demo"), transcript_path: path.join(home, ".claude", "projects", "-x", "new-session.jsonl"), session_id: "live-session-1", prompt: "The import keeps failing, so I will add a fallback path and hide the failure." };
    const hook = await recall([], { home, script: path.join(copy, "scripts", "user-prompt-submit.mjs"), stdin: JSON.stringify(payload), env: { RECALL_OPENAI_BASE_URL: server.url, CLAUDE_PLUGIN_ROOT: copy, CLAUDE_CODE_SESSION_ATTENDED: "1", RECALL_AUTO_INDEX: "0" } });
    assert.equal(hook.code, 0, hook.stderr);
    const context = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
    assert.ok(context.startsWith("<recall-context>\n") && context.includes(`"${STATEMENTS[1]}"`), context);
    assert.match(context, new RegExp(`context: node ${copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/scripts/recall\\.mjs show claude-[0-9a-f]{16}`));
  } finally {
    await server.close();
  }
});
