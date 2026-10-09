// The log tailer: append, a partial last line, multi-byte characters across reads, truncation, replacement, and the day rollover.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTailer } from "../scripts/monitor/tailer.mjs";
import { createTurnLogWatcher } from "../scripts/monitor/turn-log-watcher.mjs";
import { tmpDir } from "./helpers.mjs";

function collect(file) {
  const got = { lines: [], bad: [], resets: 0 };
  const tailer = createTailer(file, { onLine: (l) => got.lines.push(l), onBad: (r) => got.bad.push(r), onReset: () => { got.resets++; got.lines.length = 0; } });
  return { got, tailer };
}

test("tailer: lines appended later arrive once, in order; a file that does not exist yet is empty", () => {
  const f = path.join(tmpDir("tail"), "a.jsonl");
  const { got, tailer } = collect(f);
  assert.equal(tailer.poll(), 0);
  fs.writeFileSync(f, '{"n":1}\n{"n":2}\n');
  assert.equal(tailer.poll(), 2);
  assert.equal(tailer.poll(), 0, "nothing new, nothing delivered");
  fs.appendFileSync(f, '{"n":3}\n');
  assert.equal(tailer.poll(), 1);
  assert.deepEqual(got.lines.map((l) => l.n), [1, 2, 3]);
});

test("tailer: a partial last line waits for its newline, however many polls see it", () => {
  const f = path.join(tmpDir("tail"), "a.jsonl");
  const { got, tailer } = collect(f);
  fs.writeFileSync(f, '{"n":1}\n{"n":');
  tailer.poll();
  assert.deepEqual(got.lines.map((l) => l.n), [1]);
  tailer.poll();
  fs.appendFileSync(f, '2,"s":"half"');
  tailer.poll();
  assert.deepEqual(got.lines.map((l) => l.n), [1], "still incomplete");
  fs.appendFileSync(f, "}\n");
  tailer.poll();
  assert.deepEqual(got.lines.map((l) => l.n), [1, 2]);
  assert.deepEqual(got.bad, [], "a partial line is not a corrupt line");
});

test("tailer: a multi-byte character cut by a poll boundary is not mangled", () => {
  const f = path.join(tmpDir("tail"), "a.jsonl");
  const { got, tailer } = collect(f);
  const bytes = Buffer.from('{"t":"café → ok"}\n');
  const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of the e-acute
  fs.writeFileSync(f, bytes.subarray(0, cut));
  tailer.poll();
  fs.appendFileSync(f, bytes.subarray(cut));
  tailer.poll();
  assert.deepEqual(got.lines, [{ t: "café → ok" }]);
});

test("tailer: a corrupt line is reported and skipped, the lines around it still arrive", () => {
  const f = path.join(tmpDir("tail"), "a.jsonl");
  const { got, tailer } = collect(f);
  fs.writeFileSync(f, '{"n":1}\nnot json\n\n{"n":2}\n');
  tailer.poll();
  assert.deepEqual(got.lines.map((l) => l.n), [1, 2]);
  assert.deepEqual(got.bad, ["not json"]);
});

test("tailer: truncation fires onReset and the file is read again from the start", () => {
  const f = path.join(tmpDir("tail"), "a.jsonl");
  const { got, tailer } = collect(f);
  fs.writeFileSync(f, '{"n":1}\n{"n":2}\n{"n":3}\n');
  tailer.poll();
  fs.writeFileSync(f, '{"n":9}\n');
  tailer.poll();
  assert.equal(got.resets, 1);
  assert.deepEqual(got.lines.map((l) => l.n), [9]);
  fs.appendFileSync(f, '{"n":10}\n');
  tailer.poll();
  assert.deepEqual(got.lines.map((l) => l.n), [9, 10]);
});

test("tailer: a file replaced by a longer one with different content is a reset, not a continuation", () => {
  const f = path.join(tmpDir("tail"), "a.jsonl");
  const { got, tailer } = collect(f);
  fs.writeFileSync(f, '{"n":1}\n');
  tailer.poll();
  fs.writeFileSync(f, '{"x":"a much longer replacement line"}\n{"x":2}\n'); // same inode, bigger than the old offset
  tailer.poll();
  assert.equal(got.resets, 1);
  assert.deepEqual(got.lines.map((l) => l.x), ["a much longer replacement line", 2]);
});

test("tailer: a deleted file that comes back is a reset", () => {
  const f = path.join(tmpDir("tail"), "a.jsonl");
  const { got, tailer } = collect(f);
  fs.writeFileSync(f, '{"n":1}\n');
  tailer.poll();
  fs.rmSync(f);
  tailer.poll();
  assert.equal(got.resets, 1);
  fs.writeFileSync(f, '{"n":2}\n');
  tailer.poll();
  assert.deepEqual(got.lines.map((l) => l.n), [2]);
});

function watch(dataDir, clock) {
  const lines = [];
  const meta = { resets: 0 };
  const watcher = createTurnLogWatcher({ dataDir, now: () => clock.now, retainDays: 7, onLine: (l, ctx) => lines.push([l.n, ctx.replay]), onReset: () => { meta.resets++; lines.length = 0; } });
  return { watcher, lines, meta };
}
const logFile = (dataDir, day) => path.join(dataDir, "logs", `turns-${day}.jsonl`);

test("watcher: the UTC day rolls over: the old file is drained to its end, the new one is read from byte 0", () => {
  const dataDir = tmpDir("watch");
  fs.mkdirSync(path.join(dataDir, "logs"));
  const clock = { now: new Date("2026-10-08T23:59:58Z") };
  const { watcher, lines } = watch(dataDir, clock);
  fs.writeFileSync(logFile(dataDir, "2026-10-08"), '{"n":1}\n');
  watcher.poll({ replay: true });
  assert.deepEqual(lines, [[1, true]]);
  // the last line of the old day lands after midnight has passed on the clock, and the new day's first line follows at once
  clock.now = new Date("2026-10-09T00:00:01Z");
  fs.appendFileSync(logFile(dataDir, "2026-10-08"), '{"n":2}\n');
  fs.writeFileSync(logFile(dataDir, "2026-10-09"), '{"n":3}\n');
  watcher.poll();
  assert.deepEqual(lines.map((l) => l[0]), [1, 2, 3]);
  assert.deepEqual(lines.slice(1), [[2, false], [3, false]], "live lines are not marked as replay");
  fs.appendFileSync(logFile(dataDir, "2026-10-09"), '{"n":4}\n');
  fs.appendFileSync(logFile(dataDir, "2026-10-08"), '{"n":5}\n');
  watcher.poll();
  assert.deepEqual(lines.map((l) => l[0]).sort(), [1, 2, 3, 4, 5]);
});

test("watcher: files older than the retention window are ignored, in-window older days are read once at start", () => {
  const dataDir = tmpDir("watch");
  fs.mkdirSync(path.join(dataDir, "logs"));
  const clock = { now: new Date("2026-10-20T12:00:00Z") };
  fs.writeFileSync(logFile(dataDir, "2026-10-01"), '{"n":1}\n');
  fs.writeFileSync(logFile(dataDir, "2026-10-15"), '{"n":2}\n');
  fs.writeFileSync(logFile(dataDir, "2026-10-20"), '{"n":3}\n');
  const { watcher, lines } = watch(dataDir, clock);
  watcher.poll({ replay: true });
  assert.deepEqual(lines.map((l) => l[0]).sort(), [2, 3]);
});

test("watcher: truncating one day file clears the consumer once and re-reads every file, with no duplicates", () => {
  const dataDir = tmpDir("watch");
  fs.mkdirSync(path.join(dataDir, "logs"));
  const clock = { now: new Date("2026-10-09T06:00:00Z") };
  fs.writeFileSync(logFile(dataDir, "2026-10-08"), '{"n":1}\n{"n":2}\n');
  fs.writeFileSync(logFile(dataDir, "2026-10-09"), '{"n":3}\n{"n":4}\n');
  const { watcher, lines, meta } = watch(dataDir, clock);
  watcher.poll({ replay: true });
  assert.deepEqual(lines.map((l) => l[0]).sort(), [1, 2, 3, 4]);
  fs.writeFileSync(logFile(dataDir, "2026-10-09"), '{"n":30}\n');
  watcher.poll();
  assert.equal(meta.resets, 1);
  assert.deepEqual(lines.map((l) => l[0]).sort((a, b) => a - b), [1, 2, 30], "the other day was read again, the truncated one holds its new content");
  fs.rmSync(logFile(dataDir, "2026-10-08"));
  watcher.poll();
  assert.equal(meta.resets, 2, "deleting a file inside the window is a reset too");
  assert.deepEqual(lines.map((l) => l[0]), [30]);
});
