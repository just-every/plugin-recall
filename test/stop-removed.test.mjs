// The Stop hook is gone, not disabled (design decision: Recall acts only when you send a message). Nothing of it may remain in the
// hook manifest, the scripts, the configuration or the tests; the monitor alone still DRAWS the Stop lines older logs hold.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_KEYS, ConfigError, loadConfig } from "../scripts/lib/config.mjs";
import { parseHookInput } from "../scripts/lib/hook-io.mjs";
import { tmpDir } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const walk = (dir, exts) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), exts) : exts.some((x) => e.name.endsWith(x)) ? [path.join(dir, e.name)] : []));
const REMOVED_KEYS = ["stopPipeline", "stopThreshold", "stopCandidates", "stopVerify", "stopVerifyMax", "stopMinChars", "stopInjectThreshold"];

test("hooks.json has the UserPromptSubmit hook and nothing else; both manifests share it and say nothing of a stop-time audit", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks.hooks), ["UserPromptSubmit"]);
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /user-prompt-submit\.mjs/);
  for (const f of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
    assert.ok(!/stop/i.test(fs.readFileSync(path.join(ROOT, f), "utf8")), `${f} mentions a stop hook`);
  }
});

test("the Stop script, hook logic, audit, verification and violation question are deleted", () => {
  for (const f of ["scripts/stop.mjs", "scripts/lib/stop-hook.mjs", "scripts/lib/audit.mjs", "scripts/lib/verify.mjs", "test/stop-audit.test.mjs", "test/stop-pipeline.test.mjs"]) {
    assert.equal(fs.existsSync(path.join(ROOT, f)), false, f);
  }
  // code and configuration, everywhere; the log vocabulary of old Stop lines ("stop-hook-active", ...) only outside the monitor, which still draws them
  const everywhere = [/\bhandleStop\b/, /\bstopOutput\b/, /\bformatViolation\b/, /\bVIOLATION_TEXT\b/, /\bviolationQuestion\b/, /\bauditMessage\b/, /\bverifyViolations\b/, /RECALL_STOP_/, /\bstopCandidates\b/, /\bstopPipeline\b/, /\bstopInjectThreshold\b/, /\bstopVerify/, /\bstopMinChars\b/];
  const outsideMonitor = [/\bstop_hook_active\b/, /\blast_assistant_message\b/, /stop-hook/, /stop\.mjs/, /\bstopThreshold\b/];
  for (const file of walk(path.join(ROOT, "scripts"), [".mjs", ".js", ".json", ".html", ".css", ".py"])) {
    const text = fs.readFileSync(file, "utf8");
    const rules = file.includes(`${path.sep}monitor${path.sep}`) ? everywhere : [...everywhere, ...outsideMonitor];
    for (const re of rules) assert.ok(!re.test(text), `${path.relative(ROOT, file)} still has ${re}`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, "scripts", "lib", "pipelines", "questions.mjs")) || !/VIOLATION|violation/.test(fs.readFileSync(path.join(ROOT, "scripts", "lib", "pipelines", "questions.mjs"), "utf8")));
});

test("no Stop config key is left; a config.json that still has one is invalid, and a Stop payload is not a hook event", () => {
  for (const key of REMOVED_KEYS) assert.ok(!CONFIG_KEYS.includes(key), key);
  assert.ok(!CONFIG_KEYS.some((k) => /^stop/i.test(k)));
  const dataDir = tmpDir("recall-nostop");
  for (const key of REMOVED_KEYS) {
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ [key]: 1 }));
    assert.throws(() => loadConfig({ RECALL_DATA: dataDir }), (e) => e instanceof ConfigError && e.message.includes(`unknown key "${key}"`));
  }
  const config = loadConfig({});
  assert.ok(!Object.keys(config).some((k) => /^stop/i.test(k)), "no stop field in the effective configuration");
  assert.throws(() => parseHookInput({ stdin: JSON.stringify({ session_id: "s", prompt_id: "p", hook_event_name: "Stop", last_assistant_message: "x" }) }), /unsupported hook event "Stop"/);
});

test("the README tells upgraders that a config.json with a removed key is invalid", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /`config\.json` that still has a removed key[^.]*invalid/i);
  assert.match(readme, /stopMinChars/);
});
