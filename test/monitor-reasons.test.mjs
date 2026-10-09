// Plain-language labels: every reason the hooks can emit has one, and the chips say what the brief asks.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activeSessions, dayCounters, reasonCounts } from "../scripts/monitor/counters.mjs";
import { describeHalf, viewTurn } from "../scripts/monitor/describe.mjs";
import { GROUPS, reasonInfo } from "../scripts/monitor/reasons.mjs";

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lib");
const src = (f) => fs.readFileSync(path.join(LIB, f), "utf8");

/** Every reason string the hook code can write, found in the source: no list to keep in step by hand. Template parts become "X". */
function emittedReasons() {
  const found = new Set();
  const add = (s) => found.add(s.replace(/\$\{[^}]*\}/g, "X"));
  const quoted = String.raw`("[^"\n]+"|` + "`[^`\\n]+`" + String.raw`)`;
  const strip = (q) => q.slice(1, -1);
  for (const file of ["prompt-hook.mjs"]) {
    const text = src(file);
    for (const m of text.matchAll(new RegExp(String.raw`silent\(\s*` + quoted, "g"))) add(strip(m[1]));
    for (const m of text.matchAll(new RegExp(String.raw`reason: ` + quoted, "g"))) add(strip(m[1]));
    for (const m of text.matchAll(new RegExp(String.raw`reason: [^?\n]*\? ` + quoted + String.raw` : ` + quoted, "g"))) { add(strip(m[1])); add(strip(m[2])); }
    for (const m of text.matchAll(new RegExp(String.raw`silent\([^"` + "`" + String.raw`]*\? ` + quoted + String.raw` : ` + quoted, "g"))) { add(strip(m[1])); add(strip(m[2])); }
  }
  for (const file of ["config-error.mjs", "cap-guard.mjs", "../user-prompt-submit.mjs"]) for (const m of src(file).matchAll(new RegExp(String.raw`reason: ` + quoted, "g"))) add(strip(m[1]));
  for (const m of src("headless.mjs").matchAll(new RegExp(String.raw`verdict\(false, ` + quoted, "g"))) add(strip(m[1]));
  for (const file of ["owner-filter.mjs", "text-filter/owner-text.mjs"]) for (const m of src(file).matchAll(new RegExp(String.raw`\{ reason: ` + quoted + String.raw` \}`, "g"))) add(`not-owner-text:${strip(m[1])}`);
  // the rule modules return their reason as a bare string
  for (const file of ["text-filter/harness.mjs", "text-filter/fleet.mjs"]) for (const m of src(file).matchAll(new RegExp(String.raw`return ` + quoted + ";", "g"))) add(`not-owner-text:${strip(m[1])}`);
  // `not-owner-text:${judged.reason}` is how the prompt hook turns the filter's reason into a silence reason; the filter's own reasons were added above
  return [...found].filter((r) => !/^not-owner-text:\$?X$/.test(r) && r !== "X");
}

test("the source scan finds the reasons it should (guards the scan itself)", () => {
  const found = emittedReasons();
  for (const expected of ["disabled", "child", "subagent", "no-prompt", "cap-reached", "empty-index", "no-cards", "retrieval-failed", "nothing-above-threshold", "config-invalid", "hook-crashed", "headless:claude-unattended", "unknown:claude-no-attendance-signal", "not-owner-text:agent-completion", "not-owner-text:too-short", "not-owner-text:skill-invocation"]) {
    assert.ok(found.includes(expected), `the scan did not find ${expected}; found ${found.join(", ")}`);
  }
  assert.ok(found.length >= 45, `only ${found.length} reasons found`);
});

test("every reason the hooks can emit has a plain-language label (no fallthrough to the raw string)", () => {
  for (const reason of emittedReasons()) {
    const info = reasonInfo(reason);
    assert.ok(info.known, `no label for the reason ${JSON.stringify(reason)}`);
    assert.ok(info.label && info.label !== reason && info.detail, `${reason} has no wording`);
    assert.ok(GROUPS[info.group], `${reason} has an unknown group ${info.group}`);
    assert.match(info.kind, /^(skip|empty|audited|capped|error)$/);
  }
});

test("reason wording: the brief's examples and the families", () => {
  assert.equal(reasonInfo("not-owner-text:agent-completion").label, "a sub-agent reported back");
  assert.equal(reasonInfo("not-owner-text:agent-completion").group, "subagent");
  assert.equal(reasonInfo("headless:claude-session-kind-bg").label, "a background Claude session (bg)");
  assert.match(reasonInfo("unknown:codex-no-rollout").label, /cannot tell whether a person is typing/);
  assert.equal(reasonInfo("not-owner-text:automation-heartbeat").group, "not-owner");
  assert.equal(reasonInfo("no-such-reason").known, false);
  assert.equal(reasonInfo("no-such-reason").label, "no-such-reason", "an unknown reason is shown raw, never hidden");
  assert.equal(reasonInfo(null).known, false);
});

const BARS = { promptThreshold: 0.95, stopThreshold: 0.9 };
const L = (over) => ({ ts: "2026-10-08T01:00:00.000Z", level: "info", session_id: "s", turn_key: "k", ...over });

test("chips: Injected 3, Nothing above 0.95, Skipped: a sub-agent reported back, Audited 5 · best 0.77 / 0.9, Blocked", () => {
  assert.equal(describeHalf(L({ event: "prompt", outcome: "injected", injected: ["a", "b", "c"], latency_ms: 1840, stats: { costUsd: 0.004, embedCostUsd: 0.0003 } }), BARS).label, "Injected 3");
  const inj = describeHalf(L({ event: "prompt", outcome: "injected", injected: ["a"], latency_ms: 1840, stats: { costUsd: 0.004, embedCostUsd: 0.0003 } }), BARS);
  assert.deepEqual([inj.kind, inj.tone, inj.latencyMs, inj.costUsd], ["injected", "info", 1840, 0.0043]);
  assert.equal(describeHalf(L({ event: "prompt", outcome: "silent", reason: "nothing-above-threshold" }), BARS).label, "Nothing above 0.95");
  assert.equal(describeHalf(L({ event: "prompt", outcome: "silent", reason: "nothing-above-threshold" }), { ...BARS, promptThreshold: 0.9 }).label, "Nothing above 0.9");
  assert.equal(describeHalf(L({ event: "prompt", outcome: "silent", reason: "nothing-above-threshold" }), { promptThreshold: null, stopThreshold: null }).label, "Nothing above the injection bar");
  assert.equal(describeHalf(L({ event: "prompt", outcome: "silent", reason: "not-owner-text:agent-completion" }), BARS).label, "Skipped: a sub-agent reported back");
  assert.equal(describeHalf(L({ event: "stop", outcome: "silent", reason: "no-violation-above-threshold", audited: 5, stats: { audited: 5, top: [{ id: "x", score: 0.7712 }, { id: "y", score: 0.5 }] } }), BARS).label, "Audited 5 · best 0.77 / 0.9");
  assert.equal(describeHalf(L({ event: "stop", outcome: "silent", reason: "nominated-hits-not-confirmed", audited: 5, stats: { top: [{ id: "x", score: 0.95 }] } }), BARS).label, "Audited 5 · nominated, not confirmed");
  const blocked = describeHalf(L({ event: "stop", outcome: "blocked", reason: "Recall: the long feedback text", hits: [{ id: "x", score: 0.97 }] }), BARS);
  assert.deepEqual([blocked.label, blocked.kind, blocked.tone, blocked.reason, blocked.feedback], ["Blocked", "blocked", "bad", null, "Recall: the long feedback text"], "a block's reason field is the feedback, not a silence reason");
  assert.equal(describeHalf(L({ event: "stop", outcome: "silent", reason: "no-eligible-prompt-state" }), BARS).label, "Skipped: this turn did not start with something you typed");
  const cap = describeHalf(L({ event: "prompt", outcome: "silent", reason: "cap-reached", level: "error", error: "x" }), BARS);
  assert.deepEqual([cap.kind, cap.tone, cap.label], ["capped", "mid", "Spend cap reached"]);
  const failed = describeHalf(L({ event: "prompt", outcome: "silent", reason: "retrieval-failed", level: "error", error: "TimeoutError: slow" }), BARS);
  assert.deepEqual([failed.kind, failed.tone, failed.label], ["error", "bad", "Search failed"]);
  assert.match(failed.detail, /TimeoutError: slow/);
});

test("a turn of two skipped halves is a pure skip with its group; a searched turn or an error is not", () => {
  const skip = viewTurn({ id: "1", prompt: L({ event: "prompt", outcome: "silent", reason: "not-owner-text:agent-completion" }), stops: [L({ event: "stop", outcome: "silent", reason: "no-eligible-prompt-state" })] }, BARS);
  assert.deepEqual([skip.skip, skip.skipGroup, skip.skipGroupLabel], [true, "subagent", "sub-agent notices"]);
  const waiting = viewTurn({ id: "2", prompt: L({ event: "prompt", outcome: "silent", reason: "headless:claude-unattended" }), stops: [] }, BARS);
  assert.deepEqual([waiting.skip, waiting.skipGroupLabel], [true, "automated sessions"], "a skipped prompt with no Stop yet is still a skip");
  const empty = viewTurn({ id: "3", prompt: L({ event: "prompt", outcome: "silent", reason: "nothing-above-threshold", stats: { costUsd: 0.004 } }), stops: [] }, BARS);
  assert.equal(empty.skip, false, "a search that found nothing cost money and is shown");
  const error = viewTurn({ id: "4", prompt: L({ event: "prompt", outcome: "silent", reason: "retrieval-failed", level: "error" }), stops: [] }, BARS);
  assert.equal(error.skip, false);
  const capped = viewTurn({ id: "5", prompt: L({ event: "prompt", outcome: "silent", reason: "cap-reached" }), stops: [L({ event: "stop", outcome: "silent", reason: "cap-reached" })] }, BARS);
  assert.equal(capped.skip, false, "a spend cap stopping the hooks is never hidden in a collapsed row");
});

test("a turn card: which half is shown as the Stop, follow-ups, origin fields with and without them, cost sum", () => {
  const turn = {
    id: "t",
    prompt: L({ event: "prompt", outcome: "injected", injected: ["a"], query: "q", host: "claude", home: "~/.claude_work", project: "p", cwd: "/x/p", stats: { costUsd: 0.004 } }),
    stops: [L({ event: "stop", outcome: "blocked", reason: "feedback", ts: "2026-10-08T01:00:05.000Z" }), L({ event: "stop", outcome: "silent", reason: "stop-hook-active", ts: "2026-10-08T01:00:30.000Z" })],
  };
  const v = viewTurn(turn, BARS);
  assert.deepEqual([v.stop.kind, v.followUps, v.home, v.project, v.query, v.host], ["blocked", 1, "~/.claude_work", "p", "q", "claude"]);
  assert.equal(v.updated, "2026-10-08T01:00:30.000Z");
  assert.equal(v.stops.length, 2);
  const old = viewTurn({ id: "o", prompt: L({ event: "prompt", outcome: "injected", injected: [], host: "claude" }), stops: [] }, BARS);
  assert.deepEqual([old.home, old.project, old.cwd, old.host], [null, null, null, "claude"], "lines from before the origin fields still render");
});

test("counters and reason counts: by UTC day, skips by reason, searches and audits", () => {
  const turns = [
    { prompt: L({ event: "prompt", outcome: "injected", injected: ["a", "b"], stats: { costUsd: 0.004 } }), stops: [L({ event: "stop", outcome: "silent", reason: "no-violation-above-threshold", audited: 5, stats: { audited: 5, costUsd: 0.07 } })] },
    { prompt: L({ event: "prompt", outcome: "silent", reason: "not-owner-text:agent-completion" }), stops: [L({ event: "stop", outcome: "silent", reason: "no-eligible-prompt-state" })] },
    { prompt: L({ event: "prompt", outcome: "silent", reason: "nothing-above-threshold" }), stops: [L({ event: "stop", outcome: "blocked", reason: "feedback", audited: 5 })] },
    { prompt: L({ ts: "2026-10-07T23:59:59.000Z", event: "prompt", outcome: "silent", reason: "not-owner-text:agent-completion" }), stops: [] },
    { prompt: L({ event: "prompt", outcome: "silent", reason: "retrieval-failed", level: "error" }), stops: [] },
  ];
  const c = dayCounters(turns, "2026-10-08");
  assert.deepEqual([c.fired, c.prompts, c.stops, c.searched, c.injectedTurns, c.injectedStatements, c.audited, c.blocked, c.skipped, c.errors], [7, 4, 3, 3, 1, 2, 2, 1, 2, 1]);
  assert.ok(Math.abs(c.costUsd - 0.074) < 1e-9);
  assert.deepEqual(c.skippedByReason.map((r) => [r.event, r.reason, r.count]), [["stop", "no-eligible-prompt-state", 1], ["prompt", "not-owner-text:agent-completion", 1]]);
  const all = reasonCounts(turns, "2026-10-07T00:00:00Z");
  assert.equal(all.find((r) => r.reason === "not-owner-text:agent-completion").count, 2);
  assert.ok(!all.some((r) => r.reason === "feedback"), "a block's feedback text is not a reason");
});

test("active sessions: last 30 minutes, newest first, automated-only sessions left out", () => {
  const now = Date.parse("2026-10-08T01:30:00Z");
  const t = (session, ts, over = {}) => ({ prompt: L({ event: "prompt", session_id: session, ts, host: "claude", home: "~/.claude_work", project: session, outcome: "silent", reason: "nothing-above-threshold", ...over }), stops: [] });
  const sessions = activeSessions([
    t("recent", "2026-10-08T01:20:00Z"), t("newest", "2026-10-08T01:29:00Z"), t("stale", "2026-10-08T00:50:00Z"),
    t("worker", "2026-10-08T01:25:00Z", { reason: "headless:claude-unattended" }), t("unsure", "2026-10-08T01:26:00Z", { reason: "unknown:codex-no-rollout" }),
  ], now);
  assert.deepEqual(sessions.map((s) => s.session_id), ["newest", "recent"]);
  assert.deepEqual([sessions[0].home, sessions[0].project, sessions[0].host], ["~/.claude_work", "newest", "claude"]);
});
