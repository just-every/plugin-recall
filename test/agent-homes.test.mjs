// Which agent homes setup can install into: default homes, the hosts' variables, marked sibling folders, symlinks, and the order shown.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discoverHomes } from "../scripts/onboarding/agent-homes.mjs";
import { tmpDir } from "./helpers.mjs";
import { addClaudeHome, addCodexHome } from "./sandbox.mjs";

const both = { claude: true, codex: true };
const shown = (rows) => rows.map((r) => `${r.host} ${r.display}${r.exists ? "" : " (missing)"}`);

test("default homes, marked siblings in order, and folders that are not homes rejected", () => {
  const home = tmpDir("recall-homes");
  addClaudeHome(home, ".claude");
  addClaudeHome(home, ".claude_zeta");
  addClaudeHome(home, ".claude-alpha");
  fs.mkdirSync(path.join(home, ".claudemind")); // not .claude_ or .claude-
  fs.mkdirSync(path.join(home, ".claude-code-router")); // a tool's folder: no .claude.json
  addCodexHome(home, ".codex");
  addCodexHome(home, ".codex_work");
  fs.mkdirSync(path.join(home, ".codex-empty")); // no config.toml, auth.json or sessions/
  fs.mkdirSync(path.join(home, ".codex_sessions_only", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex-auth"));
  fs.writeFileSync(path.join(home, ".codex-auth", "auth.json"), "{}");
  fs.mkdirSync(path.join(home, ".code"));
  const rows = discoverHomes({ homeDir: home, env: {}, hosts: both });
  assert.deepEqual(shown(rows), [
    "claude ~/.claude", "claude ~/.claude-alpha", "claude ~/.claude_zeta",
    "codex ~/.codex", "codex ~/.codex-auth", "codex ~/.codex_sessions_only", "codex ~/.codex_work",
  ]);
  assert.deepEqual(rows.map((r) => r.isDefault), [true, false, false, true, false, false, false]);
  assert.deepEqual(rows.map((r) => r.sessions), [1, 1, 1, 1, 0, 0, 1]);
  assert.equal(rows[0].label, "Claude Code");
  assert.equal(rows[3].label, "Codex");
  assert.equal(rows[0].home, path.join(home, ".claude"));
});

test("a host whose CLI is not on PATH has no rows; with nothing else found the default home is a row of its own, missing", () => {
  const home = tmpDir("recall-homes");
  addClaudeHome(home, ".claude");
  addCodexHome(home, ".codex");
  assert.deepEqual(shown(discoverHomes({ homeDir: home, env: {}, hosts: { claude: true, codex: false } })), ["claude ~/.claude"]);
  assert.deepEqual(shown(discoverHomes({ homeDir: home, env: {}, hosts: { claude: false, codex: true } })), ["codex ~/.codex"]);
  const empty = tmpDir("recall-homes");
  const rows = discoverHomes({ homeDir: empty, env: {}, hosts: both });
  assert.deepEqual(shown(rows), ["claude ~/.claude (missing)", "codex ~/.codex (missing)"]);
  assert.ok(rows.every((r) => r.isDefault && r.sessions === 0));
});

test("a home named by CLAUDE_CONFIG_DIR or CODEX_HOME needs no marker; one outside the home folder is shown absolute; a missing one is not a row", () => {
  const home = tmpDir("recall-homes");
  const elsewhere = tmpDir("recall-homes-elsewhere");
  fs.mkdirSync(path.join(home, "profiles", "work-claude"), { recursive: true });
  const codexDir = path.join(elsewhere, "cx");
  fs.mkdirSync(codexDir);
  const rows = discoverHomes({ homeDir: home, env: { CLAUDE_CONFIG_DIR: "~/profiles/work-claude", CODEX_HOME: codexDir }, hosts: both });
  assert.deepEqual(shown(rows), ["claude ~/profiles/work-claude", "codex " + codexDir]);
  assert.ok(rows.every((r) => !r.isDefault));
  const gone = discoverHomes({ homeDir: home, env: { CODEX_HOME: path.join(elsewhere, "nope") }, hosts: { codex: true } });
  assert.deepEqual(shown(gone), ["codex ~/.codex (missing)"]);
});

test("symlinks are followed and homes are de-duplicated by real path (the default home wins)", () => {
  const home = tmpDir("recall-homes");
  addClaudeHome(home, ".claude");
  fs.symlinkSync(path.join(home, ".claude"), path.join(home, ".claude_link"));
  const target = addCodexHome(tmpDir("recall-homes-target"), "real-codex");
  fs.symlinkSync(target, path.join(home, ".codex_linked"));
  const rows = discoverHomes({ homeDir: home, env: { CLAUDE_CONFIG_DIR: path.join(home, ".claude_link") }, hosts: both });
  assert.deepEqual(shown(rows), ["claude ~/.claude", "codex ~/.codex_linked"]);
  assert.equal(rows[1].sessions, 1, "a symlinked home is read through the link");
});
