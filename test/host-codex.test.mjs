// Codex homes: the status read from config.toml and the plugin cache, the exact `codex plugin` commands for each, CODEX_HOME per home, the
// marketplace that points elsewhere (removed, then added), hook trust kept, and the runner itself (a real child: timeout, missing command).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { homeStatus, installHome, readHomeState, uninstallHome } from "../scripts/onboarding/hosts/index.mjs";
import { failureReason, mapLimit, run } from "../scripts/onboarding/hosts/runner.mjs";
import { tmpDir } from "./helpers.mjs";
import { codexState, ID, scriptedRunner } from "./host-sim.mjs";

const V = "0.5.1";
const setup = () => {
  const homeDir = tmpDir("recall-host-codex");
  return { homeDir, M: path.join(homeDir, ".plugin-recall", "marketplace") };
};
const row = (homeDir, name = ".codex", exists = true) => ({ host: "codex", label: "Codex", home: path.join(homeDir, name), display: `~/${name}`, isDefault: name === ".codex", exists });
const BASE = { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "sk-secret-1", CODEX_API_KEY: "c2", CODEX_ACCESS_TOKEN: "t3", CODEX_HOME: "/codex/else", CLAUDE_CONFIG_DIR: "/c" };

async function install(homeDir, M, r, script) {
  const runner = scriptedRunner({ homeDir, V, script });
  const status = homeStatus(readHomeState(r, V), { M, V });
  const result = await installHome(r, status, { M, V, run: runner.run, base: BASE, homeDir });
  return { status, result, lines: runner.lines(), calls: runner.calls };
}

test("new home: marketplace add, plugin add; a missing ~/.codex is created 0700 first (Codex refuses a CODEX_HOME that does not exist)", async () => {
  const { homeDir, M } = setup();
  const r = row(homeDir, ".codex", false);
  const { status, result, lines, calls } = await install(homeDir, M, r);
  assert.deepEqual(status, { kind: "new" });
  assert.deepEqual(lines, [`codex plugin marketplace add ${M} --json`, `codex plugin add ${ID} --json`]);
  assert.deepEqual(result, { ok: true, outcome: "installed", trusted: false });
  assert.equal(fs.statSync(r.home).mode & 0o777, 0o700);
  for (const c of calls) {
    assert.equal(c.env.CODEX_HOME, r.home);
    for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CLAUDE_CONFIG_DIR"]) assert.equal(c.env[k], undefined, k);
  }
});

test("each status runs its own commands; a marketplace from another source is removed before it is added again", async () => {
  const cases = [
    ["current", { version: V, marketplace: "M" }, [], "up to date"],
    ["update", { version: "0.4.0", marketplace: "M" }, [`plugin add ${ID} --json`], "updated 0.4.0 → 0.5.1"],
    ["disabled", { version: V, marketplace: "M", enabled: false }, [`plugin add ${ID} --json`], "enabled"],
    ["reinstall", { version: V, marketplace: "/checkout/plugin-recall" }, ["plugin marketplace remove plugin-recall --json", "plugin marketplace add M --json"], "installed"],
    ["update", { version: "0.4.0", marketplace: "/checkout/plugin-recall" }, ["plugin marketplace remove plugin-recall --json", "plugin marketplace add M --json", `plugin add ${ID} --json`], "updated 0.4.0 → 0.5.1"],
  ];
  for (const [kind, state, expected, outcome] of cases) {
    const { homeDir, M } = setup();
    const r = row(homeDir, ".codex_work");
    codexState(r.home, { ...state, marketplace: state.marketplace === "M" ? M : state.marketplace });
    const { status, result, lines } = await install(homeDir, M, r);
    assert.equal(status.kind, kind);
    assert.deepEqual(lines, expected.map((l) => `codex ${l.replace(" M ", ` ${M} `)}`), `${kind} ${state.marketplace}`);
    assert.deepEqual(result, { ok: true, outcome, trusted: false });
  }
});

test("trust: read from [hooks.state.\"recall@plugin-recall:...\"], and kept when the marketplace is repointed", async () => {
  const { homeDir, M } = setup();
  const r = row(homeDir);
  codexState(r.home, { version: V, marketplace: "/checkout/plugin-recall", trusted: true });
  assert.equal(readHomeState(r, V).trusted, true);
  const { result } = await install(homeDir, M, r);
  assert.deepEqual(result, { ok: true, outcome: "installed", trusted: true });
  assert.match(fs.readFileSync(path.join(r.home, "config.toml"), "utf8"), /^\[hooks\.state\."recall@plugin-recall:/m);
});

test("another copy ([plugins.\"recall@<other>\"]) is left alone", () => {
  const { homeDir, M } = setup();
  const r = row(homeDir);
  codexState(r.home, { other: "recall@another-market" });
  assert.deepEqual(homeStatus(readHomeState(r, V), { M, V }), { kind: "other", id: "recall@another-market" });
});

test("verify: success without the cache for this version fails the home; failures stay in their home", async () => {
  const { homeDir, M } = setup();
  const noop = await install(homeDir, M, row(homeDir, ".codex_x"), () => ({ stdout: "{}" }));
  assert.equal(noop.result.reason, "the codex CLI reported success, but ~/.codex_x does not list Recall 0.5.1");
  const rows = [row(homeDir, ".codex_a"), row(homeDir, ".codex_b"), row(homeDir, ".codex_c")];
  for (const r of rows) fs.mkdirSync(r.home, { recursive: true });
  const runner = scriptedRunner({ homeDir, V, script: (c) => (c.env.CODEX_HOME.endsWith(".codex_a") && c.args[1] === "add" ? { exitCode: 1, stderr: "WARNING: Refusing to create helper binaries under temporary dir\nError: marketplace 'plugin-recall' is not added\n" } : null) });
  const results = await mapLimit(rows, 4, (r) => installHome(r, homeStatus(readHomeState(r, V), { M, V }), { M, V, run: runner.run, base: {}, homeDir }));
  assert.deepEqual(results.map((x) => x.ok), [false, true, true]);
  assert.equal(results[0].reason, "marketplace 'plugin-recall' is not added", "the helper-binaries warning is not the reason");
});

test("uninstall: plugin remove, then the marketplace; trust may stay", async () => {
  const { homeDir, M } = setup();
  const r = row(homeDir);
  codexState(r.home, { version: V, marketplace: M, trusted: true });
  const runner = scriptedRunner({ homeDir, V });
  assert.deepEqual(await uninstallHome(r, { run: runner.run, base: {}, homeDir }), { ok: true });
  assert.deepEqual(runner.lines(), [`codex plugin remove ${ID} --json`, "codex plugin marketplace remove plugin-recall --json"]);
  assert.equal(readHomeState(r, V).configured, false);
});

test("the runner: output collected, a missing command resolves, a timeout always settles (SIGTERM, then SIGKILL)", async () => {
  const ok = await run("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"], { env: { PATH: "/usr/bin:/bin" } });
  assert.deepEqual(ok, { exitCode: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
  const missing = await run("recall-no-such-command", [], { env: { PATH: tmpDir("recall-empty-path") } });
  assert.equal(missing.exitCode, 127);
  assert.equal(failureReason(missing, "codex"), "codex is not installed; install it (npm i -g @openai/codex)");
  assert.equal(failureReason(missing, "claude", " or remove the home with --homes"), "claude is not installed; install it (curl -fsSL https://claude.ai/install.sh | bash) or remove the home with --homes");
  const t0 = Date.now();
  const stubborn = await run("/bin/sh", ["-c", "trap '' TERM; exec sleep 30"], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 200 });
  assert.equal(stubborn.timedOut, true);
  assert.ok(Date.now() - t0 < 5000, "SIGKILL ends a child that ignores SIGTERM");
  assert.equal(failureReason(stubborn, "claude"), "timed out after 60 s");
});
