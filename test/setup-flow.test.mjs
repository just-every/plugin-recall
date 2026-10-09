// `npx -y @just-every/plugin-recall` (recall setup) end to end in a sandbox HOME: which tools are found and logged in, which homes are
// installed into, and what is written. Fake claude/codex CLIs on a PATH without the real ones, the fake OpenAI server, no real home.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakeClis } from "./fake-cli.mjs";
import { startFakeServer } from "./helpers.mjs";
import { KEY, readJsonl, recall, sandboxHome, waitForCards } from "./sandbox.mjs";

const V = "0.5.1";
const plugin = (clis) => clis.log().filter((c) => c.args[0] === "plugin");
const clean = (r) => {
  assert.ok(!/\x1b\[/.test(r.stdout + r.stderr), "no ANSI escape off a terminal");
  assert.ok(!(r.stdout + r.stderr).includes(KEY), "the key is never printed");
};

test("both tools, two homes each, --yes: every home installed, the key saved, the index built, cards written in the background", async () => {
  const server = await startFakeServer();
  const home = sandboxHome({ claude: [".claude", ".claude_work"], codex: [".codex", ".codex_work"], everyCode: true });
  const clis = fakeClis();
  try {
    const r = await recall(["--yes"], { home, clis, env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    clean(r);
    const out = r.stdout;
    assert.ok(out.startsWith(`Recall ${V} · memory for Claude Code and Codex\n\nLooking at this machine\n  ✓ Node `), out);
    assert.match(out, /\n {2}✓ Claude Code 2\.1\.287 · logged in\n {2}✓ Codex 0\.160\.1 · logged in\n {2}· Every Code: ~\/\.code is read for memory; it has no plugin system, so nothing is installed there\n/);
    assert.match(out, /Agent homes \(5\)\n {2}1 {2}~\/\.claude {7}Claude Code {2}1 session {3}new\n {2}2 {2}~\/\.claude_work {2}Claude Code {2}1 session {3}new\n {2}3 {2}~\/\.codex {8}Codex {8}1 session {3}new\n {2}4 {2}~\/\.codex_work {3}Codex {8}1 session {3}new\n {2}· {2}~\/\.code {9}Every Code {3}0 sessions {2}read for memory only\n\n/);
    assert.match(out, /OpenAI key \(Recall uses it to find what you said before\)\n {2}Found a key in the environment \(sk-\.\.\.0001\)\.\n {2}✓ Accepted by OpenAI \(free check, no tokens billed\)\.\n\nPlan\n/);
    assert.equal((out.match(/\[--yes\] yes/g) ?? []).length, 1, "the go-ahead is the only question");
    for (const line of [
      "Plan", `  Install Recall ${V} in 4 homes`, "  Use your OpenAI key from the environment (sk-...0001)", "  Save your OpenAI key to ~/.env",
      "  Check once that your key can pick what to bring back: one tiny request, less than $0.0001",
      "  Each prompt after that: about $0.004 (about 250 prompts per dollar)", "  Daily spend cap: $1 (change it with --daily-cap)",
      "  Add the recall command: ~/.local/bin/recall", "What leaves this machine", "Go ahead? [--yes] yes",
      "  ✓ Your key can pick what to bring back (less than $0.0001)", "  ✓ Saved your OpenAI key to ~/.env", "  ✓ Settings: ~/.plugin-recall/config.json (daily cap $1)",
      "  ✓ Writing short summaries in the background with your claude CLI", "  ✓ ~/.claude       Claude Code  installed",
      "  ✓ ~/.codex_work   Codex        installed · approve Recall once in its Hooks page", "  ✓ recall command: ~/.local/bin/recall",
      `Done. Recall ${V} is on in 4 homes.`, "  Summaries: being written in the background (6 statements).", "    CODEX_HOME=~/.codex_work codex  (~/.codex_work)",
      '    Choose "Trust all and continue" on the "Hooks need review" screen, or run /hooks.',
      "  To your claude CLI: your statements, about 40 at a time, to summarise them (with its own login).",
      "  Claude Code: sessions already open load Recall after a restart or /reload-plugins.", "  Watch it work:  ~/.local/bin/recall monitor",
      "  Check it:       ~/.local/bin/recall doctor   (it also shows how far the summaries are)",
      "  Pause it:       npx -y @just-every/plugin-recall pause", "  Resume it:      npx -y @just-every/plugin-recall resume",
      "  Remove it:      npx -y @just-every/plugin-recall uninstall", "  To type just recall, add ~/.local/bin to your PATH (then open a new terminal):",
      `    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile`,
    ]) assert.ok(out.includes(`${line}\n`), `missing: ${line}\n${out}`);
    assert.match(out, /\n {2}Index what you typed in 5 homes: 6 statements, less than \$0\.0001\n {2}Write short summaries with your claude CLI, in the background: about 1 call, no API charge\n/);
    assert.equal((out.match(/doctor/g) ?? []).length, 1, "one doctor line in the summary");
    assert.ok(!/Decisions API|embed|[Cc]ards?\b|the hook/.test(out.split("Go ahead?")[0]), "the plan names no mechanism");
    assert.match(out, /\n {2}✓ Indexed \d+ statements \(less than \$0\.0001\)\n/);
    for (const l of out.split("\n")) assert.ok(l.length <= 100, `longer than 100: ${l}`);

    const data = path.join(home, ".plugin-recall");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf8")), { dailyCapUsd: 1, homes: ["~/.claude_work", "~/.codex_work"] });
    assert.equal(fs.readFileSync(path.join(home, ".env"), "utf8"), `OPENAI_API_KEY=${KEY}\n`);
    assert.equal(fs.statSync(path.join(home, ".env")).mode & 0o777, 0o600);
    const installs = JSON.parse(fs.readFileSync(path.join(data, "state", "installs.json"), "utf8"));
    assert.deepEqual(installs.homes.map((h) => [path.basename(h.home), h.host, h.status, h.recallVersion]), [
      [".claude", "claude", "installed", V], [".claude_work", "claude", "installed", V], [".codex", "codex", "installed", V], [".codex_work", "codex", "installed", V],
    ]);
    const checks = fs.readFileSync(path.join(data, "state", "provider-checks.json"), "utf8");
    assert.ok(!checks.includes(KEY) && /"keyFingerprint": "[0-9a-f]{16}"/.test(checks) && /"accessConfirmedAt"/.test(checks));
    const link = path.join(home, ".local", "bin", "recall");
    assert.equal(fs.readlinkSync(link), path.join(data, "marketplace", "plugins", `recall-${V}`, "bin", "recall"));

    // the hosts' own commands, each home under its own variable, no key passed on
    const M = path.join(data, "marketplace");
    const byHome = (c) => (c.bin === "claude" ? c.claudeConfigDir ?? "~/.claude" : c.codexHome);
    assert.deepEqual(plugin(clis).map((c) => `${c.bin} ${c.args.join(" ")} @ ${path.basename(byHome(c))}`).sort(), [
      `claude plugin marketplace add ${M} --json @ .claude`, `claude plugin marketplace add ${M} --json @ .claude_work`,
      "claude plugin install recall@plugin-recall --json @ .claude", "claude plugin install recall@plugin-recall --json @ .claude_work",
      `codex plugin marketplace add ${M} --json @ .codex`, `codex plugin marketplace add ${M} --json @ .codex_work`,
      "codex plugin add recall@plugin-recall --json @ .codex", "codex plugin add recall@plugin-recall --json @ .codex_work",
    ].sort());
    assert.ok(plugin(clis).every((c) => c.keys.length === 0), "no *_API_KEY reaches a host command");
    assert.ok(clis.log().every((c) => !c.args.includes("--dangerously-bypass-hook-trust")));
    assert.ok(!fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8").includes("trusted_hash"), "trust is never written");

    // the paid requests: one access check and the embeddings; then the background card writer through claude -p
    assert.deepEqual([...new Set(server.calls.map((c) => c.pathname))], ["/v1/decisions", "/v1/embeddings"]);
    assert.equal(server.calls.filter((c) => c.pathname === "/v1/decisions").length, 1);
    await waitForCards(data);
    const statements = readJsonl(path.join(data, "statements.jsonl"));
    assert.equal(readJsonl(path.join(data, "cards.jsonl")).length, statements.length);
    const writer = clis.log().filter((c) => c.args.includes("-p"));
    assert.ok(writer.length >= 1 && writer.every((c) => c.recallChild === "1"), JSON.stringify(writer));
    assert.ok(writer.every((c) => !c.keys.includes("OPENAI_API_KEY")), "the card writer gets only its CLI's login, not Recall's key");

    // doctor sees every home
    const doctor = await recall(["doctor"], { home, clis, env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(doctor.code, 0, doctor.stdout);
    for (const re of [/ {2}✓ OpenAI key found in ~\/\.env \(sk-\.\.\.0001\)/, / {2}✓ OpenAI key can pick what to bring back \(checked \d{4}-\d\d-\d\d\)/, / {2}✓ claude CLI 2\.1\.287, logged in/,
      / {2}✓ codex CLI 0\.160\.1, logged in/, / {2}✓ Recall installed in Claude Code \(~\/\.claude_work\)/,
      / {2}! Recall installed in Codex \(~\/\.codex\); its hook is not approved yet/, /spent today less than \$0\.0001 of the \$1 daily cap/]) assert.match(doctor.stdout, re);
    assert.ok(!/Decisions API|embedding|plugin recall@/.test(doctor.stdout), "doctor names no mechanism");
    assert.ok(!doctor.stdout.includes(KEY));
    assert.ok(!doctor.stdout.includes(home), "doctor shows paths with ~, as setup does");
    assert.match(doctor.stdout, /\n {6}~\/\.claude_work {2}\(claude, 1 transcript file\)\n/);
  } finally {
    await server.close();
  }
});

test("only Claude Code: Codex is 'not found', only Claude homes are listed, claude writes the cards", async () => {
  const server = await startFakeServer();
  const home = sandboxHome();
  const clis = fakeClis({ codex: false });
  try {
    const r = await recall(["-y"], { home, clis, env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ Claude Code 2\.1\.287 · logged in\n {2}· Codex: not found\n/);
    assert.match(r.stdout, /Agent homes \(2\)\n {2}1 {2}~\/\.claude {2}Claude Code {2}1 session {2}new\n {2}· {2}~\/\.codex {3}Codex {8}1 session {2}read for memory only\n\n/);
    assert.match(r.stdout, /\n {2}Index what you typed in 2 homes: /);
    assert.ok(!r.stdout.includes("Codex: approve"));
    assert.deepEqual([...new Set(plugin(clis).map((c) => c.bin))], ["claude"]);
    await waitForCards(path.join(home, ".plugin-recall"));
  } finally {
    await server.close();
  }
});

test("only Codex: Claude Code is 'not found', a missing ~/.codex is made, and codex exec writes the cards", async () => {
  const server = await startFakeServer();
  const home = sandboxHome({ codex: [] });
  const clis = fakeClis({ claude: false });
  try {
    const r = await recall(["--yes"], { home, clis, env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /· Claude Code: not found\n {2}✓ Codex 0\.160\.1 · logged in\n/);
    assert.match(r.stdout, /Agent homes \(2\)\n {2}1 {2}~\/\.codex {3}Codex {8}0 sessions {2}new\n {2}· {2}~\/\.claude {2}Claude Code {2}1 session {3}read for memory only\n\n/);
    assert.match(r.stdout, /\n {2}Index what you typed in 1 home: 3 statements, /, "the one home read now is ~/.claude (~/.codex is made at install)");
    assert.match(r.stdout, /Writing short summaries in the background with your codex CLI/);
    assert.match(r.stdout, /\n {2}To your codex CLI: your statements, about 40 at a time, to summarise them \(with its own login\)\.\n/);
    assert.equal(fs.statSync(path.join(home, ".codex")).mode & 0o777, 0o700);
    await waitForCards(path.join(home, ".plugin-recall"));
    assert.ok(clis.log().some((c) => c.bin === "codex" && c.args[0] === "exec"));
    assert.ok(!r.stdout.includes("Claude Code: sessions already open"));
  } finally {
    await server.close();
  }
});

test("no tool, or every tool logged out: stop before the key step, nothing written, nothing sent", async () => {
  const server = await startFakeServer();
  try {
    const home = sandboxHome();
    const none = await recall([], { home, env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(none.code, 1);
    assert.ok(none.stdout.endsWith("· Claude Code: not found\n  · Codex: not found\n\nRecall runs inside Claude Code or Codex, and one of them writes Recall's short summaries.\n"
      + "Install one, then run this again:\n  Claude Code:  curl -fsSL https://claude.ai/install.sh | bash\n  or, with npm: npm install -g @anthropic-ai/claude-code\n"
      + "  Codex:        npm install -g @openai/codex\nNothing was changed.\n"), none.stdout);
    const out = fakeClis({ claudeLoggedOut: true, codexLoggedOut: true });
    const both = await recall([], { home, clis: out, env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(both.code, 1);
    assert.ok(both.stdout.endsWith("! Claude Code 2.1.287 · not logged in\n  ! Codex 0.160.1 · not logged in\n\nRecall needs Claude Code or Codex logged in: one of them writes Recall's short summaries.\n"
      + "Log in (run claude and type /login, or run codex login), then run this again.\nNothing was changed.\n"), both.stdout);
    for (const l of (none.stdout + both.stdout).split("\n")) assert.ok(l.length <= 100 && !l.startsWith("    "), `a stop line that wraps: ${l}`);
    assert.deepEqual(fs.readdirSync(home).sort(), [".claude", ".codex"]);
    assert.equal(server.gets.length + server.calls.length, 0);
    assert.deepEqual(out.log().map((c) => `${c.bin} ${c.args.join(" ")}`).sort(), ["claude --version", "claude auth status --json", "codex --version", "codex login status"].sort(), "only the read-only probes ran");
  } finally {
    await server.close();
  }
});

test("Claude Code logged out, Codex logged in: setup goes on and codex writes the cards", async () => {
  const server = await startFakeServer();
  const home = sandboxHome();
  const clis = fakeClis({ claudeLoggedOut: true });
  try {
    const r = await recall(["--yes"], { home, clis, env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /! Claude Code 2\.1\.287 · not logged in\n {2}✓ Codex 0\.160\.1 · logged in\n/);
    assert.match(r.stdout, /Write short summaries with your codex CLI, in the background/);
    await waitForCards(path.join(home, ".plugin-recall"));
    const enrich = fs.readFileSync(path.join(home, ".plugin-recall", "logs", "setup-enrich.log"), "utf8");
    assert.match(enrich, /card writer: codex worker/);
    assert.ok(!clis.log().some((c) => c.args.includes("-p")), "claude -p never ran");
    const unknown = fakeClis({ claudeAuthUnknown: true, codex: false });
    const r2 = await recall(["--dry-run"], { home: sandboxHome({ codex: [] }), clis: unknown, env: { OPENAI_API_KEY: KEY } });
    assert.match(r2.stdout, /\n {2}✓ Claude Code 2\.1\.287\n/, "a CLI that cannot say counts as usable");
  } finally {
    await server.close();
  }
});

test("a home whose host command fails is listed as failed; every other home is installed, and the run exits 1", async () => {
  const server = await startFakeServer();
  const home = sandboxHome({ claude: [".claude", ".claude_work"], codex: [".codex"] });
  const clis = fakeClis({ fail: { "codex plugin add recall@plugin-recall": "config.toml is locked" } });
  try {
    const r = await recall(["--yes"], { home, clis, env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    clean(r);
    assert.match(r.stdout, /\n {2}✓ ~\/\.claude {7}Claude Code {2}installed\n {2}✓ ~\/\.claude_work {2}Claude Code {2}installed\n {2}✗ ~\/\.codex {8}Codex {8}failed: config\.toml is locked\n/);
    assert.ok(r.stdout.includes("\nFinished with problems: Recall could not be installed in 1 home (listed above).\n  To retry it: npx -y @just-every/plugin-recall --homes ~/.codex\n"), r.stdout);
    for (const l of r.stdout.split("\n")) assert.ok(l.length <= 100, `longer than 100: ${l}`);
    const installs = JSON.parse(fs.readFileSync(path.join(home, ".plugin-recall", "state", "installs.json"), "utf8")).homes.map((h) => path.basename(h.home)).sort();
    assert.deepEqual(installs, [".claude", ".claude_work"], "only the homes that worked are recorded");
    await waitForCards(path.join(home, ".plugin-recall"));
  } finally {
    await server.close();
  }
});
