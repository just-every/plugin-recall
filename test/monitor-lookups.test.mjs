// "Agent looked up context": the `show` lines `recall show` writes are counted and listed by the monitor, are not turns, and the candidates
// carry their transcript source. The data dir is the monitor fixture plus show lines; nothing here calls anything.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dayCounters } from "../scripts/monitor/counters.mjs";
import { createMonitorState } from "../scripts/monitor/state.mjs";
import { srcLabel } from "../scripts/monitor/static/format.js";
import { NOW, jsonl, seedMonitorData } from "./monitor-fixture.mjs";
import { tmpDir } from "./helpers.mjs";

const at = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
const show = (mins, id, extra = {}) => ({ ts: at(mins), level: "info", event: "show", statement_id: id, cwd: "/home/sam/projects/project-9", project: "project-9", session_id: "sess-9", before: 4, after: 3, ...extra });
const dayFile = (dataDir, ts) => path.join(dataDir, "logs", `turns-${ts.slice(0, 10)}.jsonl`);
const append = (dataDir, lines) => { for (const l of lines) fs.appendFileSync(dayFile(dataDir, l.ts), jsonl([l])); };

function world() {
  const dataDir = tmpDir("monitor-lookups");
  seedMonitorData(dataDir);
  const state = createMonitorState({ dataDir, env: { RECALL_DATA: dataDir }, now: () => NOW });
  return { dataDir, state };
}

test("show lines are counted as lookups, listed with the statement they were about, and never become turns or hook firings", () => {
  const plain = world();
  plain.state.poll({ replay: true });
  const base = plain.state.snapshot();

  const w = world();
  append(w.dataDir, [show(40, "claude-aaa"), show(12, "codex-bbb", { session_id: null }), show(2, "claude-gone")]);
  w.state.poll({ replay: true });
  const snap = w.state.snapshot();
  assert.equal(snap.turns.length, base.turns.length, "no turn for a show line");
  assert.equal(snap.summary.counters.fired, base.summary.counters.fired, "not a hook firing");
  assert.equal(snap.summary.counters.lookedUp, 3);
  assert.equal(base.summary.counters.lookedUp, 0);
  const [newest, middle, oldest] = snap.summary.lookups;
  assert.deepEqual([newest.statement_id, newest.text, newest.src], ["claude-gone", null, null], "an id the index does not hold is listed by id");
  assert.deepEqual([middle.statement_id, middle.text, middle.repo, middle.host, middle.src, middle.session_id], ["codex-bbb", "Do not take focus when you open the browser.", "design-kit", "codex", "x:L2", null]);
  assert.deepEqual([oldest.statement_id, oldest.project, oldest.session_id, oldest.cwd], ["claude-aaa", "project-9", "sess-9", "/home/sam/projects/project-9"]);
  assert.equal(snap.reasons.length, base.reasons.length, "no skip reason for a show line");
});

test("a lookup that happens while the monitor runs pushes a summary with the new count, and no turn", () => {
  const w = world();
  w.state.poll({ replay: true });
  const events = [];
  w.state.subscribe((e) => events.push(e));
  append(w.dataDir, [show(1, "claude-aaa")]);
  assert.equal(w.state.poll(), true);
  assert.deepEqual(events.map((e) => e.type), ["summary"]);
  assert.equal(events[0].summary.counters.lookedUp, 1);
  assert.equal(events[0].summary.lookups[0].statement_id, "claude-aaa");
});

test("the counter is per UTC day; the list keeps the newest eight", () => {
  const lookups = [{ ts: "2026-10-08T01:00:00.000Z" }, { ts: "2026-10-07T23:00:00.000Z" }];
  assert.equal(dayCounters([], "2026-10-08", lookups).lookedUp, 1);
  assert.equal(dayCounters([], "2026-10-08").lookedUp, 0);
  const w = world();
  append(w.dataDir, Array.from({ length: 11 }, (_, i) => show(30 - i, "claude-aaa")));
  w.state.poll({ replay: true });
  const s = w.state.summary();
  assert.equal(s.counters.lookedUp, 11);
  assert.equal(s.lookups.length, 8);
  assert.ok(s.lookups[0].ts > s.lookups[7].ts, "newest first");
});

test("the index rows the monitor serves carry the statement's src (the candidates table and the injected cards show it)", () => {
  const w = world();
  w.state.poll({ replay: true });
  assert.deepEqual(w.state.statements(["claude-aaa", "codex-ccc"]).map((r) => [r.id, r.src]), [["claude-aaa", "x:L1"], ["codex-ccc", "x:L3"]]);
});

test("the page writes a source with ~ for the home dir the monitor reports, and only for that exact directory", () => {
  const home = "/home/sam";
  assert.equal(srcLabel("/home/sam/.codex/sessions/2026/09/12/rollout-x.jsonl.zst:L1234", home), "~/.codex/sessions/2026/09/12/rollout-x.jsonl.zst:L1234");
  assert.equal(srcLabel("/home/sam/.claude/projects/p/s.jsonl:L9", "/home/sam/"), "~/.claude/projects/p/s.jsonl:L9");
  assert.equal(srcLabel("/home/samuel/.claude/projects/p/s.jsonl:L9", home), "/home/samuel/.claude/projects/p/s.jsonl:L9", "a sibling directory is not the home");
  assert.equal(srcLabel("/home/sam/.claude/projects/p/s.jsonl:L9"), "/home/sam/.claude/projects/p/s.jsonl:L9", "no home known: the path as it is");
  assert.equal(srcLabel("x:L1", home), "x:L1");
  assert.equal(srcLabel(null, home), "");
});

test("the snapshot names the monitor's home dir, so the page can write ~", () => {
  const w = world();
  assert.equal(w.state.snapshot().homeDir, os.homedir());
  const dataDir = tmpDir("monitor-home");
  seedMonitorData(dataDir);
  const state = createMonitorState({ dataDir, env: { RECALL_DATA: dataDir }, now: () => NOW, homedir: "/home/sam" });
  assert.equal(state.snapshot().homeDir, "/home/sam");
});
