// Nothing specific to one person's machine, accounts or agent fleet may be in a tracked file, and the package must pack cleanly.
// The forbidden terms are matched case-insensitively against the content of every file git tracks (and the names of the files), except the few
// files that exist to document the opt-in fleet profile.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { needsNpm, npm } from "./npm.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = () => {
  const names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  return names.filter((n) => fs.existsSync(path.join(ROOT, n)));
};

// Nothing from a personal machine may ship: an absolute macOS home path is always refused. A maintainer's own names, companies, homes
// and project words are not listed here (this file is public): put them, as regular-expression sources, in a JSON array outside the
// repository and point RECALL_PRIVATE_TERMS at it before a release; they are then matched case-insensitively too.
const PRIVATE = process.env.RECALL_PRIVATE_TERMS ? JSON.parse(fs.readFileSync(process.env.RECALL_PRIVATE_TERMS, "utf8")).map((src) => new RegExp(src, "i")) : [];
const ALWAYS = [/\/Users\//, ...PRIVATE];
// Words of one particular agent fleet: allowed in the opt-in profile and its example, nowhere else that ships.
const FLEET_WORDS = [/\bCOO\b/, /\bdesk\b/i, /\bproposer\b/i, /\borchestrator\b/i, /\blanes?\b/i];
// (monitor/reasons.mjs words the profile's `lane-brief` reason id)
const FLEET_FILES = new Set(["scripts/lib/text-filter/fleet.mjs", "scripts/monitor/reasons.mjs", "test/text-filter.test.mjs", "test/publish-readiness.test.mjs", "test/hooks.test.mjs"]);
// `just-every` is the publisher's GitHub organisation: the install commands and manifests name the repository, nothing else may.
const PUBLISHER = /just-every\/plugin-recall|github\.com\/just-every|@just-every\/plugin-recall/g;

test("no tracked file or file name carries an owner-specific string", () => {
  const hits = [];
  for (const file of tracked()) {
    if (file === "test/publish-readiness.test.mjs") continue;
    const content = fs.readFileSync(path.join(ROOT, file), "utf8");
    const scan = (label, text) => {
      for (const re of ALWAYS) if (re.test(text)) hits.push(`${file} (${label}): ${re}`);
      if (/just-every/i.test(text.replace(PUBLISHER, ""))) hits.push(`${file} (${label}): just-every outside the publisher's repository path`);
      if (!FLEET_FILES.has(file)) for (const re of FLEET_WORDS) if (re.test(text)) hits.push(`${file} (${label}): ${re}`);
    };
    scan("content", content);
    scan("name", file);
  }
  assert.deepEqual(hits, [], `owner-specific strings reappeared:\n${hits.join("\n")}`);
});

test("the example fleet config is generic like every other tracked file, and it is not packed", needsNpm, () => {
  assert.ok(fs.existsSync(path.join(ROOT, "docs/examples/fleet-config.json")));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("!docs/examples/fleet-config.json"));
  const packed = JSON.parse(npm(["pack", "--dry-run", "--json"], { cwd: ROOT }))[0].files.map((f) => f.path);
  assert.ok(!packed.includes("docs/examples/fleet-config.json"));
});

test("npm pack lists no private file, and every packed file passes the same scan", needsNpm, () => {
  const packed = JSON.parse(npm(["pack", "--dry-run", "--json"], { cwd: ROOT }))[0].files.map((f) => f.path);
  for (const f of packed) {
    assert.ok(!/^(test|evidence)\//.test(f) && !f.includes("node_modules") && !/(^|\/)\.env/.test(f) && !/\.(tgz|log)$/.test(f), `private-looking file packed: ${f}`);
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const re of ALWAYS) assert.ok(!re.test(text), `${f} matches ${re}`);
  }
  for (const must of ["LICENSE", "CHANGELOG.md", "README.md", "skills/recall/SKILL.md", "docs/hosts.md", "docs/evidence.md"]) assert.ok(packed.includes(must), must);
});

test("the version is 0.5.1 everywhere and the changelog has its entry", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.5.1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin/plugin.json"), "utf8")).version, "0.5.1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, ".codex-plugin/plugin.json"), "utf8")).version, "0.5.1");
  assert.match(fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"), /^## 0\.5\.1$/m);
  assert.match(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"), /^MIT License/);
  assert.equal(pkg.license, "MIT");
});

test("the README documents the one-line install and uninstall, the privacy section, the kill switch and the costs", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const needle of [
    "npx -y @just-every/plugin-recall", "npx -y @just-every/plugin-recall uninstall",
    "## Privacy", "## Kill switch", "## Uninstall", "## Costs", "rm -rf ~/.plugin-recall",
  ]) assert.ok(readme.includes(needle), needle);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(pkg.repository.url, /just-every\/plugin-recall\.git$/);
});
