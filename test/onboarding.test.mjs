// `recall doctor` end to end, as a new user would meet it: a fresh temp HOME holding only synthetic transcripts, a fake OpenAI server, fake
// `claude` and `codex` CLIs. No network, no paid call, no real home. Setup itself is covered by the setup-*.test.mjs files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { estimateFirstIndex } from "../scripts/onboarding/estimate.mjs";
import { fakeClis } from "./fake-cli.mjs";
import { startFakeServer, tmpDir } from "./helpers.mjs";
import { claudeState } from "./host-sim.mjs";
import { recall, sandboxHome } from "./sandbox.mjs";

test("doctor in an empty HOME: says what is missing, exits non-zero, prints no secret", async () => {
  const home = tmpDir("recall-doctor-empty");
  const r = await recall(["doctor", "--offline"], { home, env: { OPENAI_API_KEY: "" } });
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes("  ✗ OpenAI key not found\n      Run: npx -y @just-every/plugin-recall (it asks for the key and saves it to ~/.env)\n"), r.stdout);
  assert.match(r.stdout, / {2}✗ neither the claude nor the codex CLI is on PATH\n {6}One of them writes the short summaries Recall needs; without them Recall stays silent\n/);
  assert.match(r.stdout, /✗ no agent homes found/);
  assert.match(r.stdout, /! no index yet\n(?: {6}.*\n)*/);
  assert.ok(r.stdout.split("! no index yet\n")[1].includes("      Run: npx -y @just-every/plugin-recall\n"), r.stdout);
  assert.ok(!/\[(?: ok |warn|FAIL|info)\]/.test(r.stdout), "the markers are the ones setup uses");
  assert.match(r.stdout, /Node \d+\.\d+\.\d+/);
  const json = await recall(["doctor", "--offline", "--json"], { home, env: { OPENAI_API_KEY: "" } });
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.failed, true);
  assert.deepEqual(parsed.checks.map((c) => c.id).slice(0, 3), ["plugin", "node", "openai-key"]);
});

test("doctor finds the key in ~/.env and shows it only masked; access is not confirmed until setup checks it", async () => {
  const home = sandboxHome();
  fs.writeFileSync(path.join(home, ".env"), "OPENAI_API_KEY=sk-from-dotenv-4321\n");
  const r = await recall(["doctor", "--offline"], { home, clis: fakeClis() });
  assert.match(r.stdout, /✓ OpenAI key found in ~\/\.env \(sk-\.\.\.4321\)/);
  assert.ok(r.stdout.includes("  ! Not checked yet whether the OpenAI key can pick what to bring back\n      Run: npx -y @just-every/plugin-recall (it checks with one tiny request)\n"), r.stdout);
  assert.ok(!r.stdout.includes("sk-from-dotenv"));
  assert.ok(!r.stdout.includes("Decisions API"), "the API's name is only in the access-denied text");
});

test("doctor: a rejected key is a failure, an unreachable API a warning; the free request is the only one made", async () => {
  const server = await startFakeServer({ acceptKey: "sk-right" });
  const home = sandboxHome();
  const clis = fakeClis();
  try {
    const bad = await recall(["doctor"], { home, env: { OPENAI_API_KEY: "sk-wrong", RECALL_OPENAI_BASE_URL: server.url }, clis });
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /✗ OpenAI API rejected the key \(HTTP 401\)/);
    assert.match(bad.stdout, /one free request \(GET \/v1\/models\), no tokens billed\n/);
    assert.equal(server.calls.length, 0, "no billable request");
    const gone = await recall(["doctor"], { home, env: { OPENAI_API_KEY: "sk-right", RECALL_OPENAI_BASE_URL: "http://127.0.0.1:9" }, clis });
    assert.match(gone.stdout, /! OpenAI API not reachable/);
    const offline = await recall(["doctor", "--offline"], { home, env: { OPENAI_API_KEY: "sk-right", RECALL_OPENAI_BASE_URL: server.url }, clis });
    assert.match(offline.stdout, /not checked \(--offline\); only the presence of the key was verified/);
    assert.equal(server.gets.length, 1);
  } finally {
    await server.close();
  }
});

test("doctor: logins, a home left out at setup, another copy of Recall, and a missing install", async () => {
  const home = sandboxHome({ claude: [".claude", ".claude_side"], codex: [".codex"] });
  claudeState(path.join(home, ".claude_side"), { other: "recall@someone-else" });
  const data = path.join(home, ".plugin-recall", "state");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "installs.json"), JSON.stringify({ version: 1, homes: [{ home: path.join(home, ".codex"), host: "codex", status: "left-out", recallVersion: "0.5.1", at: "2026-10-01T00:00:00.000Z" }] }));
  const r = await recall(["doctor", "--offline"], { home, env: { OPENAI_API_KEY: "sk-test-1234", RECALL_HOMES: "~/.claude_side" }, clis: fakeClis({ claudeLoggedOut: true, codexLoggedOut: true }) });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /! claude CLI 2\.1\.287, not logged in\n/);
  assert.match(r.stdout, /! codex CLI 0\.160\.1, not logged in\n/);
  assert.match(r.stdout, /✗ neither the claude nor the codex CLI is logged in\n/);
  assert.ok(r.stdout.includes("  ! Recall is not installed in Claude Code (~/.claude)\n      Run: npx -y @just-every/plugin-recall\n"), r.stdout);
  assert.match(r.stdout, / {2}· Recall left out of Codex \(~\/\.codex\) at setup\n/);
  assert.match(r.stdout, / {2}· ~\/\.claude_side has recall@someone-else \(another copy of Recall\)\n/);
  const ok = await recall(["doctor", "--offline"], { home, env: { OPENAI_API_KEY: "sk-test-1234" }, clis: fakeClis({ claudeAuthUnknown: true }) });
  assert.match(ok.stdout, /✓ claude CLI 2\.1\.287\n/);
  assert.match(ok.stdout, /✓ codex CLI 0\.160\.1, logged in\n/);
  assert.match(ok.stdout, /spent today \$0 of the \$1 daily cap/);
});

test("doctor: reports an invalid config.json by name instead of crashing", async () => {
  const home = sandboxHome();
  fs.mkdirSync(path.join(home, ".plugin-recall"));
  fs.writeFileSync(path.join(home, ".plugin-recall", "config.json"), '{"dailyCapUSD": 5}');
  const r = await recall(["doctor", "--offline"], { home, env: { OPENAI_API_KEY: "sk-test" }, clis: fakeClis() });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ config is invalid/);
  assert.match(r.stdout, /unknown key "dailyCapUSD"/);
});

test("setup: an invalid config.json stops it before anything else, naming the file", async () => {
  const home = sandboxHome();
  fs.mkdirSync(path.join(home, ".plugin-recall"));
  fs.writeFileSync(path.join(home, ".plugin-recall", "config.json"), '{"dailyCapUSD": 5}');
  const r = await recall(["--yes"], { home, env: { OPENAI_API_KEY: "sk-test" }, clis: fakeClis() });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^Recall 0\.5\.1 · memory for Claude Code and Codex\n\n~\/\.plugin-recall\/config\.json is invalid: unknown key "dailyCapUSD" /);
  assert.match(r.stdout, /\. Fix it, then run this again\.\nNothing was changed\.\n$/);
});

test("the cost estimate is the price list applied to the scan: embeddings at $0.02 per million tokens, about four characters a token", () => {
  const e = estimateFirstIndex({ statements: 12000, toEmbed: { texts: 11000, chars: 2_800_000 } });
  assert.equal(e.tokens, 700_000);
  assert.ok(Math.abs(e.embeddingUsd - 0.014) < 1e-9);
  assert.equal(e.cardCalls, 300);
  assert.equal(e.promptUsd, 0.004);
  assert.equal(e.promptsPerDollar, 250);
});

test("the CLI refuses an unknown option or a stray argument to doctor and setup (a usage error, exit 2)", async () => {
  const home = tmpDir("recall-onboard-args");
  for (const args of [["doctor", "--frobnicate"], ["setup", "extra"], ["setup", "--daily-cap"]]) {
    const r = await recall(args, { home });
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.stderr, /recall (doctor|setup): /);
  }
});
