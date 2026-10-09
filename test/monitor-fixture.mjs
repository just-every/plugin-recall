// A fixture data dir for the monitor tests (test-only data: the monitor itself has none). Line shapes are those the hooks write
// (scripts/lib/prompt-hook.mjs, stop-hook.mjs, with the origin fields of turn-meta.mjs); the texts are invented.
import fs from "node:fs";
import path from "node:path";

export const NOW = new Date("2026-10-08T03:00:00.000Z");
const ago = (now) => (m) => new Date(now.getTime() - m * 60_000).toISOString();

const SETTINGS = { dailyCapUsd: { value: 5, source: "file" }, totalCapUsd: { value: 6.34, source: "file" }, stopPipeline: { value: "compose-lean", source: "default" } };
const origin = (host, n) => ({
  host,
  home: host === "codex" ? "~/.codex_work" : "~/.claude_work",
  cwd: `/home/sam/projects/project-${n}`,
  project: `project-${n}`,
  transcript: host === "codex" ? `/home/sam/.codex_work/sessions/2026/10/08/rollout-${n}.jsonl` : `/home/sam/.claude_work/projects/-x/s${n}.jsonl`,
});
const baseLine = (minutesAgo, event, mins, host, n, session, turnKey) => ({
  ts: minutesAgo(mins), level: "info", event, ...origin(host, n), session_id: session, turn_key: turnKey,
  pipeline: event === "stop" ? "compose-lean" : "default", dataDir: "/data", settings: SETTINGS,
});

export const STATEMENTS = [
  { id: "claude-aaa", text: "No fallbacks. Fix the code structure instead.", ts: "2026-09-01T10:00:00Z", session_id: "old1", repo: "shared-lib", host: "claude", hash: "h1", src: "x:L1" },
  { id: "codex-bbb", text: "Do not take focus when you open the browser.", ts: "2026-09-05T10:00:00Z", session_id: "old2", repo: "design-kit", host: "codex", hash: "h2", src: "x:L2" },
  { id: "codex-ccc", text: "Use real prices, never invent unit costs.", ts: "2026-09-06T10:00:00Z", session_id: "old3", repo: null, host: "codex", hash: "h3", src: "x:L3" },
];
const cand = (id, d, rank) => ({ id, score: 0.3 - rank * 0.01, parts: { rrf: 0.3 - rank * 0.01, d, dRank: rank, emb: 0.4, embRank: rank + 3, bm25Rank: rank + 7, threadRank: null }, ts: "2026-09-01T10:00:00.000Z", repo: "shared-lib", session_id: "old1", text: `candidate ${id}` });
const STATS = { embedCostUsd: 1e-6, embedCached: false, embedMs: 300, prefilterMs: 500, prefilterSize: 222, decisionsMs: 800, requests: 4, cachedRequests: 1, cacheHits: 2, costUsd: 0.0043, questions: 222, refused: 0, totalMs: 1300 };

/**
 * The log lines in write order, timed back from `now`. Turns: T1 injected+audited, T2 empty search+blocked, T3 T4 pure skips, T5 keyless pair,
 * T6 stop only, T7 errors, T8 headless, T0 yesterday.
 */
export function fixtureLines(now = NOW) {
  const minutesAgo = ago(now);
  const base = (...a) => baseLine(minutesAgo, ...a);
  // T0 is a line from before the hooks logged home, cwd, project and transcript: it must still render
  const legacy = (l) => { const { home, cwd, project, transcript, ...rest } = l; return rest; };
  return [
    legacy({ ...base("prompt", 210, "claude", 1, "sess-old", "turn-0"), outcome: "injected", query: "an old question from yesterday", candidates: [cand("claude-aaa", 0.99, 1)], injected: ["claude-aaa"], context: "<recall-context>old</recall-context>", latency_ms: 1500, stats: STATS }),
    { ...base("prompt", 30, "claude", 1, "sess-1", "turn-1"), outcome: "injected", query: "We should add a fallback path when the draft runs duplicate", eligible: 12000, statements: 12010, without_embedding: 0, candidates: [cand("claude-aaa", 0.99, 1), cand("codex-bbb", 0.97, 2), cand("codex-ccc", 0.4, 3)], injected: ["claude-aaa", "codex-bbb"], context: "<recall-context>\n- (repo: shared-lib) \"No fallbacks.\"\n</recall-context>", latency_ms: 1840, stats: STATS },
    { ...base("stop", 29, "claude", 1, "sess-1", "turn-1"), outcome: "silent", reason: "no-violation-above-threshold", latency_ms: 3376, audited: 5, message: "I added the fallback path as you described.", stats: { ...STATS, costUsd: 0.0487, audited: 5, nominated: 0, top: [{ id: "claude-aaa", score: 0.77 }, { id: "codex-bbb", score: 0.5 }, { id: "codex-ccc", score: 0.2 }] } },
    { ...base("prompt", 20, "codex", 2, "sess-2", "turn-2"), outcome: "silent", reason: "nothing-above-threshold", query: "Please rename the helper and update the tests", eligible: 12000, statements: 12010, candidates: [cand("codex-bbb", 0.5, 1)], injected: [], context: null, latency_ms: 2100, stats: STATS },
    { ...base("stop", 19, "codex", 2, "sess-2", "turn-2"), outcome: "blocked", reason: "Recall: your final message may contradict an earlier statement.", latency_ms: 4100, audited: 5, message: "Done, I renamed it.", hits: [{ id: "codex-bbb", score: 0.97, text: "Do not take focus when you open the browser.", evidence: "The message opens a browser window." }], stats: { ...STATS, costUsd: 0.07, audited: 5, nominated: 1, top: [{ id: "codex-bbb", score: 0.97 }] } },
    { ...base("prompt", 10, "claude", 3, "sess-3", "turn-3"), outcome: "silent", reason: "not-owner-text:agent-completion", latency_ms: 6 },
    { ...base("stop", 9.5, "claude", 3, "sess-3", "turn-3"), outcome: "silent", reason: "no-eligible-prompt-state", latency_ms: 4, prompt_state: "not-owner-text:agent-completion" },
    { ...base("prompt", 9, "claude", 3, "sess-4", "turn-4"), outcome: "silent", reason: "not-owner-text:agent-completion", latency_ms: 5 },
    { ...base("stop", 8.8, "claude", 3, "sess-4", "turn-4"), outcome: "silent", reason: "no-eligible-prompt-state", latency_ms: 4, prompt_state: "not-owner-text:agent-completion" },
    { ...base("prompt", 8, "claude", 5, "sess-5", null), outcome: "injected", query: "keyless turn", candidates: [cand("claude-aaa", 0.96, 1)], injected: ["claude-aaa"], context: "<recall-context>k</recall-context>", latency_ms: 1000, stats: STATS },
    { ...base("stop", 7, "claude", 5, "sess-5", null), outcome: "silent", reason: "no-violation-above-threshold", latency_ms: 2000, audited: 3, stats: { ...STATS, audited: 3, top: [{ id: "claude-aaa", score: 0.1 }] } },
    { ...base("stop", 6, "claude", 6, "sess-6", "turn-6"), outcome: "silent", reason: "short-or-missing-message", latency_ms: 2, chars: 4 },
    { ...base("prompt", 5, "claude", 7, "sess-7", "turn-7"), level: "error", outcome: "silent", reason: "retrieval-failed", error: "TimeoutError: recall retrieval timed out", query: "this one failed", latency_ms: 20000, stats: { requests: 1 } },
    { ...base("stop", 4.5, "claude", 7, "sess-7", "turn-7"), level: "error", outcome: "silent", reason: "audit-failed", error: "TimeoutError: recall stop audit timed out", latency_ms: 20000, stats: {} },
    { ...base("prompt", 4, "claude", 8, "sess-8", "turn-8"), outcome: "silent", reason: "headless:claude-unattended", latency_ms: 3, signals: { attended: "0" } },
    { ts: minutesAgo(3), level: "error", event: "prompt", outcome: "silent", reason: "hook-crashed", error: "Error: boom" },
  ];
}

export const LEDGER = [
  { ts: "2026-10-07T23:30:00.000Z", experiment: "plugin-recall", endpoint: "/v1/decisions", inputTokens: 100000, costUsd: 0.01, requestId: "r1", kind: "billed", label: "d-generic#0" },
  { ts: "2026-10-08T01:10:00.000Z", experiment: "plugin-recall", endpoint: "/v1/decisions", inputTokens: 200000, costUsd: 0.02, requestId: "r2", kind: "billed", label: "d-generic#0" },
  { ts: "2026-10-08T02:40:00.000Z", experiment: "plugin-recall", endpoint: "/v1/embeddings", inputTokens: 300000, costUsd: 0.03, requestId: "r3", kind: "billed", label: "embed-query" },
];

export const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** Write the fixture, timed back from `now` (default NOW). The log lines are split into the UTC day files they belong to. */
export function seedMonitorData(dataDir, { config = { dailyCapUsd: 5, totalCapUsd: 6.34 }, now = NOW } = {}) {
  const minutesAgo = ago(now);
  fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "state"), { recursive: true });
  const byDay = new Map();
  for (const l of fixtureLines(now)) byDay.set(l.ts.slice(0, 10), [...(byDay.get(l.ts.slice(0, 10)) ?? []), l]);
  for (const [day, lines] of byDay) fs.writeFileSync(path.join(dataDir, "logs", `turns-${day}.jsonl`), jsonl(lines));
  fs.writeFileSync(path.join(dataDir, "ledger.jsonl"), jsonl(LEDGER));
  fs.writeFileSync(path.join(dataDir, "statements.jsonl"), jsonl(STATEMENTS));
  fs.writeFileSync(path.join(dataDir, "state", "last-index.json"), JSON.stringify({ at: minutesAgo(12), durationMs: 5000, homes: ["/h1", "/h2"], added: 2, embedding: { costUsd: 0.00001 } }));
  if (config) fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config));
  return { dataDir };
}

/** Every file under dir with its size and mtime: proof that the monitor wrote nothing. */
export function treeStamp(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const f = path.join(d, name);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f); else out[path.relative(dir, f)] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}
