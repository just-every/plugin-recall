// A sandbox for the installer tests: a temp HOME with synthetic agent homes (transcripts of both hosts), a PATH that holds only the fake CLIs,
// a directory with a `node` symlink and /usr/bin:/bin (never the real CLIs), and `recall` run as a child process in it. No real home is read.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packFiles } from "../scripts/onboarding/marketplace.mjs";
import { FIXTURES, tmpDir } from "./helpers.mjs";
import { claudeUser } from "./transcript-builders.mjs";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const KEY = "sk-test-sandbox-key-0001";
export const STATEMENTS = [
  "Hello, this is the opening message of the session.",
  "Never add a fallback path when fixing a bug, show me the real failure instead.",
  "Please keep the commit messages short and in the imperative mood.",
];

let nodeDir = null;
/** A directory holding only a `node` symlink, so PATH never needs the directory node is installed in. */
export function nodeOnlyDir() {
  if (nodeDir) return nodeDir;
  nodeDir = tmpDir("recall-node-bin");
  fs.symlinkSync(process.execPath, path.join(nodeDir, "node"));
  return nodeDir;
}

/** A Claude Code home with one session of the given statements (and `.claude.json`, which marks a sibling home). */
export function addClaudeHome(home, name = ".claude", statements = STATEMENTS) {
  const dir = path.join(home, name);
  const proj = path.join(dir, "projects", "-home-sam-projects-demo");
  fs.mkdirSync(proj, { recursive: true });
  const day = (i) => `2026-01-0${(i % 9) + 1}T10:00:00.000Z`;
  const session = `5aaa0000-0000-4000-8000-${Buffer.from(name).toString("hex").slice(-12).padStart(12, "0")}`; // one session per home
  fs.writeFileSync(path.join(proj, `${session}.jsonl`), `${statements.map((t, i) => claudeUser(t, day(i))).join("\n")}\n`);
  fs.writeFileSync(path.join(dir, ".claude.json"), "{}");
  return dir;
}

/** A Codex home with one synthetic rollout (and config.toml, which marks a sibling home). */
export function addCodexHome(home, name = ".codex") {
  const dir = path.join(home, name);
  const sessions = path.join(dir, "sessions", "2026", "09", "02");
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = "rollout-2026-09-02T15-02-46-0190a000-aaaa-7000-8000-00000000c001.jsonl";
  fs.copyFileSync(path.join(FIXTURES, "codex", "sessions", "2026", "09", "02", rollout), path.join(sessions, rollout));
  fs.writeFileSync(path.join(dir, "config.toml"), "");
  return dir;
}

/** A fresh HOME with the named homes of each host. */
export function sandboxHome({ claude = [".claude"], codex = [".codex"], everyCode = false } = {}) {
  const home = tmpDir("recall-sandbox-home");
  for (const n of claude) addClaudeHome(home, n);
  for (const n of codex) addCodexHome(home, n);
  if (everyCode) fs.mkdirSync(path.join(home, ".code"));
  return home;
}

/** Run `recall <args>` (or another script) in the sandbox, from `cwd` (default: this process's); resolves {code, stdout, stderr}. */
export function recall(args, { home, clis, env = {}, stdin = "", cwd, script = path.join(ROOT, "scripts", "recall.mjs") }) {
  const PATH = [clis?.dir, nodeOnlyDir(), "/usr/bin", "/bin"].filter(Boolean).join(path.delimiter);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { PATH, HOME: home, ...env }, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

export const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Wait until the background card writer that setup started has finished (its log holds the enrich result, or an error). */
export async function waitForCards(dataDir, { timeoutMs = 20000 } = {}) {
  const log = path.join(dataDir, "logs", "setup-enrich.log");
  const t0 = Date.now();
  for (;;) {
    const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    if (/"failed": \[/.test(text) || /recall enrich: /.test(text)) return text;
    if (Date.now() - t0 > timeoutMs) throw new Error(`the background card writer did not finish:\n${text}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Every file under `dir` with its size and mtime, to prove a run wrote nothing. */
export function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = fs.lstatSync(p); out[path.relative(dir, p)] = `${s.size}:${s.mtimeMs}`; }
    }
  };
  walk(dir);
  return out;
}

/** A server that accepts every key (GET /v1/models) and answers POST /v1/decisions with `status`; it counts the POSTs. */
export async function decisionsStatusServer(status) {
  const posts = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method !== "GET") posts.push(req.url);
      res.writeHead(req.method === "GET" ? 200 : status, { "content-type": "application/json" });
      res.end(req.method === "GET" ? '{"data":[]}' : JSON.stringify({ error: { message: `HTTP ${status}` } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, posts, close: () => new Promise((r) => server.close(r)) };
}

/** A local URL nothing listens on. */
export async function closedUrl() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

/** A copy of this package as npm would pack it, at another version (package.json and both plugin.json files), as a newer release would be. */
export function packageAtVersion(version) {
  const dir = tmpDir("recall-package");
  for (const f of packFiles(ROOT)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    fs.chmodSync(path.join(dir, f), fs.statSync(path.join(ROOT, f)).mode & 0o777);
  }
  for (const f of ["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    const file = path.join(dir, f);
    fs.writeFileSync(file, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), version }, null, 2)}\n`);
  }
  return dir;
}
