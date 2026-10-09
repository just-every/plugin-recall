// Both hosts' plugin manifests, the shared hooks file, and the package, checked structurally (this stands in for Codex's plugin validator)
// plus the real `claude plugin validate` when the claude CLI exists (run against an empty scratch config dir, never a real home).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { needsNpm, npm } from "./npm.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), "utf8"));

test("Codex manifest: name, version, interface fields, skills, in the dual-host pattern", () => {
  const m = json(".codex-plugin", "plugin.json");
  assert.equal(m.name, "recall");
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  for (const k of ["description", "author", "homepage", "repository", "license", "keywords", "interface"]) assert.ok(m[k], `missing ${k}`);
  for (const k of ["displayName", "shortDescription", "longDescription", "developerName", "category", "capabilities", "defaultPrompt", "brandColor", "websiteURL"]) assert.ok(m.interface[k], `interface.${k}`);
  assert.equal(json("package.json").version, m.version);
  assert.equal(m.skills, "./skills/", "the bundled skill is declared for Codex (Claude Code finds skills/ in the plugin root)");
  assert.ok(fs.existsSync(path.join(ROOT, "skills", "recall", "SKILL.md")));
});

test("Claude manifest: kebab-case name without a reserved prefix, same version as the Codex manifest", () => {
  const m = json(".claude-plugin", "plugin.json");
  assert.match(m.name, /^[a-z][a-z0-9-]*$/);
  assert.ok(!/^(claude|anthropic)-/.test(m.name));
  assert.equal(m.version, json(".codex-plugin", "plugin.json").version);
  assert.equal(m.name, json(".codex-plugin", "plugin.json").name);
});

test("hooks.json: the one event, handlers use `timeout` (Codex ignores `timeoutSec`), no stray top-level keys, scripts exist", () => {
  const h = json("hooks", "hooks.json");
  assert.deepEqual(Object.keys(h), ["hooks"], "Codex hooks.json is deny_unknown_fields: only description and hooks");
  assert.deepEqual(Object.keys(h.hooks), ["UserPromptSubmit"], "Recall acts only when the user sends a message: no Stop hook");
  for (const [event, groups] of Object.entries(h.hooks)) {
    for (const g of groups) for (const handler of g.hooks) {
      assert.equal(handler.type, "command");
      assert.ok(Number.isInteger(handler.timeout) && handler.timeout > 0 && handler.timeout <= 30, `${event} timeout`);
      assert.ok(!("timeoutSec" in handler), "Codex ignores timeoutSec");
      const script = /\/scripts\/([\w.-]+\.mjs)/.exec(handler.command)[1];
      assert.ok(fs.existsSync(path.join(ROOT, "scripts", script)), script);
      assert.ok(handler.statusMessage);
    }
  }
  const ups = h.hooks.UserPromptSubmit[0].hooks[0];
  assert.ok(ups.timeout * 1000 > loadTimeout(), "the hook's own deadline (RECALL_TIMEOUT_MS) is inside the host's timeout");
});

function loadTimeout() {
  return Number(/RECALL_TIMEOUT_MS", (\d+)/.exec(fs.readFileSync(path.join(ROOT, "scripts", "lib", "config.mjs"), "utf8"))[1]);
}

test("hooks.json command resolves the plugin root under BOTH hosts' environments (CLAUDE_PLUGIN_ROOT, or PLUGIN_ROOT alone) and runs the script", () => {
  const command = json("hooks", "hooks.json").hooks.UserPromptSubmit[0].hooks[0].command;
  for (const env of [{ CLAUDE_PLUGIN_ROOT: ROOT }, { PLUGIN_ROOT: ROOT }, { CLAUDE_PLUGIN_ROOT: ROOT, PLUGIN_ROOT: ROOT }]) {
    const r = spawnSync("/bin/sh", ["-c", command], { input: "{}", env: { PATH: process.env.PATH, RECALL_DISABLED: "1", RECALL_DATA: tmpDir("recall-m"), ...env }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { continue: true }, JSON.stringify(Object.keys(env)));
  }
});

/** The environment `claude plugin validate` runs in: this one without any *_API_KEY or *_AUTH_TOKEN (it needs no credential), and a scratch config dir. */
function validateEnv(env = process.env) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !/_API_KEY$|_AUTH_TOKEN$/.test(k)));
  return { ...out, CLAUDE_CONFIG_DIR: tmpDir("recall-validate-home") };
}

test("the validate environment carries no API key or auth token", () => {
  const env = validateEnv({ PATH: "/bin", OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-y", CLAUDE_CODE_OAUTH_AUTH_TOKEN: "t", HOME: "/h" });
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
});

test("claude plugin validate passes (skipped when the claude CLI is not installed)", (t) => {
  const which = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" });
  if (which.status !== 0) return t.skip("no claude CLI");
  const r = spawnSync("claude", ["plugin", "validate", ROOT], { encoding: "utf8", env: validateEnv() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Validation passed/);
});

test("marketplaces for both hosts list the plugin from the repository root, so a GitHub path or a local checkout installs the same way (the README commands use them)", (t) => {
  const codex = json(".agents", "plugins", "marketplace.json");
  const claude = json(".claude-plugin", "marketplace.json");
  assert.equal(codex.name, "plugin-recall");
  assert.equal(claude.name, "plugin-recall");
  assert.deepEqual(codex.plugins.map((p) => [p.name, p.source.source, p.source.path, p.policy.installation]), [["recall", "local", "./", "AVAILABLE"]]);
  assert.deepEqual(claude.plugins.map((p) => [p.name, p.source]), [["recall", "./"]]);
  assert.equal(codex.plugins[0].name, json(".codex-plugin", "plugin.json").name);
  assert.equal(claude.plugins[0].name, json(".claude-plugin", "plugin.json").name);
  assert.ok(claude.owner?.name && claude.description);
  const which = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" });
  if (which.status !== 0) return t.skip("no claude CLI for the plugin.json validation");
  const r = spawnSync("claude", ["plugin", "validate", path.join(ROOT, ".claude-plugin", "plugin.json")], { encoding: "utf8", env: validateEnv() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("npm pack ships every runtime file, the skill, the license and the changelog, and no tests, evidence or private examples", needsNpm, () => {
  const out = JSON.parse(npm(["pack", "--dry-run", "--json"], { cwd: ROOT }));
  const files = out[0].files.map((f) => f.path);
  for (const must of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "hooks/hooks.json", "bin/recall", "scripts/recall.mjs", "scripts/user-prompt-submit.mjs", "docs/cards-prompt.md", "scripts/lib/cards/enrich.mjs", "scripts/lib/text-filter/owner-text.mjs", "scripts/onboarding/setup.mjs", "skills/recall/SKILL.md", "LICENSE", "CHANGELOG.md", ".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json", "scripts/lib/headless.mjs", "scripts/lib/lock.mjs", "README.md",
    "scripts/lib/providers/index.mjs", "scripts/lib/providers/openai.mjs", "scripts/lib/cli-login.mjs", "scripts/lib/usage-error.mjs",
    ...["ui", "agent-homes", "detect", "key-step", "env-file", "plan", "settings", "marketplace", "launcher", "install-record", "uninstall", "help", "apply", "summary", "home-rows", "prune"].map((f) => `scripts/onboarding/${f}.mjs`),
    ...["runner", "claude", "codex", "index"].map((f) => `scripts/onboarding/hosts/${f}.mjs`)]) assert.ok(files.includes(must), must);
  assert.ok(!files.some((f) => f.startsWith("test/") || f.startsWith("evidence/") || f.includes("node_modules") || f === "docs/examples/fleet-config.json"), files.filter((f) => /^(test|evidence)\//.test(f)).join(", "));
  const allowed = /^(\.codex-plugin|\.claude-plugin|\.agents|hooks|bin|scripts|skills|docs)\/|^(README\.md|CHANGELOG\.md|LICENSE|package\.json)$/;
  assert.deepEqual(files.filter((f) => !allowed.test(f)), [], "only the listed top-level entries are packed");
});

test("the plugin is standalone: no import reaches outside the repo or into the lab", () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".mjs") ? [path.join(d, e.name)] : []));
  for (const file of walk(path.join(ROOT, "scripts"))) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      assert.ok(spec.startsWith("node:") || spec.startsWith("."), `${file}: bare import ${spec}`);
      if (spec.startsWith(".")) assert.ok(path.resolve(path.dirname(file), spec).startsWith(ROOT), `${file}: ${spec} leaves the repo`);
    }
  }
});
