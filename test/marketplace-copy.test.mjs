// Recall's local marketplace: the copy of the running package is exactly what npm packs, both marketplace files point at the versioned copy,
// an identical copy is kept, a different copy of the same version is replaced whole, and old versions are collected.
import test from "node:test";
import assert from "node:assert/strict";
import { needsNpm, npm } from "./npm.mjs";
import fs from "node:fs";
import path from "node:path";
import { collectGarbage, marketplaceStatus, packFiles, versionDir, writeMarketplace } from "../scripts/onboarding/marketplace.mjs";
import { tmpDir } from "./helpers.mjs";
import { ROOT } from "./sandbox.mjs";

const V = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), "utf8"));

test("the copy set is package.json `files` with its negations: the same list `npm pack --dry-run` prints", needsNpm, () => {
  const packed = JSON.parse(npm(["pack", "--dry-run", "--json"], { cwd: ROOT }))[0].files.map((f) => f.path).sort();
  assert.deepEqual(packFiles(ROOT), packed);
  assert.ok(!packFiles(ROOT).includes("docs/examples/fleet-config.json"));
});

test("writeMarketplace: the versioned copy, both marketplace files pointing at it, and a re-run that changes nothing", () => {
  const dataDir = tmpDir("recall-market");
  assert.equal(marketplaceStatus({ dataDir, root: ROOT, V }).copy, "missing");
  const first = writeMarketplace({ dataDir, root: ROOT, V });
  assert.equal(first.copy, "missing");
  const dir = versionDir(dataDir, V);
  for (const f of packFiles(ROOT)) assert.ok(fs.readFileSync(path.join(dir, f)).equals(fs.readFileSync(path.join(ROOT, f))), f);
  assert.ok(fs.statSync(path.join(dir, "bin", "recall")).mode & 0o100, "bin/recall stays executable");
  const M = path.join(dataDir, "marketplace");
  const claude = readJson(M, ".claude-plugin", "marketplace.json");
  assert.equal(claude.name, "plugin-recall");
  assert.deepEqual(claude.plugins.map((p) => [p.name, p.source]), [["recall", `./plugins/recall-${V}`]]);
  const codex = readJson(M, ".agents", "plugins", "marketplace.json");
  assert.equal(codex.name, "plugin-recall");
  assert.deepEqual(codex.plugins[0].source, { source: "local", path: `./plugins/recall-${V}` });
  assert.deepEqual(codex.plugins[0].policy, readJson(ROOT, ".agents", "plugins", "marketplace.json").plugins[0].policy);
  assert.deepEqual(fs.readdirSync(path.join(M, "plugins")), [`recall-${V}`], "no temp directory is left");

  const mtimes = [path.join(dir, "package.json"), path.join(M, ".claude-plugin", "marketplace.json")].map((f) => fs.statSync(f).mtimeMs);
  const status = marketplaceStatus({ dataDir, root: ROOT, V });
  assert.deepEqual([status.copy, status.filesCurrent, status.needsWrite], ["current", true, false]);
  writeMarketplace({ dataDir, root: ROOT, V });
  assert.deepEqual([path.join(dir, "package.json"), path.join(M, ".claude-plugin", "marketplace.json")].map((f) => fs.statSync(f).mtimeMs), mtimes);
  assert.equal(marketplaceStatus({ dataDir, root: dir, V }).copy, "self", "running from the copy itself");
});

test("the same version with other bytes is replaced whole, never edited in place", () => {
  const dataDir = tmpDir("recall-market");
  writeMarketplace({ dataDir, root: ROOT, V });
  const dir = versionDir(dataDir, V);
  fs.appendFileSync(path.join(dir, "README.md"), "\nchanged\n");
  fs.writeFileSync(path.join(dir, "stray.txt"), "left over");
  const inode = fs.statSync(dir).ino;
  assert.equal(marketplaceStatus({ dataDir, root: ROOT, V }).copy, "differs");
  assert.equal(writeMarketplace({ dataDir, root: ROOT, V }).copy, "differs");
  assert.notEqual(fs.statSync(dir).ino, inode, "a new directory took its place");
  assert.ok(!fs.existsSync(path.join(dir, "stray.txt")));
  assert.equal(marketplaceStatus({ dataDir, root: ROOT, V }).copy, "current");
  assert.deepEqual(fs.readdirSync(path.dirname(dir)), [`recall-${V}`]);
});

test("garbage collection keeps this version, the newest older one and any version a home still uses; stale temp directories go", () => {
  const dataDir = tmpDir("recall-market");
  const plugins = path.join(dataDir, "marketplace", "plugins");
  for (const v of ["0.3.0", "0.3.2", "0.4.0", "0.4.1", V, "0.9.0"]) fs.mkdirSync(path.join(plugins, `recall-${v}`), { recursive: true });
  const oldTmp = path.join(plugins, ".recall-0.4.0.tmp-123");
  const freshTmp = path.join(plugins, ".recall-0.4.1.tmp-456");
  fs.mkdirSync(oldTmp);
  fs.mkdirSync(freshTmp);
  const twoHoursAgo = (Date.now() - 2 * 3_600_000) / 1000;
  fs.utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);
  const removed = collectGarbage({ dataDir, V, referenced: new Set(["0.3.0"]) });
  assert.deepEqual(removed.map((p) => path.basename(p)).sort(), [".recall-0.4.0.tmp-123", "recall-0.3.2", "recall-0.4.0", "recall-0.9.0"].sort());
  assert.deepEqual(fs.readdirSync(plugins).sort(), [".recall-0.4.1.tmp-456", "recall-0.3.0", "recall-0.4.1", `recall-${V}`].sort());
  assert.deepEqual(collectGarbage({ dataDir: tmpDir("recall-market-empty"), V }), []);
});
