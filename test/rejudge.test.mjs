// An upgrade judges again every line that already holds a statement (transcripts/rejudge.mjs), so an upgraded index holds what a fresh index
// of the same files would: a statement the current rules reject is retired (out of statements.jsonl, into retired.jsonl with the reason; its
// card is never attached again), one they read to another text is rewritten in place under its id (its card survives, its new text is
// embedded), the rest are untouched. A line the pass did not reach is not judged, and the file is backfilled again until it is read to the end.
// Synthetic homes and hand-made indexes of earlier versions; the embeddings come from the fake API; no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appendCards, cardsPath, loadCards } from "../scripts/lib/cards/cards-file.mjs";
import { attachCards } from "../scripts/lib/cards/eligibility.mjs";
import { buildCard } from "../scripts/lib/cards/schema.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { loadIndexedCorpus } from "../scripts/lib/index-corpus.mjs";
import { buildStatement, runIndex } from "../scripts/lib/indexer.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { HISTORY_SETTLE_MS } from "../scripts/lib/transcripts/history-scan.mjs";
import { PEEL_VERSION } from "../scripts/lib/transcripts/peel-backfill.mjs";
import { norm, sha1, textHash } from "../scripts/lib/text.mjs";
import { claudeUser, codexAgent, codexUser, writeTranscript } from "./transcript-builders.mjs";
import { fakeOpenAI, tmpDir } from "./helpers.mjs";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const idOf = (host, ts, text) => `${host}-${sha1(`${host}\u0000${ts}\u0000${norm(text)}`, 16)}`;
const row = (host, text, ts, session_id, src, repo = null) => ({ id: idOf(host, ts, text), text, ts, session_id, repo, host, hash: textHash(text), src });
const stateOf = (file, lines, meta) => { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs, offset: st.size, lines, ...(meta ? { meta, seenEvents: false } : {}) }; };
const view = (store) => store.loadStatements().map((s) => [s.id, s.text]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const retired = (store) => (fs.existsSync(store.retiredFile) ? fs.readFileSync(store.retiredFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---- world E: an Every Code home that 0.3.x indexed whole (it knew no typed-prompt log) ----
const A = "0190e000-ee00-7000-8000-00000000ee01"; // no log row, inside the log's span: an agent's review session
const B = "0190e000-ee00-7000-8000-00000000ee02"; // the person typed one prompt; Auto Drive wrote the other
const T = "0190e000-ee00-7000-8000-00000000ee03";
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const codeMeta = (id, ts) => JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, timestamp: ts, cwd: "/home/sam/projects/shop", originator: "codex_cli_rs", cli_version: "0.4.0", source: "cli", thread_source: "user" } });
const codeUser = (text, ts) => JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const REVIEW = "Context: Repo /home/sam/projects/shop. Review the unstaged changes for correctness and report findings by file";
const GOAL = "Primary goal: make the checkout button green. Plan first, then implement in small steps and verify each one";

function worldE() {
  const root = tmpDir("recall-rejudge-e");
  const home = path.join(root, ".code");
  const day = path.join(home, "sessions", "2026", "03", "02");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(home, "history.jsonl"), [
    { session_id: T, ts: sec("2026-03-01T09:00:00Z"), text: "Typed in another session: tidy the cart module" },
    { session_id: B, ts: sec("2026-03-02T09:00:00Z"), text: "Make the checkout button green" },
    { session_id: T, ts: sec("2026-03-03T09:00:00Z"), text: "Typed later: ship the cart tidy-up" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const fa = writeTranscript(`rollout-2026-03-02T10-00-00-${A}.jsonl`, [codeMeta(A, "2026-03-02T10:00:00.000Z"), codeUser(REVIEW, "2026-03-02T10:00:05.000Z")], day);
  const fb = writeTranscript(`rollout-2026-03-02T09-00-00-${B}.jsonl`, [codeMeta(B, "2026-03-02T09:00:00.000Z"), codeUser("Make the checkout button green", "2026-03-02T09:00:01.000Z"), codeUser(GOAL, "2026-03-02T09:05:00.000Z")], day);
  const meta = (id, ts) => ({ id, cwd: "/home/sam/projects/shop", git_url: null, source: "cli", thread_source: "user", originator: "codex_cli_rs", timestamp: ts });
  const data = (label) => path.join(root, `data-${label}`);
  const old = createStore(data("up"));
  old.appendStatements([
    row("code", REVIEW, "2026-03-02T10:00:05.000Z", A, `${fa}:L2`, "shop"),
    row("code", "Make the checkout button green", "2026-03-02T09:00:01.000Z", B, `${fb}:L2`, "shop"),
    row("code", GOAL, "2026-03-02T09:05:00.000Z", B, `${fb}:L3`, "shop"),
  ]);
  old.saveState({ files: { [fa]: stateOf(fa, 2, meta(A, "2026-03-02T10:00:00.000Z")), [fb]: stateOf(fb, 3, meta(B, "2026-03-02T09:00:00.000Z")) }, lastIndexAt: null });
  const run = (label) => { const config = loadConfig({ RECALL_DATA: data(label) }); const store = createStore(config.dataDir); return runIndex({ config, store, homeDir: root, env: {}, embed: false, now: () => NOW }).then((report) => ({ report, store })); };
  return { run };
}

test("world E: the upgrade retires what the current Every Code rules reject, and then equals a fresh index by id and text", async () => {
  const w = worldE();
  const up = await w.run("up");
  const fresh = await w.run("fresh");
  assert.deepEqual(view(up.store), view(fresh.store));
  assert.equal(up.report.rejudged.retired, 2);
  assert.deepEqual(retired(up.store).map((s) => [s.text, s.retired.reason, s.retired.rules]).sort(), [
    [REVIEW, "line-not-a-candidate", PEEL_VERSION],
    [GOAL, "line-not-a-candidate", PEEL_VERSION],
  ].sort());
  assert.ok(view(up.store).some(([, t]) => t === "Make the checkout button green"));
  const again = await w.run("up");
  assert.equal(again.report.scanned, 0, "stamped: nothing is read again");
  assert.deepEqual(view(again.store), view(fresh.store));
});

// ---- an owner-text rule that now rejects a line, a rewrite with its card and embedding, a twin line ----
const SESSION = "0190f000-bf11-7000-8000-00000000bf09";
const NAME = `rollout-2026-09-05T10-00-00-${SESSION}.jsonl`;
const CT = ["2026-09-05T10:00:05.000Z", "2026-09-05T10:02:00.000Z", "2026-09-05T10:04:00.000Z"];
const codexMeta = JSON.stringify({ timestamp: "2026-09-05T10:00:00.000Z", type: "session_meta", payload: { id: SESSION, timestamp: "2026-09-05T10:00:00.000Z", cwd: "/home/sam/projects/shop", originator: "Codex Desktop", cli_version: "0.50.0", source: "vscode", thread_source: "user" } });
const BROWSER = "# Browser comments:\n\n## User Comment 1\nTarget: button.checkout\nComment: make the pay button blue\n\n## My request for Codex:\nAnd put the coupon field under the order total";
const RESUME = "I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.";

function worldMixed() {
  const root = tmpDir("recall-rejudge-mixed");
  const day = path.join(root, ".codex", "sessions", "2026", "09", "05");
  fs.mkdirSync(day, { recursive: true });
  // line 4 is a response-item copy of the event on line 5 (Codex writes a message twice): 0.3.x had indexed the copy's line
  const twin = JSON.stringify({ timestamp: CT[2], type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Keep the order totals right aligned on small screens too" }] } });
  const rollout = writeTranscript(NAME, [codexMeta, codexUser(BROWSER, CT[0]), codexAgent("Done."), twin, codexUser("Keep the order totals right aligned on small screens too", CT[2])], day);
  const project = path.join(root, ".claude", "projects", "-home-sam-projects-shop");
  fs.mkdirSync(project, { recursive: true });
  const claudeSession = "5eee0000-0000-4000-8000-0000000000c1";
  const transcript = writeTranscript(`${claudeSession}.jsonl`, [claudeUser("Use the shared money helper for every total on the checkout page", "2026-09-06T09:00:00.000Z"), claudeUser(RESUME, "2026-09-06T11:41:35.000Z")], project);
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const api = fakeOpenAI();
  const runtime = createRuntime(config, { post: api.post });
  const store = runtime.store;
  const browserOld = row("codex", "make the pay button blue", CT[0], SESSION, `${rollout}:L2`, "shop");
  const twinOld = row("codex", "Keep the order totals right aligned on small screens too", CT[2], SESSION, `${rollout}:L4`, "shop");
  const resumeOld = row("claude", RESUME, "2026-09-06T11:41:35.000Z", claudeSession, `${transcript}:L2`, "shop");
  const plain = buildStatement({ raw: "Use the shared money helper for every total on the checkout page", ts: "2026-09-06T09:00:00.000Z", host: "claude", session_id: claudeSession, repo: "shop", src: `${transcript}:L1` }, config).statement;
  store.appendStatements([browserOld, twinOld, plain, resumeOld]);
  store.saveState({ files: {
    [rollout]: { ...stateOf(rollout, 5), meta: { id: SESSION, cwd: "/home/sam/projects/shop", source: "vscode", thread_source: "user", originator: "Codex Desktop", timestamp: "2026-09-05T10:00:00.000Z" }, seenEvents: true, peel: 1 },
    [transcript]: { ...stateOf(transcript, 2), peel: 1 },
  }, lastIndexAt: null });
  const at = "2026-09-07T00:00:00.000Z";
  appendCards(cardsPath(config.dataDir), [browserOld, resumeOld].map((s) => buildCard({ statement: s, entry: { n: 1, kind: "rule", scope: "repo", gist: "the owner was reviewing the checkout page" }, model: "haiku", at, gistSource: "transcript" })));
  const run = (o = {}) => runIndex({ config, store, api: runtime.api, homeDir: root, env: {}, now: () => NOW, ...o });
  return { root, config, store, run, browserOld, twinOld, resumeOld, plain };
}

test("a line an owner-text rule now rejects is retired with the rule's reason; its card stays on disk but no statement carries it", async () => {
  const w = worldMixed();
  const report = await w.run();
  assert.equal(report.rejudged.retired, 1);
  assert.deepEqual(retired(w.store).map((s) => [s.id, s.retired.reason]), [[w.resumeOld.id, "harness"]]);
  assert.ok(!w.store.loadStatements().some((s) => s.id === w.resumeOld.id));
  const cards = loadCards(cardsPath(w.config.dataDir));
  assert.ok(cards.has(w.resumeOld.id), "the card file is append-only and keeps it");
  const { corpus } = loadIndexedCorpus(w.store);
  attachCards(corpus, cards);
  assert.ok(!corpus.items.some((it) => it.id === w.resumeOld.id));
});

test("a line the rules now read to another text is rewritten under its id: the card survives, the new text is embedded, nothing is added", async () => {
  const w = worldMixed();
  const report = await w.run();
  assert.equal(report.rejudged.rewritten, 1);
  assert.equal(report.added, 0);
  const s = w.store.loadStatements().find((x) => x.id === w.browserOld.id);
  assert.equal(s.text, "make the pay button blue And put the coupon field under the order total");
  assert.equal(s.hash, textHash(s.text));
  assert.deepEqual(s.rewritten, { at: s.rewritten.at, rules: PEEL_VERSION, previousHash: w.browserOld.hash });
  assert.ok(w.store.loadEmbeddings().has(s.hash), "the rewritten text has its own embedding");
  const { corpus } = loadIndexedCorpus(w.store);
  attachCards(corpus, loadCards(cardsPath(w.config.dataDir)));
  const item = corpus.items.find((it) => it.id === w.browserOld.id);
  assert.equal(item.text, s.text);
  assert.equal(item.card.gist, "the owner was reviewing the checkout page");
});

test("a statement on a line the scan no longer offers is kept when another line of the file makes the same statement (Codex's twin)", async () => {
  const w = worldMixed();
  await w.run();
  const twin = w.store.loadStatements().find((x) => x.id === w.twinOld.id);
  assert.ok(twin, "the event on line 5 makes the same statement as the response item 0.3.x read on line 4");
  assert.equal(twin.src.split(":L")[1], "4");
  const fresh = await w.run({ dryRun: true });
  assert.deepEqual([fresh.vsIndex.removed, fresh.vsIndex.added], [1, 1], "a fresh scan makes every statement the upgraded index holds, the rewritten one under its fresh id");
  assert.deepEqual(fresh.idStability.removedSourcePresentSample, [w.browserOld.id]);
});

// ---- a backfill that stops before a turn that must wait ----
test("a backfill that stops before a waiting turn leaves that line's statement, and backfills the file again until it is read to the end", async () => {
  const root = tmpDir("recall-rejudge-wait");
  const home = path.join(root, ".code");
  const day = path.join(home, "sessions", "2026", "09", "30");
  fs.mkdirSync(day, { recursive: true });
  const S = "0190e000-ee00-7000-8000-00000000ee21";
  const young = new Date(NOW - 60_000).toISOString();
  const typed = "Rename the export button to Download on every page of the shop";
  const coordinator = "Next step: wire the streaming writer into the CLI and remove the buffered path entirely";
  const file = writeTranscript(`rollout-2026-09-30T23-00-00-${S}.jsonl`, [codeMeta(S, "2026-09-30T23:00:00.000Z"), codeUser(typed, "2026-09-30T23:00:05.000Z"), codeUser(coordinator, young)], day);
  fs.writeFileSync(path.join(home, "history.jsonl"), `${JSON.stringify({ session_id: S, ts: sec("2026-09-30T23:00:04Z"), text: typed })}\n`);
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  const kept = row("code", typed, "2026-09-30T23:00:05.000Z", S, `${file}:L2`, "shop");
  const waiting = row("code", coordinator, young, S, `${file}:L3`, "shop");
  store.appendStatements([kept, waiting]);
  store.saveState({ files: { [file]: { ...stateOf(file, 3, { id: S, cwd: "/home/sam/projects/shop", git_url: null, source: "cli", thread_source: "user", originator: "codex_cli_rs", timestamp: "2026-09-30T23:00:00.000Z" }), peel: 1 } }, lastIndexAt: null });
  const run = (now) => runIndex({ config, store, homeDir: root, env: {}, embed: false, now: () => now });
  const first = await run(NOW);
  assert.equal(first.rejudged.retired, 0, "line 3 was not reached: it is not judged");
  assert.equal(store.loadState().files[file].pending, true);
  assert.notEqual(store.loadState().files[file].peel, PEEL_VERSION, "not stamped while the backfill is unfinished");
  const second = await run(NOW + HISTORY_SETTLE_MS);
  assert.equal(second.backfilled, 1);
  assert.deepEqual(retired(store).map((s) => [s.id, s.retired.reason]), [[waiting.id, "line-not-a-candidate"]], "settled, and nobody typed it");
  assert.equal(store.loadState().files[file].peel, PEEL_VERSION);
  assert.deepEqual(store.loadStatements().map((s) => s.id), [kept.id]);
});

// ---- a rule that judges a line by another source: a Claude history row a transcript of its project now holds ----
test("a typed-prompt log row 0.4.0 indexed before its project's transcript was read is retired once the backfill finds the transcript", async () => {
  const root = tmpDir("recall-rejudge-elsewhere");
  const cwd = "/home/sam/projects/shop";
  const text = "Keep the coupon field under the order total on every checkout page";
  const ts = "2026-09-08T09:00:00.000Z";
  const log = path.join(root, ".claude", "history.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, `${JSON.stringify({ display: text, pastedContents: {}, timestamp: Date.parse(ts), project: cwd, sessionId: "5eee0000-0000-4000-8000-0000000000d1" })}\n`);
  // the transcript sits in a home that config `homes` lists, added after 0.4.0 indexed the log row
  const other = path.join(root, ".claude_old");
  const project = path.join(other, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(project, { recursive: true });
  writeTranscript("5eee0000-0000-4000-8000-0000000000d1.jsonl", [claudeUser(text, "2026-09-08T09:00:01.000Z")], project);
  const config = loadConfig({ RECALL_DATA: path.join(root, "data"), RECALL_HOMES: JSON.stringify([{ path: other, kind: "claude" }]) });
  const store = createStore(config.dataDir);
  const logRow = row("claude", text, ts, "5eee0000-0000-4000-8000-0000000000d1", `${log}:L1`, "shop");
  store.appendStatements([logRow]);
  store.saveState({ files: { [log]: { ...stateOf(log, 1), peel: 1 } }, lastIndexAt: null });
  const report = await runIndex({ config, store, homeDir: root, env: {}, embed: false, now: () => NOW });
  assert.equal(report.backfilled, 1);
  assert.deepEqual(retired(store).map((s) => [s.id, s.retired.reason]), [[logRow.id, "history-in-transcript"]]);
  assert.deepEqual(store.loadStatements().map((s) => [s.text, s.src.includes("history.jsonl") ? "log" : "transcript"]), [[text, "transcript"]]);
});
