// The wording and small behaviours of the setup polish pass: a pasted key cleaned of its quotes and name, a shell key that was rejected, what
// leaves the machine shown at the first use of a key, an empty history, pause and resume, and uninstall when a home's CLI is missing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runOnboarding } from "../scripts/onboarding/cli.mjs";
import { cleanPaste } from "../scripts/onboarding/key-step.mjs";
import { openai } from "../scripts/lib/providers/openai.mjs";
import { fakeClis } from "./fake-cli.mjs";
import { startFakeServer } from "./helpers.mjs";
import { KEY, nodeOnlyDir, recall, sandboxHome, waitForCards } from "./sandbox.mjs";

const ONE = "npx -y @just-every/plugin-recall";
const dataOf = (home) => path.join(home, ".plugin-recall");
const configOf = (home) => JSON.parse(fs.readFileSync(path.join(dataOf(home), "config.json"), "utf8"));

test("cleanPaste strips the quotes and the variable name a key was copied with, and nothing else", () => {
  for (const [typed, want] of [
    [KEY, KEY], [`  ${KEY}  `, KEY], [`"${KEY}"`, KEY], [`'${KEY}'`, KEY], [`OPENAI_API_KEY=${KEY}`, KEY], [`OPENAI_API_KEY="${KEY}"`, KEY],
    [`export OPENAI_API_KEY='${KEY}'`, KEY], [`"OPENAI_API_KEY=${KEY}"`, KEY], [`OPENAI_API_KEY = ${KEY}`, KEY],
    ["sk-abc", "sk-abc"], ['"', '"'], ["hello there", "hello there"], [`OTHER_KEY=${KEY}`, `OTHER_KEY=${KEY}`],
  ]) assert.equal(cleanPaste(typed, openai), want, typed);
});

test("a key pasted with its quotes and name is cleaned before the shape check, checked, and saved bare", async () => {
  const server = await startFakeServer({ acceptKey: KEY });
  try {
    const home = sandboxHome();
    const r = await recall([], { home, clis: fakeClis(), stdin: `export OPENAI_API_KEY="${KEY}"\ny\n`, env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("✓ Accepted by OpenAI"), r.stdout);
    assert.equal(fs.readFileSync(path.join(home, ".env"), "utf8"), `OPENAI_API_KEY=${KEY}\n`);
    assert.deepEqual(server.gets.map((g) => g.authorization), [`Bearer ${KEY}`]);
    await waitForCards(dataOf(home));
  } finally {
    await server.close();
  }
});

/** A stream that looks like a terminal, and a sink for the output. */
function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.text = "";
  output.on("data", (c) => { output.text += c; });
  return { input, output };
}
const until = async (output, text) => { for (let i = 0; i < 500 && !output.text.includes(text); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(output.text.includes(text), `waiting for ${text}\n${output.text}`); };

test("the shell's key is the one OpenAI rejected: a terminal user pastes a good one, is told the shell key wins, and is told again in the Done block", async () => {
  const GOOD = "sk-test-sandbox-key-0002";
  const SHELL = "The OPENAI_API_KEY in this shell is the key OpenAI rejected, and it wins over ~/.env. Remove it (unset OPENAI_API_KEY and delete it from your shell profile).";
  const server = await startFakeServer({ acceptKey: GOOD });
  const home = sandboxHome();
  const clis = fakeClis();
  const { input, output } = terminal();
  const env = { HOME: home, PATH: [clis.dir, nodeOnlyDir(), "/usr/bin", "/bin"].join(":"), OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url };
  try {
    const done = runOnboarding("setup", new Map(), { env, homeDir: home, input, output });
    await until(output, "(hidden, Enter to stop): ");
    input.write(`${GOOD}\r`);
    await until(output, "Go ahead? ");
    input.write("y\n");
    assert.equal(await done, 0, output.text);
    const text = output.text.replace(/ ?\n {4,6}\(unset OPENAI_API_KEY/g, " (unset OPENAI_API_KEY");
    assert.ok(text.includes(`  ✗ OpenAI rejected this key. Check it at https://platform.openai.com/api-keys.\n`), text);
    assert.equal(text.split(SHELL).length - 1, 2, `the line is said at the key step and repeated in the Done block\n${text}`);
    assert.ok(text.indexOf(SHELL) < text.indexOf("\nPlan\n") && text.lastIndexOf(SHELL) > text.indexOf("\nDone."), text);
    assert.ok(!text.includes("HTTP") && !text.includes(KEY) && !text.includes(GOOD));
    assert.equal(fs.readFileSync(path.join(home, ".env"), "utf8"), `OPENAI_API_KEY=${GOOD}\n`);
    await waitForCards(dataOf(home));
  } finally {
    await server.close();
  }
});

test("what leaves this machine is shown the first time a key is used for sending, not the first time the installer runs", async () => {
  const server = await startFakeServer();
  try {
    const home = sandboxHome();
    const env = { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url };
    let r = await recall(["--skip-key", "--yes"], { home, clis: fakeClis(), env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("\nNothing leaves this machine until you add a key.\n\nGo ahead? [--yes] yes\n"), r.stdout);
    assert.ok(!r.stdout.includes("What leaves this machine"), "no key, nothing to send");
    r = await recall([], { home, clis: fakeClis(), stdin: "y\n", env });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("\nWhat leaves this machine\n") && !r.stdout.includes("Nothing leaves"), "the first run with a key says what is sent");
    await waitForCards(dataOf(home));
    r = await recall(["--daily-cap", "2"], { home, clis: fakeClis(), stdin: "y\n", env });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("Daily spend cap: $1 → $2") && !r.stdout.includes("What leaves this machine"), r.stdout);
  } finally {
    await server.close();
  }
});

test("a machine with no history says the index has nothing to read yet", async () => {
  const server = await startFakeServer();
  try {
    const home = sandboxHome({ claude: [], codex: [] });
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", ".claude.json"), "{}");
    const r = await recall(["--dry-run"], { home, clis: fakeClis({ codex: false }), env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("\n  Index: nothing to read yet; it grows as you use Claude Code or Codex\n"), r.stdout);
    assert.ok(!r.stdout.includes("Index what you typed"));
  } finally {
    await server.close();
  }
});

test("pause and resume set and clear \"disabled\" in config.json, keep every other setting, and say what they did", async () => {
  const home = sandboxHome();
  fs.mkdirSync(dataOf(home), { recursive: true });
  fs.writeFileSync(path.join(dataOf(home), "config.json"), `${JSON.stringify({ dailyCapUsd: 2, homes: ["~/.claude_work"] })}\n`);
  const run = (cmd, env = {}) => recall([cmd], { home, env });
  let r = await run("resume");
  assert.deepEqual([r.code, r.stdout], [0, "Recall is not paused.\n"]);
  assert.deepEqual(configOf(home), { dailyCapUsd: 2, homes: ["~/.claude_work"] }, "nothing changed");
  r = await run("pause");
  assert.deepEqual([r.code, r.stdout], [0, `Recall is paused: it does nothing, in every agent home, until you turn it back on:\n  ${ONE} resume\n`]);
  assert.deepEqual(configOf(home), { dailyCapUsd: 2, homes: ["~/.claude_work"], disabled: true });
  r = await run("pause");
  assert.deepEqual([r.code, r.stdout], [0, `Recall is already paused. To turn it back on: ${ONE} resume\n`]);
  const doctor = await recall(["doctor", "--offline"], { home, clis: fakeClis() });
  assert.ok(doctor.stdout.includes(`Recall is paused: it does nothing until you run ${ONE} resume`), doctor.stdout);
  r = await run("resume");
  assert.deepEqual([r.code, r.stdout], [0, "Recall is on again, in every agent home.\n"]);
  assert.deepEqual(configOf(home), { dailyCapUsd: 2, homes: ["~/.claude_work"] });
  // the shell's own RECALL_DISABLED wins over the file, and the command says so
  r = await run("pause", { RECALL_DISABLED: "0" });
  assert.match(r.stdout, /! RECALL_DISABLED=0 is set in this shell, and it wins over config\.json where it is set\.\n$/);
  r = await run("resume", { RECALL_DISABLED: "1" });
  assert.match(r.stdout, /! RECALL_DISABLED is set in this shell, so Recall stays off where it is set\. Unset it there\.\n$/);
});

test("pause works before setup (it makes the settings file), and an invalid config.json is named, not overwritten", async () => {
  const home = sandboxHome();
  let r = await recall(["pause"], { home });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(configOf(home), { disabled: true });
  fs.writeFileSync(path.join(dataOf(home), "config.json"), '{"disabled": "yes"}\n');
  r = await recall(["resume"], { home });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^~\/\.plugin-recall\/config\.json is invalid: .*Fix it, then\s+run this again\.\nNothing was changed\.\n$/s);
  assert.equal(fs.readFileSync(path.join(dataOf(home), "config.json"), "utf8"), '{"disabled": "yes"}\n');
});

async function installedPair(server) {
  const home = sandboxHome({ claude: [".claude"], codex: [".codex"] });
  const r = await recall(["--yes"], { home, clis: fakeClis(), env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  await waitForCards(dataOf(home));
  return home;
}
const recorded = (home) => JSON.parse(fs.readFileSync(path.join(dataOf(home), "state", "installs.json"), "utf8")).homes.map((h) => path.basename(h.home));

test("uninstall when a recorded home's CLI is missing: that home fails with how to install it, and --homes removes Recall from the others only", async () => {
  const server = await startFakeServer();
  try {
    const home = await installedPair(server);
    // only ~/.codex: Recall stays in ~/.claude, with its copy, its command and its record
    const part = fakeClis();
    let r = await recall(["uninstall", "--yes", "--homes", "~/.codex"], { home, clis: part });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("Remove Recall from 1 home? [--yes] yes\n  ✓ ~/.codex  Codex  removed\n"), r.stdout);
    assert.ok(r.stdout.endsWith(`\nRecall is removed from 1 home. It stays in ~/.claude.\n  To remove it everywhere: ${ONE} uninstall\n`), r.stdout);
    assert.deepEqual(part.log().filter((c) => c.args[0] === "plugin").map((c) => c.bin), ["codex", "codex"], "claude was not run");
    assert.deepEqual(recorded(home), [".claude"]);
    assert.ok(fs.existsSync(path.join(dataOf(home), "marketplace")) && fs.existsSync(path.join(home, ".local", "bin", "recall")));
    // claude is gone from the machine: its home cannot be uninstalled, and the line says what to do
    r = await recall(["uninstall", "--yes"], { home, clis: fakeClis({ claude: false }) });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("  ✗ ~/.claude  Claude Code  failed: claude is not installed; install it (curl -fsSL https://claude.ai/install.sh | bash) or remove the home with --homes\n"), r.stdout);
    assert.ok(r.stdout.endsWith(`Fix the cause, then run: ${ONE} uninstall\n`), r.stdout);
    assert.ok(fs.existsSync(path.join(dataOf(home), "marketplace")), "its copy is kept for the home that failed");
    // naming every home that is left is a full uninstall
    r = await recall(["uninstall", "--yes", "--homes", "~/.claude"], { home, clis: fakeClis() });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("\nRecall is uninstalled.\n") && !fs.existsSync(path.join(dataOf(home), "marketplace")) && !fs.existsSync(path.join(home, ".local")), r.stdout);
  } finally {
    await server.close();
  }
});

test("a codex home whose CLI is missing says the same, with the npm command", async () => {
  const server = await startFakeServer();
  try {
    const home = await installedPair(server);
    const r = await recall(["uninstall", "--yes"], { home, clis: fakeClis({ codex: false }) });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("  ✗ ~/.codex   Codex        failed: codex is not installed; install it (npm i -g @openai/codex) or remove the home with --homes\n"), r.stdout);
    assert.ok(r.stdout.includes("  ✓ ~/.claude  Claude Code  removed\n"), r.stdout);
  } finally {
    await server.close();
  }
});
