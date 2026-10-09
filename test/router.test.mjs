// Home routing for CLI workers. Default: the current host's own home, no usage command. Optional: a roster (config homesRoster) and/or a
// usage command (config usageCmd), tested against a synthetic roster and synthetic `usage --json` output (test/fixtures). No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { loadConfig } from "../scripts/lib/config.mjs";
import { claudeArgs, codexArgs, runCliWorker, workerEnv, WorkerSkipped } from "../scripts/lib/cli-worker.mjs";
import { createRouter, judgeUsageRow, onPath, readUsage, usageCommand } from "../scripts/lib/router.mjs";
import { eligibleForWork, loadRoster, RosterError } from "../scripts/lib/roster.mjs";
import { FIXTURES, readFixture, tmpDir } from "./helpers.mjs";

const HOME = "/home/sam";
const rosterFile = path.join(FIXTURES, "roster.sample.json");
const usage = () => JSON.parse(readFixture("usage-json.sample.json"));
const cfg = (extra = {}) => loadConfig({ RECALL_DATA: tmpDir("recall-router"), RECALL_HOMES_ROSTER: rosterFile, ...extra });
const router = (config, json = usage()) => createRouter({ config, homeDir: HOME, run: async () => json });
const withCli = { hasCli: () => true };

// ---- the default: the current host's own home, nothing to configure ----
function realHome(...dirs) {
  const root = tmpDir("recall-router-home");
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

test("default routing: Claude work runs under $CLAUDE_CONFIG_DIR, else ~/.claude; Codex work under $CODEX_HOME, else ~/.codex; no usage command is run", async () => {
  const root = realHome(".claude", ".codex", ".claude_work", ".codex_work");
  const config = loadConfig({ RECALL_DATA: tmpDir("recall-router") });
  const never = async () => { throw new Error("the default path must not run a usage command"); };
  const plain = createRouter({ config, homeDir: root, env: {}, run: never, ...withCli });
  assert.deepEqual(await plain.pick("claude"), { home: path.join(root, ".claude"), id: path.join(root, ".claude"), explicit: false, considered: [] });
  assert.equal((await plain.pick("codex")).home, path.join(root, ".codex"));
  const hosted = createRouter({ config, homeDir: root, env: { CLAUDE_CONFIG_DIR: path.join(root, ".claude_work"), CODEX_HOME: path.join(root, ".codex_work") }, run: never, ...withCli });
  assert.equal((await hosted.pick("claude")).home, path.join(root, ".claude_work"));
  assert.equal((await hosted.pick("codex")).home, path.join(root, ".codex_work"));
});

test("default routing: a host home that does not exist is no worker, with the reason; a pinned home is used when it exists", async () => {
  const root = realHome(".codex", ".claude_pin");
  const config = loadConfig({ RECALL_DATA: tmpDir("recall-router") });
  const r = createRouter({ config, homeDir: root, env: {}, ...withCli });
  const none = await r.pick("claude");
  assert.equal(none.home, null);
  assert.match(none.reason, /the claude home .*\.claude does not exist/);
  const pinned = createRouter({ config: loadConfig({ RECALL_DATA: tmpDir("recall-router"), RECALL_CLAUDE_HOME: "~/.claude_pin" }), homeDir: root, env: {}, ...withCli });
  assert.deepEqual([(await pinned.pick("claude")).home, (await pinned.pick("claude")).explicit], [path.join(root, ".claude_pin"), true]);
  const missingPin = createRouter({ config: loadConfig({ RECALL_DATA: tmpDir("recall-router"), RECALL_CODEX_HOME: "~/.codex_gone" }), homeDir: root, env: {}, ...withCli });
  assert.match((await missingPin.pick("codex")).reason, /pinned codex home .* does not exist/);
});

test("default routing: a kind whose CLI is not on PATH is no candidate (so a Codex-only user is not sent to claude), and PATH is what decides", async () => {
  const root = realHome(".claude", ".codex");
  const bin = tmpDir("recall-router-bin");
  fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "claude"), "not executable", { mode: 0o644 });
  const r = createRouter({ config: loadConfig({ RECALL_DATA: tmpDir("recall-router") }), homeDir: root, env: { PATH: bin } });
  const none = await r.pick("claude");
  assert.deepEqual([none.home, none.reason], [null, "the claude CLI is not on PATH"]);
  assert.equal((await r.pick("codex")).home, path.join(root, ".codex"));
  assert.equal(onPath("codex", { PATH: `/nonexistent${path.delimiter}${bin}` }), true);
  assert.equal(onPath("codex", {}), false);
});

test("usageCmd without a roster: the candidates are the discovered homes of the kind, the one with the most headroom wins, a walled one is dropped", async () => {
  const root = realHome(".claude", ".claude_work", ".claude_side", ".codex");
  const config = loadConfig({ RECALL_DATA: tmpDir("recall-router"), RECALL_USAGE_CMD: "my-usage --x", RECALL_HOMES: path.join(root, ".claude_work") + path.delimiter + path.join(root, ".claude_side") });
  const rows = [
    { path: path.join(root, ".claude"), windows: [{ label: "1w", usedPercent: 60, elapsedPercent: 50 }] },
    { path: path.join(root, ".claude_work"), windows: [{ label: "1w", usedPercent: 20, elapsedPercent: 50 }] },
    { path: path.join(root, ".claude_side"), windows: [{ label: "1w", usedPercent: 95, elapsedPercent: 50 }] },
  ];
  const r = createRouter({ config, homeDir: root, env: {}, run: async () => ({ results: rows }), ...withCli });
  const pick = await r.pick("claude");
  assert.equal(pick.home, path.join(root, ".claude_work"));
  assert.equal(pick.explicit, true, "a usage-chosen home is passed to the worker explicitly");
  assert.equal(pick.considered.find((c) => c.home === path.join(root, ".claude_side")).ok, false);
  assert.equal((await r.pick("codex")).home, null, "a candidate with no usage row is not assumed healthy");
});

test("usageCommand: usageCmd (with `node` meaning this node), else `usage` on PATH; nothing is derived from any path", () => {
  assert.deepEqual(usageCommand({ usageCmd: "my-usage --x" }), { cmd: "my-usage", args: ["--x", "--json"] });
  assert.deepEqual(usageCommand({ usageCmd: "node /opt/usage.mjs" }), { cmd: process.execPath, args: ["/opt/usage.mjs", "--json"] });
  assert.deepEqual(usageCommand({ usageCmd: "" }), { cmd: "usage", args: ["--json"] });
});

// ---- the optional roster ----
test("roster: only protected:false AND manual:false homes are eligible for work", async () => {
  const roster = await loadRoster(rosterFile, HOME);
  assert.equal(roster.length, 12);
  assert.deepEqual(eligibleForWork(roster).map((e) => e.home).sort(), [
    "/home/sam/.claude_side", "/home/sam/.claude_work", "/home/sam/.codex_alt", "/home/sam/.codex_spare", "/home/sam/.codex_work",
  ]);
  assert.ok(!eligibleForWork(roster).some((e) => /\/\.(claude|codex)$/.test(e.home)), "~/.claude and ~/.codex are protected in the sample");
});

test("roster: a missing or malformed roster is a RosterError, never a guess", async () => {
  await assert.rejects(() => loadRoster("/nonexistent/homes.mjs", HOME), RosterError);
  await assert.rejects(() => loadRoster("", HOME), /no roster configured/);
  const bad = path.join(tmpDir(), "r.json");
  fs.writeFileSync(bad, JSON.stringify([{ kind: "claude", home: "~/.claude_x" }]));
  await assert.rejects(() => loadRoster(bad, HOME), /malformed entry/);
});

test("roster: a .mjs module exporting CONTROL_USAGE_HOMES loads too", async () => {
  const mod = path.join(tmpDir(), "homes.mjs");
  fs.writeFileSync(mod, 'export const CONTROL_USAGE_HOMES = [{ id: "a", kind: "claude", home: "~/.claude_a", protected: false, manual: false }];\n');
  assert.deepEqual((await loadRoster(mod, HOME)).map((e) => e.home), ["/home/sam/.claude_a"]);
});

test("router with a roster: Claude work goes to the eligible home with the most headroom (~/.claude_work: ~/.claude_side is walled at 100%, ~/.claude is protected)", async () => {
  const pick = await router(cfg()).pick("claude");
  assert.equal(pick.home, "/home/sam/.claude_work");
  assert.equal(pick.explicit, true);
  const byHome = Object.fromEntries(pick.considered.map((c) => [c.home, c]));
  assert.equal(byHome["/home/sam/.claude"].reason, "protected");
  assert.equal(byHome["/home/sam/.claude_team"].ok, false);
  assert.match(byHome["/home/sam/.claude_side"].reason, /1w All at 100%/);
});

test("router with a roster: Codex work goes to ~/.codex_work (nearly idle) before ~/.codex_alt (39%) and ~/.codex_spare (54%); ~/.codex is never considered eligible", async () => {
  const pick = await router(cfg()).pick("codex");
  assert.equal(pick.home, "/home/sam/.codex_work");
  assert.ok(pick.usedPercent < 10, "the fixture has it nearly idle");
  const byHome = Object.fromEntries(pick.considered.map((c) => [c.home, c]));
  assert.equal(byHome["/home/sam/.codex"].reason, "protected");
  assert.equal(byHome["/home/sam/.codex_alt"].ok, true);
});

test("router with a roster: skips a home at or above 90%, or with error or needsAuth, and falls to the next; none left means null with a reason for every home", async () => {
  const u = usage();
  const row = (p) => u.results.find((r) => r.path.endsWith(p));
  row(".codex_work").windows[0].usedPercent = 90;
  assert.equal((await router(cfg(), u).pick("codex")).home, "/home/sam/.codex_alt");
  row(".codex_alt").needsAuth = true;
  assert.equal((await router(cfg(), u).pick("codex")).home, "/home/sam/.codex_spare");
  row(".codex_spare").error = "Not signed in";
  const none = await router(cfg(), u).pick("codex");
  assert.equal(none.home, null);
  assert.match(none.reason, /walled, errored or needs auth/);
  assert.equal(none.considered.filter((c) => !c.ok).length, 8, "all eight Codex roster homes carry a reason");
  assert.ok(none.considered.some((c) => c.reason === "needsAuth"));
  assert.ok(none.considered.some((c) => /usage error/.test(c.reason)));
});

test("router with a roster: a home missing from usage --json is skipped, not assumed healthy", async () => {
  const u = usage();
  u.results = u.results.filter((r) => !r.path.endsWith(".codex_work"));
  assert.equal((await router(cfg(), u).pick("codex")).home, "/home/sam/.codex_alt");
  assert.equal(judgeUsageRow(undefined, 90).ok, false);
  assert.equal(judgeUsageRow({ windows: [] }, 90).reason, "no usage windows");
});

test("router with a roster: RECALL_CLAUDE_HOME / RECALL_CODEX_HOME pin a home, but only an eligible, healthy one: a protected pin is refused", async () => {
  assert.equal((await router(cfg({ RECALL_CODEX_HOME: "~/.codex_spare" })).pick("codex")).home, "/home/sam/.codex_spare");
  const refused = await router(cfg({ RECALL_CODEX_HOME: "~/.codex" })).pick("codex");
  assert.equal(refused.home, null);
  assert.match(refused.reason, /not an eligible roster home/);
  const refusedClaude = await router(cfg({ RECALL_CLAUDE_HOME: "/home/sam/.claude" })).pick("claude");
  assert.equal(refusedClaude.home, null);
  const walledPin = await router(cfg({ RECALL_CLAUDE_HOME: "~/.claude_side" })).pick("claude");
  assert.equal(walledPin.home, null, "a pinned home that is walled is not used");
});

test("router: usage --json is read through a short TTL cache, not on every pick", async () => {
  const config = cfg({ RECALL_USAGE_TTL_MS: "60000" });
  let runs = 0;
  const run = async () => { runs++; return usage(); };
  let t = 1_000_000;
  const now = () => t;
  await readUsage({ config, run, now });
  t += 30_000;
  const again = await readUsage({ config, run, now });
  assert.equal(runs, 1);
  assert.equal(again.cached, true);
  t += 31_000;
  await readUsage({ config, run, now });
  assert.equal(runs, 2);
});

test("router: a usage reader that fails is a RouterError (the stage is skipped loudly); an unreadable roster is a RouterError too", async () => {
  const r = createRouter({ config: cfg(), homeDir: HOME, run: async () => { throw new Error("usage --json failed: boom"); } });
  await assert.rejects(() => r.pick("claude"), /boom/);
  const missing = createRouter({ config: cfg({ RECALL_HOMES_ROSTER: "/nonexistent/homes.json" }), homeDir: HOME });
  await assert.rejects(() => missing.pick("claude"), /no roster, so no home can be proven eligible/);
});

// ---- the worker process ----
test("worker env: an explicit home is set as the home variable and this process's credentials do not follow it; the other home variable is removed", () => {
  const env = workerEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", ANTHROPIC_API_KEY: "k", NODE_OPTIONS: "--x", CLAUDE_CONFIG_DIR: "/home/sam/.claude", CODEX_HOME: "/home/sam/.codex" }, "claude", "/home/sam/.claude_work");
  assert.deepEqual(env, { PATH: "/bin", RECALL_CHILD: "1", CLAUDE_CONFIG_DIR: "/home/sam/.claude_work" });
  const envC = workerEnv({ PATH: "/bin", CODEX_HOME: "/home/sam/.codex", CLAUDE_CONFIG_DIR: "/home/sam/.claude", OPENAI_API_KEY: "test-openai", CODEX_API_KEY: "test-codex", CODEX_ACCESS_TOKEN: "test-token" }, "codex", "/home/sam/.codex_work");
  assert.deepEqual(envC, { PATH: "/bin", RECALL_CHILD: "1", CODEX_HOME: "/home/sam/.codex_work" });
});

test("worker env: the host's own home (not explicit) keeps the host's home variable as it is, and the user's own login environment", () => {
  const base = { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "/home/sam/.claude_work", CODEX_HOME: "/home/sam/.codex" };
  assert.deepEqual(workerEnv(base, "claude", "/home/sam/.claude_work", {}, { explicit: false }), { PATH: "/bin", ANTHROPIC_API_KEY: "k", RECALL_CHILD: "1", CLAUDE_CONFIG_DIR: "/home/sam/.claude_work" });
  assert.deepEqual(workerEnv({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/x" }, "codex", "/home/sam/.codex", {}, { explicit: false }), { PATH: "/bin", RECALL_CHILD: "1" }, "no CODEX_HOME in the host's environment: none is invented");
});

test("worker args: hooks off, no session persistence, strict MCP, read-only sandbox", () => {
  const ca = claudeArgs({ model: "haiku", schema: { type: "object" } });
  assert.ok(ca.includes("--settings") && ca[ca.indexOf("--settings") + 1] === '{"disableAllHooks":true}');
  assert.ok(ca.includes("--no-session-persistence") && ca.includes("--strict-mcp-config"));
  const xa = codexArgs({ cwd: "/tmp/w", schemaPath: "/tmp/w/s.json", outPath: "/tmp/w/o", effort: "low" });
  assert.ok(xa.join(" ").includes("--disable hooks") && xa.includes("--ephemeral") && xa.includes("read-only"));
});

test("worker: no eligible home means the stage is skipped with a loud log entry, and no process is ever spawned", async () => {
  const u = usage();
  for (const r of u.results) if (r.kind === "codex") for (const w of r.windows) w.usedPercent = 95;
  const logs = [];
  let spawned = 0;
  const config = cfg();
  await assert.rejects(
    () => runCliWorker({ router: router(config, u), config, kind: "codex", prompt: "hi", spawnImpl: () => { spawned++; throw new Error("must not spawn"); }, log: (e) => logs.push(e) }),
    (e) => e instanceof WorkerSkipped && /no codex worker run/.test(e.message),
  );
  assert.equal(spawned, 0);
  assert.equal(logs[0].level, "error");
  assert.equal(logs[0].event, "worker-skipped");
  assert.ok(logs[0].considered.length >= 5);
});

test("worker: runs under the home the router picked (CLAUDE_CONFIG_DIR set to it), via a stand-in binary", async () => {
  const config = cfg();
  const seen = [];
  const spawnImpl = (bin, args, opts) => syncChild(seen, bin, args, opts);
  const out = await runCliWorker({ router: router(config), config, kind: "claude", prompt: "p", model: "haiku", schema: { type: "object" }, spawnImpl });
  assert.equal(seen[0].bin, "claude");
  assert.equal(seen[0].env.CLAUDE_CONFIG_DIR, "/home/sam/.claude_work");
  assert.equal(seen[0].env.RECALL_CHILD, "1");
  assert.deepEqual(out.json, { order: [2, 1] });
  assert.equal(out.home, "/home/sam/.claude_work");
});

test("worker: by default it runs under the host's own home and passes the host's environment through (no explicit home variable is invented)", async () => {
  const root = realHome(".claude");
  const config = loadConfig({ RECALL_DATA: tmpDir("recall-router") });
  const seen = [];
  const spawnImpl = (bin, args, opts) => syncChild(seen, bin, args, opts);
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.ANTHROPIC_API_KEY = "test-key-for-the-user-own-login";
  try {
    const out = await runCliWorker({ router: createRouter({ config, homeDir: root, env: {}, ...withCli }), config, kind: "claude", prompt: "p", model: "haiku", schema: { type: "object" }, spawnImpl });
    assert.equal(out.home, path.join(root, ".claude"));
    assert.ok(!("CLAUDE_CONFIG_DIR" in seen[0].env), "the default home is the CLI's own default: the variable stays unset");
    assert.equal(seen[0].env.ANTHROPIC_API_KEY, "test-key-for-the-user-own-login");
    assert.equal(seen[0].env.RECALL_CHILD, "1");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

function syncChild(seen, bin, args, opts) {
  seen.push({ bin, args, env: opts.env });
  const child = new EventEmitter();
  child.stdout = Readable.from([JSON.stringify({ is_error: false, result: "hello", structured_output: { order: [2, 1] } })]);
  child.stderr = Readable.from([]);
  child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  child.kill = () => {};
  setImmediate(() => child.emit("close", 0));
  return child;
}
