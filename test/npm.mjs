// npm for the tests that pack the package. The tests run with a PATH that may not hold npm (a sandbox PATH of fake CLIs, a node symlink
// and /usr/bin:/bin), so npm is found the way npm itself says where it is: npm_execpath under `npm test`, else npm on PATH, else the npm
// installed next to this node. A test that needs npm is skipped, with the reason, when none is found.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const executable = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };

/** How to run this npm file: a node script with this node (its `#!/usr/bin/env node` may find no node on a sandbox PATH), else directly. */
function command(file) {
  const real = fs.realpathSync(file);
  const head = fs.readFileSync(real, { encoding: "utf8" }).slice(0, 80);
  return /\.[cm]?js$/.test(real) || /^#!.*\bnode\b/.test(head) ? [process.execPath, real] : [real];
}

function findNpm(env = process.env) {
  const cli = env.npm_execpath;
  if (cli && /npm/.test(path.basename(cli)) && fs.existsSync(cli)) return command(cli);
  const dirs = [...String(env.PATH ?? "").split(path.delimiter).filter(Boolean), path.dirname(process.execPath)];
  const found = dirs.map((d) => path.join(d, "npm")).find(executable);
  return found ? command(found) : null;
}

const NPM = findNpm();

/** `{skip}` for a test that needs npm: false when npm was found, else the reason. */
export const needsNpm = { skip: NPM ? false : "npm not found (no npm_execpath, no npm on PATH or next to node)" };

/** Run npm like execFileSync (a node-script npm runs with this node). */
export function npm(args, opts = {}) {
  if (!NPM) throw new Error(needsNpm.skip);
  const [file, ...pre] = NPM;
  return execFileSync(file, [...pre, ...args], { encoding: "utf8", ...opts });
}
