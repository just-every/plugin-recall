// `recall monitor` as a real process: it prints its address, serves the fixture, refuses non-loopback hosts, never opens a browser, stops on SIGINT.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedMonitorData, treeStamp } from "./monitor-fixture.mjs";
import { tmpDir } from "./helpers.mjs";

const RECALL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "recall.mjs");
const run = (args, env) => spawn(process.execPath, [RECALL, "monitor", ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });

function finished(child) {
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  return new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, out, err })));
}

function started(child) {
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; const m = /Recall Monitor: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out); if (m) resolve(m[1]); });
    child.on("close", (code) => reject(new Error(`exited ${code} before listening: ${out}`)));
  });
}

test("recall monitor: prints the address, serves the data dir read-only, exits cleanly on SIGINT", async () => {
  const dataDir = tmpDir("monitor-cli");
  seedMonitorData(dataDir, { now: new Date() }); // the CLI runs on the real clock, so the fixture is timed back from it
  const before = treeStamp(dataDir);
  const child = run(["--port", "0"], { RECALL_DATA: dataDir });
  const done = finished(child);
  try {
    const url = await started(child);
    const snap = await (await fetch(`${url}api/snapshot?hours=24`)).json();
    assert.equal(snap.dataDir, dataDir);
    assert.ok(snap.turns.length > 0);
    assert.match(await (await fetch(url)).text(), /Recall Monitor/);
  } finally {
    child.kill("SIGINT");
  }
  const { code, out } = await done;
  assert.equal(code, 0);
  assert.match(out, /reading .* \(read-only\)/);
  assert.deepEqual(treeStamp(dataDir), before, "the data dir is untouched");
});

test("recall monitor: --host must be loopback; a bad --port is an error; a taken port says so", async () => {
  const dataDir = tmpDir("monitor-cli");
  const bad = await finished(run(["--host", "0.0.0.0"], { RECALL_DATA: dataDir }));
  assert.equal(bad.code, 1);
  assert.match(bad.err, /loopback only/);
  const badPort = await finished(run(["--port", "http"], { RECALL_DATA: dataDir }));
  assert.equal(badPort.code, 1);
  assert.match(badPort.err, /--port must be an integer/);

  const first = run(["--port", "0"], { RECALL_DATA: dataDir });
  const firstDone = finished(first);
  try {
    const url = await started(first);
    const port = new URL(url).port;
    const second = await finished(run(["--port", port], { RECALL_DATA: dataDir }));
    assert.equal(second.code, 1);
    assert.match(second.err, new RegExp(`port ${port} is already in use`));
  } finally {
    first.kill("SIGINT");
    await firstDone;
  }
});

test("recall monitor appears in the usage text and the README documents it", async () => {
  const usage = await finished(spawn(process.execPath, [RECALL, "help", "--all"], { stdio: ["ignore", "pipe", "pipe"] }));
  assert.match(usage.out, /recall monitor \[--port 4777\] \[--host 127\.0\.0\.1\]/);
  const readme = fs.readFileSync(path.join(path.dirname(RECALL), "..", "README.md"), "utf8");
  assert.match(readme, /^## Monitor$/m);
  assert.match(readme, /recall monitor --port 4800/);
});
