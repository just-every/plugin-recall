// Node 22 prints "ExperimentalWarning: SQLite is an experimental feature..." when node:sqlite loads; Node 24+ does not. A user sees that
// line on every command and hook run, so the entry points drop that one warning (scripts/lib/quiet-sqlite-warning.mjs) and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V1_ENV } from "../scripts/lib/config.mjs";
import { readFixture, seedIndex, startFakeServer, tmpDir } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(args, { stdin = "", env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test("bin/recall --version prints the version and nothing on stderr", async () => {
  const home = tmpDir("recall-quiet-home");
  const r = await run([path.join(ROOT, "bin", "recall"), "--version"], { env: { HOME: home } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal(r.stderr, "");
});

test("the hook script, run all the way through the question cache (node:sqlite opened), prints nothing on stderr", async () => {
  const server = await startFakeServer();
  try {
    const dataDir = tmpDir("recall-quiet-data");
    await seedIndex((await import("../scripts/lib/store.mjs")).createStore(dataDir), [
      { id: "h1", ts: "2026-09-01T10:00:00Z", text: "We want a proper fix, no fallback things. Do not add random limits, fix the code structure instead.", repo: "shared-lib" },
    ]);
    const env = { ...V1_ENV, RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", OPENAI_API_KEY: "sk-test", RECALL_OPENAI_BASE_URL: server.url, RECALL_DAILY_CAP_USD: "5", RECALL_ALLOW_HEADLESS: "1", HOME: dataDir };
    const prompt = "The duplicate draft runs come from a re-execution path, so I will add a fallback path with a random limit to stop them.";
    const payload = { ...JSON.parse(readFixture("hook-inputs", "claude-prompt.json")), prompt };
    const r = await run([path.join(ROOT, "scripts", "user-prompt-submit.mjs")], { stdin: JSON.stringify(payload), env });
    assert.equal(r.code, 0);
    assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, "the hook injected context, so the judge path (and the cache) ran");
    assert.equal(r.stderr, "");
  } finally {
    await server.close();
  }
});

test("only the SQLite ExperimentalWarning is dropped; any other warning still reaches stderr", async () => {
  const script = `
    import ${JSON.stringify(path.join(ROOT, "scripts/lib/quiet-sqlite-warning.mjs"))};
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    process.emitWarning("SQLite is an experimental feature and might change at any time", { type: "ExperimentalWarning" });
    process.emitWarning(Object.assign(new Error("SQLite is an experimental feature and might change at any time"), { name: "ExperimentalWarning" }));
    process.emitWarning("Another thing is experimental", "ExperimentalWarning");
    process.emitWarning("SQLite is something else entirely");
  `;
  const r = await run(["--input-type=module", "-e", script]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stderr, /SQLite is an experimental/);
  assert.match(r.stderr, /ExperimentalWarning: Another thing is experimental/);
  assert.match(r.stderr, /Warning: SQLite is something else entirely/);
});
