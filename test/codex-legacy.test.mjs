// Codex rollouts from before session_meta (fixtures/codex-legacy): a bare header line, `record_type` markers and bare response items with no
// time of their own. A legacy session is the owner's when a typed-prompt log names it (the TUI writes every submitted prompt there, `codex exec`
// never does); its turns are dated with the session's start. Cards and `recall show` read the same records. Synthetic files, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scanContexts } from "../scripts/lib/cards/context-source.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { showStatement } from "../scripts/lib/show.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { codexTurn, isSessionMeta, parseLegacyHeader, sessionVerdict } from "../scripts/lib/transcripts/codex.mjs";
import { createTally } from "../scripts/lib/transcripts/tally.mjs";
import { FIXTURES, tmpDir } from "./helpers.mjs";

const TYPED = "0190e000-3333-7000-8000-00000000f003";
const SCRIPTED = "0190e000-5555-7000-8000-00000000f005";
const FILES = fs.readdirSync(path.join(FIXTURES, "codex-legacy")).sort();
const lines = (name) => fs.readFileSync(path.join(FIXTURES, "codex-legacy", name), "utf8").trimEnd().split("\n");
const typedFile = FILES.find((f) => f.includes(TYPED));

test("legacy header: line 1 without session_meta gives the session (id, cwd, git remote, start time) marked legacy; nothing else is a header", () => {
  const first = Buffer.from(lines(typedFile)[0]);
  assert.equal(isSessionMeta(first), false);
  assert.deepEqual(parseLegacyHeader(first), { id: TYPED, cwd: "/home/sam/projects/ledger-cli", git_url: "git@github.com:sam/ledger-cli.git", source: null, thread_source: null, originator: null, timestamp: "2025-09-03T10:15:00.123Z", legacy: true });
  assert.equal(parseLegacyHeader(Buffer.from(lines(typedFile)[1])), null, "a record_type marker");
  assert.equal(parseLegacyHeader(Buffer.from(lines(typedFile)[4])), null, "a bare item");
  assert.equal(parseLegacyHeader(Buffer.from('{"timestamp":"2026-01-01T00:00:00.000Z","type":"session_meta","payload":{"id":"x"}}')), null);
  assert.equal(parseLegacyHeader(Buffer.from("not json")), null);
});

test("legacy verdict: the owner's when a typed-prompt log names the session, a program's otherwise; a bare user item is a fallback turn with no time", () => {
  const meta = parseLegacyHeader(Buffer.from(lines(typedFile)[0]));
  assert.deepEqual(sessionVerdict(meta, { typedSessions: new Set([TYPED]) }), { mine: true, reason: null });
  assert.deepEqual(sessionVerdict(meta, { typedSessions: new Set() }), { mine: false, reason: "legacy-not-typed" });
  assert.deepEqual(sessionVerdict(meta), { mine: false, reason: "legacy-not-typed" });
  assert.deepEqual(codexTurn(Buffer.from(lines(typedFile)[4]), createTally()), { kind: "fallback", raw: "Why does the balance command print negative zero for empty accounts?", ts: null });
  assert.equal(codexTurn(Buffer.from(lines(typedFile)[9]), createTally()), null, "the assistant's item is not a user turn");
});

/** An old Codex home kept for indexing only ({path, kind}), with both legacy rollouts and a typed-prompt log naming the typed session. */
function world({ historySessions = [TYPED] } = {}) {
  const root = tmpDir("recall-legacy");
  const home = path.join(root, "old-codex");
  const day = path.join(home, "sessions", "2025", "09", "03");
  fs.mkdirSync(day, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(FIXTURES, "codex-legacy", f), path.join(day, f));
  fs.writeFileSync(path.join(home, "history.jsonl"), historySessions.map((s, i) => JSON.stringify({ session_id: s, ts: 1756894600 + i, text: "Why does the balance command print negative zero for empty accounts?" })).join("\n") + "\n");
  const config = loadConfig({ RECALL_DATA: path.join(root, "data"), RECALL_HOMES: JSON.stringify([{ path: home, kind: "codex" }]) });
  const store = createStore(config.dataDir);
  return { root, home, day, config, store, run: (o = {}) => runIndex({ config, store, homeDir: root, env: {}, embed: false, now: () => Date.parse("2026-10-01T00:00:00.000Z"), ...o }) };
}

test("index: a typed legacy session's turns are statements dated with the session's start; a scripted one is dropped; its history rows defer to it", async () => {
  const w = world();
  const report = await w.run();
  const rows = w.store.loadStatements();
  assert.deepEqual(rows.map((s) => [s.text, s.ts, s.session_id, s.repo, s.host]), [
    ["Why does the balance command print negative zero for empty accounts?", "2025-09-03T10:15:00.123Z", TYPED, "ledger-cli", "codex"],
    ["Round to cents before formatting and add a test for an empty account", "2025-09-03T10:15:00.123Z", TYPED, "ledger-cli", "codex"],
  ]);
  assert.ok(rows.every((s) => s.src.startsWith(path.join(w.day, typedFile))));
  assert.equal(report.excluded["legacy-not-typed"], 1, `the rollout of ${SCRIPTED}`);
  assert.equal(report.excluded["history-session-has-rollout"], 1, "the history row of the typed session: its rollout speaks for it");
  assert.equal(report.excluded.empty, 1, "the environment-context item");
  assert.ok(!rows.some((s) => s.text.includes("Scan it and list every command")), "a program's brief is not indexed");
});

test("index: with no typed-prompt log naming it, no legacy session is the owner's", async () => {
  const w = world({ historySessions: [] });
  const report = await w.run();
  assert.equal(w.store.loadStatements().length, 0);
  assert.equal(report.excluded["legacy-not-typed"], 2);
});

test("index: a legacy rollout an older version skipped as no-session-meta is read again", async () => {
  const w = world();
  const file = path.join(w.day, typedFile);
  const stat = fs.statSync(file);
  fs.mkdirSync(path.join(w.config.dataDir, "state"), { recursive: true });
  w.store.saveState({ files: { [file]: { size: stat.size, mtimeMs: stat.mtimeMs, offset: stat.size, lines: 0, skip: "no-session-meta" } }, lastIndexAt: null });
  const report = await w.run();
  assert.equal(report.added, 2);
  assert.equal(report.rescanned, 1);
});

test("cards and show read a legacy rollout: the owner message before and the assistant's reply; the bare call is a tool marker", async () => {
  const w = world();
  await w.run();
  const [first, second] = w.store.loadStatements();
  const file = path.join(w.day, typedFile);
  const ctx = await scanContexts({ file, host: "codex", config: w.config, targets: [{ key: "b", line: Number(second.src.split(":L")[1]), text: second.text }] });
  assert.deepEqual(ctx.get("b"), { owner: first.text, assistant: "The formatter prints -0.00 because the sum is a float that rounds to minus zero." });
  const shown = await showStatement({ id: second.id, before: 3, after: 0, config: w.config, env: {}, cwd: w.root, homedir: w.root });
  assert.deepEqual(shown.view.items.map((it) => (it.type === "tools" ? `tools:${it.names.join(",")}` : `${it.role}:L${it.line}`)), ["owner:L5", "tools:shell", "assistant:L10", "owner:L12"]);
});
