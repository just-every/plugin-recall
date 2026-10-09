// Pairing hook lines into turns.
import test from "node:test";
import assert from "node:assert/strict";
import { createPairer } from "../scripts/monitor/pairer.mjs";

const line = (event, ts, session, turnKey, extra = {}) => ({ ts, level: "info", event, session_id: session, turn_key: turnKey, outcome: "silent", ...extra });
const feed = (lines) => { const p = createPairer(); for (const l of lines) p.add(l); return p; };
const shape = (p) => p.turns().map((t) => [t.prompt?.ts ?? null, t.stops.map((s) => s.ts)]);

test("a prompt and the Stop with the same session and turn_key are one turn, however other sessions interleave", () => {
  const p = feed([
    line("prompt", "t1", "A", "k1"), line("prompt", "t2", "B", "k1"),
    line("stop", "t3", "B", "k1"), line("stop", "t4", "A", "k1"),
  ]);
  assert.deepEqual(shape(p), [["t1", ["t4"]], ["t2", ["t3"]]], "the same turn_key in two sessions is two turns");
});

test("Recall's own block: the follow-up Stop carries the same turn_key and joins the same turn", () => {
  const p = feed([line("prompt", "t1", "A", "k1"), line("stop", "t2", "A", "k1", { outcome: "blocked" }), line("stop", "t3", "A", "k1", { reason: "stop-hook-active" })]);
  assert.deepEqual(shape(p), [["t1", ["t2", "t3"]]]);
});

test("without a turn_key, a Stop pairs with the nearest preceding prompt of its session that has no Stop yet", () => {
  const p = feed([
    line("prompt", "t1", "A", null), line("prompt", "t2", "B", null), line("stop", "t3", "A", null), line("prompt", "t4", "A", null), line("stop", "t5", "A", null), line("stop", "t6", "B", null),
  ]);
  assert.deepEqual(shape(p), [["t1", ["t3"]], ["t2", ["t6"]], ["t4", ["t5"]]]);
});

test("an interrupted prompt (no Stop) stays Stop-less; the next Stop belongs to the newest prompt", () => {
  const p = feed([line("prompt", "t1", "A", null), line("prompt", "t2", "A", null), line("stop", "t3", "A", null)]);
  assert.deepEqual(shape(p), [["t1", []], ["t2", ["t3"]]]);
});

test("a Stop without a turn_key pairs with a keyed prompt of its session; a keyed Stop never steals a differently keyed prompt", () => {
  const a = feed([line("prompt", "t1", "A", "k1"), line("stop", "t2", "A", null)]);
  assert.deepEqual(shape(a), [["t1", ["t2"]]]);
  const b = feed([line("prompt", "t1", "A", "k1"), line("stop", "t2", "A", "other")]);
  assert.deepEqual(shape(b), [["t1", []], [null, ["t2"]]], "a stop of an unknown turn is a turn of its own");
});

test("a Stop whose prompt is not in the log is a turn of its own, and a late prompt with that turn_key joins it", () => {
  const p = feed([line("stop", "t2", "A", "k1")]);
  assert.deepEqual(shape(p), [[null, ["t2"]]]);
  p.add(line("prompt", "t1", "A", "k1"));
  assert.deepEqual(shape(p), [["t1", ["t2"]]]);
});

test("lines without a session (crash, background index) are turns of their own and never pair", () => {
  const p = feed([line("prompt", "t1", undefined, undefined, { reason: "hook-crashed" }), line("auto-index", "t2", undefined, undefined, { level: "error" }), line("stop", "t3", undefined, undefined)]);
  assert.equal(p.size, 3);
});

test("add() returns the turn the line landed in; ids are unique and stable; prune drops only old turns", () => {
  const p = createPairer();
  const a = p.add(line("prompt", "2026-10-08T01:00:00Z", "A", "k1"));
  const again = p.add(line("stop", "2026-10-08T01:00:05Z", "A", "k1"));
  assert.equal(a, again);
  const b = p.add(line("prompt", "2026-10-08T05:00:00Z", "A", "k2"));
  assert.notEqual(a.id, b.id);
  assert.equal(p.get(a.id), a);
  p.prune("2026-10-08T03:00:00Z");
  assert.deepEqual(p.turns().map((t) => t.id), [b.id]);
  p.add(line("stop", "2026-10-08T05:00:09Z", "A", "k2")); // still pairs after pruning an unrelated turn
  assert.equal(p.turns()[0].stops.length, 1);
  p.clear();
  assert.equal(p.size, 0);
});
