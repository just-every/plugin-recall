// `recall` must run the way a new user gets it: npm links the bin file as a symlink (npm install -g, npx), Claude Code puts bin/ on PATH as a real file.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./helpers.mjs";
import { needsNpm, npm } from "./npm.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (file, args, home) => execFileSync(file, args, { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, RECALL_DATA: path.join(home, ".plugin-recall") } });

test("bin/recall run through a symlink finds the package", () => {
  const dir = tmpDir("recall-bin");
  const link = path.join(dir, "recall");
  fs.symlinkSync(path.join(ROOT, "bin", "recall"), link);
  assert.match(run(link, ["pipelines"], dir), /^embeddings$/m);
  // a relative symlink chain, as npm's `node_modules/.bin` makes it
  const nested = path.join(dir, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  fs.symlinkSync(link, path.join(nested, "recall"));
  assert.match(run(path.join(nested, "recall"), ["pipelines"], dir), /^default$/m);
});

test("the packed tarball installs with npm install -g and runs as `recall`", needsNpm, () => {
  const dir = tmpDir("recall-pack");
  const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", dir], { cwd: ROOT }))[0].filename;
  const prefix = path.join(dir, "prefix");
  npm(["install", "-g", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", path.join(dir, packed)], { stdio: "pipe" });
  const bin = path.join(prefix, "bin", "recall");
  assert.ok(fs.lstatSync(bin).isSymbolicLink(), "npm links the bin file");
  assert.match(run(bin, ["pipelines"], dir), /^default\+rerank$/m);
  const doctor = (() => { try { return run(bin, ["doctor"], dir); } catch (e) { return e.stdout; } })();
  assert.match(doctor, /plugin-recall 0\.5\.1/);
});
