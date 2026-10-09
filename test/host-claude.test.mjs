// Claude Code homes: the status read from the host's own files and the exact `claude plugin` commands for each, run through a scripted
// runner (no process), the environment each home gets, verification after the commands, and failures kept to their own home.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { homeStatus, installHome, readHomeState, statusText, uninstallHome } from "../scripts/onboarding/hosts/index.mjs";
import { hostEnv, mapLimit } from "../scripts/onboarding/hosts/runner.mjs";
import { tmpDir } from "./helpers.mjs";
import { claudeState, ID, scriptedRunner } from "./host-sim.mjs";

const V = "0.5.1";
const setup = () => {
  const homeDir = tmpDir("recall-host-claude");
  return { homeDir, M: path.join(homeDir, ".plugin-recall", "marketplace") };
};
const row = (homeDir, name = ".claude") => ({ host: "claude", label: "Claude Code", home: path.join(homeDir, name), display: `~/${name}`, isDefault: name === ".claude", exists: true });
const BASE = {
  PATH: "/usr/bin:/bin", HOME: "/home/sam", OPENAI_API_KEY: "sk-secret-1", ANTHROPIC_API_KEY: "sk-ant-2", ANTHROPIC_AUTH_TOKEN: "t3", CODEX_ACCESS_TOKEN: "t4",
  CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", NODE_OPTIONS: "--inspect", CLAUDE_CONFIG_DIR: "/somewhere/else", CODEX_HOME: "/codex/else",
};

async function install(homeDir, M, r, script) {
  const runner = scriptedRunner({ homeDir, V, script });
  const status = homeStatus(readHomeState(r, V), { M, V });
  const result = await installHome(r, status, { M, V, run: runner.run, base: BASE, homeDir });
  return { status, result, lines: runner.lines(), calls: runner.calls };
}

test("new home: add the marketplace, install; verified from installed_plugins.json, settings.json and known_marketplaces.json", async () => {
  const { homeDir, M } = setup();
  const r = row(homeDir);
  const { status, result, lines } = await install(homeDir, M, r);
  assert.deepEqual(status, { kind: "new" });
  assert.deepEqual(lines, [`claude plugin marketplace add ${M} --json`, `claude plugin install ${ID} --json`]);
  assert.deepEqual(result, { ok: true, outcome: "installed", trusted: true });
  assert.deepEqual(homeStatus(readHomeState(r, V), { M, V }), { kind: "current" });
});

test("each status runs its own commands: up to date none, update, reinstall from this copy, disabled", async () => {
  const cases = [
    ["current", { version: V, marketplace: "M" }, [], "up to date"],
    ["update", { version: "0.4.0", marketplace: "M" }, ["plugin marketplace update plugin-recall --json", `plugin update ${ID} --json`], "updated 0.4.0 → 0.5.1"],
    ["reinstall", { version: V, marketplace: "/checkout/plugin-recall" }, ["plugin marketplace add M --json", "plugin marketplace update plugin-recall --json", `plugin update ${ID} --json`], "installed"],
    ["disabled", { version: V, marketplace: "M", enabled: false }, [`plugin install ${ID} --json`], "enabled"],
  ];
  for (const [kind, state, expected, outcome] of cases) {
    const { homeDir, M } = setup();
    const r = row(homeDir);
    claudeState(r.home, { ...state, marketplace: state.marketplace === "M" ? M : state.marketplace });
    const { status, result, lines } = await install(homeDir, M, r);
    assert.equal(status.kind, kind);
    assert.deepEqual(lines, expected.map((l) => `claude ${l.replace(" M ", ` ${M} `)}`), kind);
    assert.deepEqual(result, { ok: true, outcome, trusted: true }, kind);
  }
});

test("statusText: the words of the homes table", () => {
  assert.equal(statusText({ kind: "new" }, V), "new");
  assert.equal(statusText({ kind: "current" }, V), "up to date");
  assert.equal(statusText({ kind: "update", old: "0.4.0" }, V), "update 0.4.0 → 0.5.1");
  assert.equal(statusText({ kind: "reinstall" }, V), "reinstall 0.5.1 from this copy");
  assert.equal(statusText({ kind: "disabled" }, V), "disabled; will be enabled");
  assert.equal(statusText({ kind: "other", id: "recall@other-market" }, V), "has recall@other-market; left alone");
});

test("another copy of Recall (recall@<other marketplace>) makes the home one to leave alone", () => {
  const { homeDir, M } = setup();
  const r = row(homeDir);
  claudeState(r.home, { other: "recall@someone-else" });
  assert.deepEqual(homeStatus(readHomeState(r, V), { M, V }), { kind: "other", id: "recall@someone-else" });
  claudeState(r.home, { version: V, marketplace: M, other: "recall@someone-else" });
  assert.equal(homeStatus(readHomeState(r, V), { M, V }).kind, "other", "even with our own copy beside it");
});

test("the environment of each home: ~/.claude leaves CLAUDE_CONFIG_DIR unset, another home sets it; no key, token or session variable passes", async () => {
  const { homeDir, M } = setup();
  const { calls: dflt } = await install(homeDir, M, row(homeDir));
  const { calls: work } = await install(homeDir, M, row(homeDir, ".claude_work"));
  assert.equal(dflt[0].env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(work[0].env.CLAUDE_CONFIG_DIR, path.join(homeDir, ".claude_work"));
  for (const c of [...dflt, ...work]) {
    for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CODEX_ACCESS_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "NODE_OPTIONS", "CODEX_HOME"]) assert.equal(c.env[k], undefined, k);
    assert.equal(c.env.PATH, BASE.PATH);
    assert.equal(c.timeoutMs, 60000);
  }
  assert.equal(hostEnv("claude", path.join(homeDir, ".claude", "."), { base: {}, homeDir }).CLAUDE_CONFIG_DIR, undefined, "compared resolved");
});

test("a command that fails, times out, or succeeds without the state to show for it fails that home with one line", async () => {
  const { homeDir, M } = setup();
  const fail = await install(homeDir, M, row(homeDir), (c) => (c.args[1] === "install" ? { exitCode: 1, stdout: '{"outcome":"error","message":"Plugin \\"recall\\" not found\\nmore"}' } : null));
  assert.deepEqual(fail.result, { ok: false, reason: 'Plugin "recall" not found', trusted: true });
  const old = await install(homeDir, M, row(homeDir, ".claude_a"), () => ({ exitCode: 1, stderr: "error: unknown command 'plugin'\n" }));
  assert.equal(old.result.reason, "unknown command 'plugin' (update claude: claude update)");
  assert.deepEqual(old.lines.length, 1, "the first failure stops that home");
  const slow = await install(homeDir, M, row(homeDir, ".claude_b"), () => ({ exitCode: null, timedOut: true }));
  assert.equal(slow.result.reason, "timed out after 60 s");
  const noop = await install(homeDir, M, row(homeDir, ".claude_c"), () => ({ stdout: '{"outcome":"ok"}' }));
  assert.equal(noop.result.reason, "the claude CLI reported success, but ~/.claude_c does not list Recall 0.5.1");
  const notOk = await install(homeDir, M, row(homeDir, ".claude_d"), () => ({ stdout: '{"outcome":"warning","message":"nothing to do"}' }));
  assert.equal(notOk.result.ok, false, "exit 0 without outcome ok is not success");
});

test("three homes, four at a time: a failure in one leaves the others installed", async () => {
  const { homeDir, M } = setup();
  const rows = [row(homeDir), row(homeDir, ".claude_two"), row(homeDir, ".claude_three")];
  const runner = scriptedRunner({ homeDir, V, script: (c) => (c.env.CLAUDE_CONFIG_DIR?.endsWith(".claude_two") ? { exitCode: 1, stderr: "disk full" } : null) });
  const results = await mapLimit(rows, 4, (r) => installHome(r, homeStatus(readHomeState(r, V), { M, V }), { M, V, run: runner.run, base: {}, homeDir }));
  assert.deepEqual(results.map((x) => x.ok), [true, false, true]);
  assert.equal(results[1].reason, "disk full");
  assert.deepEqual(rows.map((r) => homeStatus(readHomeState(r, V), { M, V }).kind), ["current", "new", "current"]);
});

test("uninstall: plugin uninstall, then the marketplace; a home without Recall runs nothing", async () => {
  const { homeDir, M } = setup();
  const r = row(homeDir);
  claudeState(r.home, { version: V, marketplace: M });
  const runner = scriptedRunner({ homeDir, V });
  assert.deepEqual(await uninstallHome(r, { run: runner.run, base: {}, homeDir }), { ok: true });
  assert.deepEqual(runner.lines(), [`claude plugin uninstall ${ID} --json`, "claude plugin marketplace remove plugin-recall --json"]);
  const state = readHomeState(r, V);
  assert.equal(state.installed, false);
  assert.equal(state.marketplace, null);
  const again = scriptedRunner({ homeDir, V });
  assert.deepEqual(await uninstallHome(r, { run: again.run, base: {}, homeDir }), { ok: true });
  assert.deepEqual(again.lines(), []);
});
