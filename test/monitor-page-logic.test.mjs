// The page's pure logic (grouping skips into runs, filters, formatting), run in Node: these modules touch no DOM at import.
import test from "node:test";
import assert from "node:assert/strict";
import { ago, clip, dur, score, sourceName, usd } from "../scripts/monitor/static/format.js";
import { feedItems, matches } from "../scripts/monitor/static/selectors.js";

const turn = (id, ts, over = {}) => ({ id, ts, updated: ts, session_id: `s-${id}`, host: "claude", home: "~/.claude_work", project: "p", query: null, prompt: { kind: "injected", ts }, stop: null, skip: false, ...over });

test("feedItems: consecutive pure skips collapse into one run; a card between them splits the runs; showing skips keeps every turn", () => {
  const turns = [turn("1", "5", { skip: true }), turn("2", "4", { skip: true }), turn("3", "3"), turn("4", "2", { skip: true }), turn("5", "1")];
  const items = feedItems(turns, false);
  assert.deepEqual(items.map((i) => [i.kind, i.kind === "run" ? i.turns.map((t) => t.id) : i.turn.id]), [["run", ["1", "2"]], ["card", "3"], ["run", ["4"]], ["card", "5"]]);
  assert.deepEqual(feedItems(turns, true).map((i) => i.kind), ["card", "card", "card", "card", "card"]);
  assert.deepEqual(feedItems([], false), []);
});

test("matches: host, home and a text search over the query, project and home", () => {
  const t = turn("1", "1", { query: "Add a Fallback path", project: "plugin-recall", host: "codex", home: "~/.codex_work" });
  const f = (over) => ({ host: "", home: "", q: "", ...over });
  assert.ok(matches(t, f({})));
  assert.ok(matches(t, f({ host: "codex" })) && !matches(t, f({ host: "claude" })));
  assert.ok(matches(t, f({ home: "~/.codex_work" })) && !matches(t, f({ home: "~/.claude_work" })));
  assert.ok(matches(t, f({ q: "fallback" })) && matches(t, f({ q: "  PLUGIN-recall " })) && !matches(t, f({ q: "nothing like it" })));
  assert.ok(!matches(turn("2", "1", { query: null, project: null, home: null }), f({ q: "x" })), "a turn with no query and no project has nothing to match");
});

test("formatting: money, durations, scores, relative times, clipping, sources", () => {
  assert.deepEqual([usd(0), usd(0.0043), usd(0.07), usd(5), usd(null)], ["$0", "$0.0043", "$0.07", "$5.00", ""]);
  assert.deepEqual([dur(420), dur(1840), dur(14_000), dur(null)], ["420 ms", "1.8 s", "14 s", ""]);
  assert.deepEqual([score(0.7712), score(undefined)], ["0.77", "–"]);
  const now = Date.parse("2026-10-08T01:00:00Z");
  assert.deepEqual(["2026-10-08T00:59:58Z", "2026-10-08T00:59:30Z", "2026-10-08T00:55:00Z", "2026-10-07T22:00:00Z", "2026-10-05T01:00:00Z"].map((t) => ago(t, now)), ["just now", "30 s ago", "5 min ago", "3 h ago", "3 d ago"]);
  assert.equal(clip("a   b\n c", 10), "a b c");
  assert.equal(clip("x".repeat(200), 160).length, 161);
  assert.deepEqual([sourceName("file"), sourceName("env"), sourceName("default")], ["config.json", "environment", "built-in default"]);
});

test("index.html carries no inline event handlers or scripts: the page's CSP is script-src 'self' and would log a violation for each", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../scripts/monitor/static/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i);
});
