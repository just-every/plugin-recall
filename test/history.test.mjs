// Typed-prompt logs (<home>/history.jsonl): the rows of Codex, Every Code and Claude Code, on the synthetic rows of fixtures/history and fake
// homes under a temp HOME. A row a transcript already yields is skipped (Codex and Every Code: the session has a rollout in sessions/ or
// archived_sessions/; Claude: the same text in the same project); everything else is a statement with the same text rules as a transcript.
// Cards take the previous row of the session as context, and `recall show` shows the rows of the session around the statement. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadCards } from "../scripts/lib/cards/cards-file.mjs";
import { cardAllow } from "../scripts/lib/cards/eligibility.mjs";
import { enrichStatements } from "../scripts/lib/cards/enrich.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { showStatement } from "../scripts/lib/show.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { claudeProjectDir, historyLine, isHistoryFile, parseHistoryRow } from "../scripts/lib/transcripts/history.mjs";
import { historyContexts, readHistoryExcerpt } from "../scripts/lib/transcripts/history-context.mjs";
import { HISTORY_SETTLE_MS } from "../scripts/lib/transcripts/history-scan.mjs";
import { claudeUser, codexUser, writeTranscript } from "./transcript-builders.mjs";
import { readFixture, tmpDir } from "./helpers.mjs";

const rowsOf = (name) => readFixture("history", name).trim().split("\n").map((l) => JSON.parse(l));
const CODEX_ROWS = rowsOf("codex-history.jsonl");
const CLAUDE_ROWS = rowsOf("claude-history.jsonl");
const S1 = "0190e000-1111-7000-8000-00000000f001";
const LATER = Date.parse("2026-10-01T00:00:00.000Z"); // "now" for the index passes: every fixture row is long settled
const iso = (sec) => new Date(sec * 1000).toISOString();

const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const sessionMeta = (id, { source = "cli", originator = "codex_cli_rs", cwd = "/home/sam/projects/web-app" } = {}) => JSON.stringify({ timestamp: "2025-09-02T09:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2025-09-02T09:00:00.000Z", cwd, originator, cli_version: "0.30.0", source, thread_source: "user" } });

/** A fake HOME: `.codex` with the Codex rows, a rollout for session 2222 in sessions/ and one for 4444 in archived_sessions/. */
function codexWorld({ kind = ".codex", rows = CODEX_ROWS, env = {} } = {}) {
  const root = tmpDir("recall-history");
  const home = path.join(root, kind);
  fs.mkdirSync(path.join(home, "sessions", "2025", "09", "02"), { recursive: true });
  fs.mkdirSync(path.join(home, "archived_sessions"), { recursive: true });
  fs.writeFileSync(path.join(home, "history.jsonl"), jsonl(rows));
  writeTranscript("rollout-2025-09-02T10-00-00-0190e000-2222-7000-8000-00000000f002.jsonl", [sessionMeta("0190e000-2222-7000-8000-00000000f002"), codexUser("A typed turn of the session that also has a history row", "2025-09-02T10:00:05.000Z")], path.join(home, "sessions", "2025", "09", "02"));
  // an exec rollout: not the owner's, and its history row is skipped all the same (the rollout speaks for its session)
  writeTranscript("rollout-2025-09-02T12-00-00-0190e000-4444-7000-8000-00000000f004.jsonl", [sessionMeta("0190e000-4444-7000-8000-00000000f004", { source: "exec", originator: "codex_exec" })], path.join(home, "archived_sessions"));
  const config = loadConfig({ RECALL_DATA: path.join(root, "data"), ...env });
  return { root, home, config, store: createStore(config.dataDir), run: (o = {}) => runIndex({ config, store: createStore(config.dataDir), homeDir: root, env: {}, embed: false, now: () => LATER, ...o }) };
}

test("history rows: both shapes parse; a slash command keeps what was typed after it; a paste is put back; Claude rows without a session id say so", () => {
  assert.deepEqual(parseHistoryRow(CODEX_ROWS[0]), { session_id: S1, ts: iso(CODEX_ROWS[0].ts), raw: " add a CSV export to the invoices table with a filter per month", project: null });
  assert.equal(parseHistoryRow(CODEX_ROWS[2]).raw, "", "a bare command leaves nothing");
  assert.deepEqual(parseHistoryRow(CLAUDE_ROWS[1]), { session_id: "5bbb0000-0000-4000-8000-000000000001", ts: new Date(CLAUDE_ROWS[1].timestamp).toISOString(), raw: "Use this error text for the empty state: No invoices for this month yet.\nTry another month or create one.", project: "/home/sam/projects/web-app" });
  assert.equal(parseHistoryRow(CLAUDE_ROWS[6]).session_id, null);
  assert.equal(parseHistoryRow({ display: "/home/sam/Desktop/shot.png what is wrong here", timestamp: 1, project: "/p" }).raw, "/home/sam/Desktop/shot.png what is wrong here", "a dropped path is not a command");
  assert.equal(historyLine(Buffer.from("not json")), null);
  assert.equal(parseHistoryRow({ type: "session_meta" }), null);
  assert.ok(isHistoryFile("/h/.codex/history.jsonl") && !isHistoryFile("/h/.codex/sessions/rollout-1.jsonl"));
  assert.equal(claudeProjectDir("/home/sam/projects/web-app.v2_x"), "-home-sam-projects-web-app-v2-x");
});

test("Codex history: a row is a statement unless its session has a rollout (sessions/ or archived_sessions/); src is path:line, no repo, the row's session and time", async () => {
  const w = codexWorld({ env: { RECALL_OWNER_EMAILS: "sam@example.com" } });
  const report = await w.run();
  const rows = w.store.loadStatements().filter((s) => isHistoryFile(s.src.replace(/:L\d+$/, "")));
  const file = path.join(w.home, "history.jsonl");
  assert.deepEqual(rows.map((s) => [s.text, s.src, s.session_id, s.ts, s.repo, s.host]), [
    ["add a CSV export to the invoices table with a filter per month", `${file}:L1`, S1, iso(CODEX_ROWS[0].ts), null, "codex"],
    ["Keep the export columns in the same order as the table on screen", `${file}:L2`, S1, iso(CODEX_ROWS[1].ts), null, "codex"],
    ["Also show a row count under the export button once it finishes", `${file}:L7`, S1, iso(CODEX_ROWS[6].ts), null, "codex"],
  ]);
  assert.equal(report.excluded["history-session-has-rollout"], 2, "session 2222 (sessions/) and 4444 (archived_sessions/, an exec rollout)");
  assert.equal(report.excluded["third-party"], 1, "the same owner rules as a transcript: another person's address");
  assert.equal(report.excluded.empty, 1, "a bare slash command");
  assert.equal(report.perSource[`${w.home}|history`], 3);
});

test("Every Code history (~/.code) is read the same way, as host code; the fleet profile applies to its rows too", async () => {
  // a markdown heading at the head is a brief an agent wrote, under the fleet profile only
  const brief = { session_id: "0190e000-7777-7000-8000-00000000f007", ts: 1756820000, text: "# Export plan\nThree steps for the export work follow, one per section" };
  const w = codexWorld({ kind: ".code", rows: [...CODEX_ROWS, brief], env: { RECALL_FILTER_PROFILES: "fleet", RECALL_OWNER_NAMES: "sam" } });
  const report = await w.run();
  const hist = w.store.loadStatements().filter((s) => s.src.includes("history.jsonl"));
  assert.ok(hist.length >= 3 && hist.every((s) => s.host === "code"));
  assert.equal(report.excluded["agent-brief"], 1);
});

test("Every Code's own notices in its typed-prompt log are not the person's: access mode, working directory, branch finalize, auto-review", async () => {
  const sid = "0190e000-9999-7000-8000-00000000f009";
  const notices = [
    "System: access mode changed to full access for this session",
    "System: Working directory changed from /home/sam/projects/web-app to /home/sam/.code/working/web-app/branches/code-branch-a1 (worktree: code-branch-a1).",
    "Finalize branch 'code-branch-a1' via /home/sam/.code/working/web-app/branches/code-branch-a1 (agent merge required)",
    "Auto-resolve status check",
    "[developer] Background auto-review found issues in the last change; see the findings above",
  ];
  const w = codexWorld({ kind: ".code", rows: [...notices.map((text, i) => ({ session_id: sid, ts: 1756830000 + i, text })), { session_id: sid, ts: 1756830100, text: "Keep the worktree after the merge, I want to compare the two branches" }] });
  const report = await w.run();
  assert.deepEqual(w.store.loadStatements().filter((s) => s.session_id === sid).map((s) => s.text), ["Keep the worktree after the merge, I want to compare the two branches"]);
  assert.equal(report.excluded.harness, notices.length);
});

test("Codex history: incremental by offset, an unchanged log is not read again, the youngest rows wait until they settle", async () => {
  const w = codexWorld();
  await w.run();
  const n = w.store.loadStatements().length;
  const again = await w.run();
  assert.equal(again.added, 0);
  assert.equal(again.scanned, 0, "nothing changed: no file is opened");
  const young = { session_id: "0190e000-8888-7000-8000-00000000f008", ts: Math.floor(LATER / 1000) - 60, text: "Typed a minute ago, its rollout may not be on disk yet" };
  fs.appendFileSync(path.join(w.home, "history.jsonl"), jsonl([young]));
  const waiting = await w.run();
  assert.equal(waiting.added, 0, "a row younger than the settle time waits");
  const state = w.store.loadState().files[path.join(w.home, "history.jsonl")];
  assert.equal(state.pending, true);
  assert.equal(state.lines, CODEX_ROWS.length);
  const settled = await w.run({ now: () => LATER + HISTORY_SETTLE_MS });
  assert.equal(settled.added, 1);
  assert.equal(w.store.loadStatements().length, n + 1);
  const last = w.store.loadStatements().at(-1);
  assert.equal(last.src, `${path.join(w.home, "history.jsonl")}:L${CODEX_ROWS.length + 1}`);
  assert.equal((await w.run({ now: () => LATER + HISTORY_SETTLE_MS })).scanned, 0);
});

test("Codex history: a rollout that appears for a session skips the session's later rows, and the dry run counts history apart", async () => {
  const w = codexWorld();
  const dry = await w.run({ dryRun: true });
  assert.deepEqual(dry.bySource[`${w.home}|history`], { statements: 4, added: 4 });
  assert.equal(dry.bySource[`${w.home}|transcripts`].statements, 1);
  writeTranscript(`rollout-2025-09-02T08-00-00-${S1}.jsonl`, [sessionMeta(S1), codexUser("Keep the export columns in the same order as the table on screen", "2025-09-02T10:01:00.000Z")], path.join(w.home, "sessions", "2025", "09", "02"));
  const dry2 = await w.run({ dryRun: true });
  assert.equal(dry2.bySource[`${w.home}|history`], undefined, "every row left belonged to session 1111, which has a rollout now");
  assert.equal(dry2.bySource[`${w.home}|transcripts`].statements, 2);
  assert.equal(dry2.excluded["history-session-has-rollout"], 7, "the five rows of session 1111, and 2222 and 4444 as before");
});

// A project directory under a temp dir is a program's worker (isTempProjectDir), and the test's HOME is a temp dir: the projects stay where the
// fixture puts them, as worktrees, a layout whose repo the path alone names (repo-identity.mjs structuralRepo).
const projectOf = (p) => (p.startsWith("/home/sam/projects/") ? `${p}/.worktrees/main` : p);

/** A fake HOME with a Claude home: the fixture rows and a transcript in demo-repo that holds one of them. */
function claudeWorld() {
  const root = tmpDir("recall-history-claude");
  const home = path.join(root, ".claude");
  const rows = CLAUDE_ROWS.map((r) => ({ ...r, project: projectOf(r.project) }));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "history.jsonl"), jsonl(rows));
  const dir = path.join(home, "projects", claudeProjectDir(projectOf("/home/sam/projects/demo-repo")));
  fs.mkdirSync(dir, { recursive: true });
  writeTranscript("5bbb0000-0000-4000-8000-000000000002.jsonl", [claudeUser("Please read docs/HANDOVER.md before changing the importer", "2025-09-05T09:03:20.250Z")], dir);
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  return { root, home, config, store: createStore(config.dataDir), run: (o = {}) => runIndex({ config, store: createStore(config.dataDir), homeDir: root, env: {}, embed: false, now: () => LATER, ...o }) };
}

test("Claude history: a row with the same text in the same project as a transcript statement is skipped; the repo comes from the project", async () => {
  const w = claudeWorld();
  const report = await w.run();
  const hist = w.store.loadStatements().filter((s) => s.src.includes("history.jsonl"));
  assert.deepEqual(hist.map((s) => [s.text, s.repo, s.session_id]), [
    ["The invoices page should remember the last month filter between visits", "web-app", "5bbb0000-0000-4000-8000-000000000001"],
    ["Use this error text for the empty state: No invoices for this month yet. Try another month or create one.", "web-app", "5bbb0000-0000-4000-8000-000000000001"],
    ["Please read docs/HANDOVER.md before changing the importer", "billing-api", "5bbb0000-0000-4000-8000-000000000003"],
    ["Older rows have no session id; this one still counts as typed", "web-app", null],
  ]);
  assert.equal(report.excluded["history-in-transcript"], 1, "the demo-repo row: its transcript already holds it");
  assert.equal(report.excluded["temp-cwd-session"], 1, "a row typed in a temp directory is a program's worker, as for a transcript");
  assert.equal(w.store.loadStatements().filter((s) => s.text.startsWith("Please read docs/HANDOVER.md")).length, 2, "one from the transcript, one from billing-api's row");
  // the key holds across passes: a statement indexed earlier (its transcript since deleted) still stops the row
  fs.rmSync(path.join(w.home, "projects"), { recursive: true });
  fs.appendFileSync(path.join(w.home, "history.jsonl"), jsonl([{ ...CLAUDE_ROWS[2], project: projectOf(CLAUDE_ROWS[2].project), timestamp: CLAUDE_ROWS[2].timestamp + 1 }]));
  const later = await w.run();
  assert.equal(later.added, 0);
  assert.equal(later.excluded["history-in-transcript"], 1);
});

test("a statement with no repo (a Codex or Every Code history row) is injected in a repo only as a global rule or preference", () => {
  const allow = cardAllow({ excludeKinds: ["question", "status"], scopeFilter: true, repoAliases: {} }, "web-app");
  const item = (kind, scope) => ({ repo: null, card: { kind, scope } });
  assert.equal(allow(item("rule", "global")), true);
  assert.equal(allow(item("preference", "global")), true);
  for (const [kind, scope] of [["rule", "repo"], ["rule", "unclear"], ["decision", "global"], ["correction", "global"], ["other", "global"]]) assert.equal(allow(item(kind, scope)), false, `${kind}/${scope}`);
  assert.equal(cardAllow({ excludeKinds: ["question", "status"], scopeFilter: true, repoAliases: {} }, null)(item("decision", "repo")), false, "no current repo either: still only global rules and preferences");
});

test("cards: the context of a history row is the previous row of its session (no assistant reply), and the card says gist_source history", async () => {
  const w = codexWorld();
  await w.run();
  const statements = w.store.loadStatements().filter((s) => s.src.includes("history.jsonl"));
  const file = path.join(w.home, "history.jsonl");
  const ctx = await historyContexts({ file, config: w.config, targets: statements.map((s) => ({ key: s.id, line: Number(s.src.split(":L")[1]), text: s.text })) });
  assert.deepEqual(statements.map((s) => ctx.get(s.id)), [
    { owner: null, assistant: null },
    { owner: "add a CSV export to the invoices table with a filter per month", assistant: null },
    // a bare command between two rows holds no words and is passed over
    { owner: "Keep the export columns in the same order as the table on screen", assistant: null },
    { owner: "Send the finished file to billing-team@example.org when the export works", assistant: null },
  ]);
  assert.deepEqual((await historyContexts({ file, config: w.config, targets: [{ key: "k", line: 2, text: "not what line two says" }] })).get("k"), { mismatch: true });
  const prompts = [];
  const runWorker = async (o) => {
    prompts.push(o.prompt);
    const n = Number(/exactly one entry for each of the (\d+) numbered/.exec(o.prompt)[1]);
    return { json: { cards: Array.from({ length: n }, (_, i) => ({ n: i + 1, kind: "preference", scope: "repo", gist: "the owner was planning the export" })) }, home: "/h/.claude_x", kind: "claude" };
  };
  const outFile = path.join(tmpDir("recall-history-cards"), "cards.jsonl");
  await enrichStatements({ statements, existing: new Map(), outFile, runWorker, config: w.config });
  const cards = loadCards(outFile);
  assert.deepEqual(statements.map((s) => cards.get(s.id).gist_source), ["none", "history", "history", "history"]);
  assert.match(prompts.join("\n"), /Previous owner message: "add a CSV export to the invoices table with a filter per month"\nPrevious assistant message: \(none\)\nStatement: "Keep the export columns/);
});

test("recall show: a history statement is shown with the rows of its session around it", async () => {
  const w = codexWorld();
  await w.run();
  const target = w.store.loadStatements().find((s) => s.text.startsWith("Keep the export columns"));
  const { view, text } = await showStatement({ id: target.id, before: 4, after: 3, config: w.config, env: {}, cwd: w.root, homedir: w.root });
  assert.deepEqual(view.items.map((it) => [it.role, it.line, it.recalled]), [["owner", 1, false], ["owner", 2, true], ["owner", 5, false], ["owner", 7, false]], "rows of session 1111 only; the bare command is not a turn");
  assert.match(text, /source: ~\/\.codex\/history\.jsonl:L2/);
  assert.match(text, /^>> USER \(recalled statement\)  \d\d:\d\d:\d\d  L2$/m);
  const tight = await readHistoryExcerpt({ file: path.join(w.home, "history.jsonl"), line: 2, statementText: target.text, before: 0, after: 1, config: w.config });
  assert.deepEqual(tight.items.map((it) => it.line), [2, 5]);
  await assert.rejects(() => readHistoryExcerpt({ file: path.join(w.home, "history.jsonl"), line: 3, statementText: target.text, before: 1, after: 1, config: w.config }), /line 3 .* is not the recalled statement/);
});
