// Where a card's context comes from: the transcript line a statement came from (Claude and Codex / Every Code, .jsonl and .jsonl.zst), a
// contract corpus matched to the live index, or the previous statement of the same session. Synthetic transcript lines throughout, shaped like the
// real ones (see transcript-builders.mjs and the rollouts in fixtures/); the worker is a stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { cardsPath, loadCards } from "../scripts/lib/cards/cards-file.mjs";
import { fileExists, groupBySession, matchKey, parseSrc, priorStatement, scanContexts } from "../scripts/lib/cards/context-source.mjs";
import { enrichStatements } from "../scripts/lib/cards/enrich.mjs";
import { EnrichBusy, runEnrich } from "../scripts/lib/cards/run.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { acquireLock } from "../scripts/lib/lock.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { FIXTURES, tmpDir } from "./helpers.mjs";
import { claudeAssistant, claudeQueued, claudeToolResult, claudeToolUse, claudeUser, codexAgent, codexCommand, codexUser, writeTranscript } from "./transcript-builders.mjs";

const config = loadConfig({});
const EVERY_CODE = path.join(FIXTURES, "code/sessions/2026/05/29/rollout-2026-05-29T13-57-42-0190b000-bbbb-7000-8000-00000000e001.jsonl");
const CODEX_TWINS = path.join(FIXTURES, "codex/sessions/2026/09/02/rollout-2026-09-02T15-02-46-0190a000-aaaa-7000-8000-00000000c001.jsonl");

test("parseSrc: <file>:L<line>, nothing else", () => {
  assert.deepEqual(parseSrc("/h/.claude/projects/-x/abc.jsonl:L42"), { file: "/h/.claude/projects/-x/abc.jsonl", line: 42 });
  assert.deepEqual(parseSrc("/h/rollout-1.jsonl.zst:L7"), { file: "/h/rollout-1.jsonl.zst", line: 7 });
  assert.equal(parseSrc("test"), null);
  assert.equal(parseSrc(undefined), null);
  assert.equal(parseSrc("/a/b.jsonl"), null);
});

const OWNER_1 = "Please check why the nightly import is slow and fix it.";
const ASSISTANT_1 = "I found the slow query and added an index. The import now takes 40 seconds. Should I also clean up the old table?";
const STATEMENT = "Never drop tables without asking me first.";

test("Claude: the context is the last assistant text and the owner message before the statement, whatever the tool records between", async () => {
  const lines = [claudeUser(OWNER_1), claudeToolUse(), claudeToolResult(), claudeAssistant("I will look at the query plan."), claudeToolUse(), claudeToolResult(), claudeAssistant(ASSISTANT_1), claudeUser(STATEMENT), claudeAssistant("Understood."), claudeQueued("Also keep the logs short.")];
  const file = writeTranscript("c.jsonl", lines);
  const out = await scanContexts({ file, host: "claude", config, targets: [{ key: "st", line: 8, text: STATEMENT }, { key: "queued", line: 10, text: "Also keep the logs short." }, { key: "first", line: 1, text: OWNER_1 }] });
  assert.deepEqual(out.get("st"), { owner: OWNER_1, assistant: ASSISTANT_1 });
  assert.deepEqual(out.get("queued"), { owner: STATEMENT, assistant: "Understood." }, "a message typed mid-turn (queued_command) is a statement with context too");
  assert.deepEqual(out.get("first"), { owner: null, assistant: null }, "the first message of a session has nothing before it");
});

test("only what comes BEFORE the statement is read: a later turn never leaks into its context", async () => {
  const file = writeTranscript("later.jsonl", [claudeUser(OWNER_1), claudeAssistant("first reply"), claudeUser(STATEMENT), claudeAssistant("LATER REPLY that must not be seen"), claudeUser("a much later owner message")]);
  const out = await scanContexts({ file, host: "claude", config, targets: [{ key: "st", line: 3, text: STATEMENT }] });
  assert.deepEqual(out.get("st"), { owner: OWNER_1, assistant: "first reply" });
});

test("a line that is not the statement is reported as a mismatch, and a line past the end of the file is absent", async () => {
  const file = writeTranscript("mm.jsonl", [claudeUser(OWNER_1), claudeToolUse(), claudeToolResult(), claudeUser(STATEMENT)]);
  const out = await scanContexts({ file, host: "claude", config, targets: [{ key: "tool", line: 3, text: STATEMENT }, { key: "wrong", line: 1, text: STATEMENT }, { key: "gone", line: 99, text: STATEMENT }] });
  assert.deepEqual(out.get("tool"), { mismatch: true });
  assert.deepEqual(out.get("wrong"), { mismatch: true });
  assert.equal(out.has("gone"), false);
});

test("a harness turn is not the previous owner message: it is peeled or skipped, and secrets are redacted", async () => {
  const file = writeTranscript("h.jsonl", [
    claudeUser("Deploy the worker. My key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG please do not print it."),
    claudeAssistant("Deployed."),
    claudeUser("<task-notification>\n<task-id>b7e</task-id>\n<summary>Monitor event: new files</summary>\n</task-notification>"),
    claudeUser(STATEMENT),
  ]);
  const out = await scanContexts({ file, host: "claude", config, targets: [{ key: "st", line: 4, text: STATEMENT }] });
  assert.equal(out.get("st").assistant, "Deployed.");
  assert.ok(!/sk-proj-abcdefghijkl/.test(String(out.get("st").owner)), `the key is not carried into the context: ${out.get("st").owner}`);
});

test("Codex: UserMessage and AgentMessage events are the turns, in .jsonl and in .jsonl.zst", async () => {
  const lines = [codexUser(OWNER_1), codexCommand(), codexAgent(ASSISTANT_1), codexUser(STATEMENT)];
  for (const name of ["rollout-a.jsonl", "rollout-a.jsonl.zst"]) {
    const file = writeTranscript(name, lines);
    if (name.endsWith(".zst")) assert.notEqual(fs.readFileSync(file).toString("utf8", 0, 1), "{", "really compressed");
    const out = await scanContexts({ file, host: "codex", config, targets: [{ key: "st", line: 4, text: STATEMENT }] });
    assert.deepEqual(out.get("st"), { owner: OWNER_1, assistant: ASSISTANT_1 }, name);
  }
});

test("Codex: a message written twice (response item and event) is one message, never its own predecessor", async () => {
  // the rollout: line 3 is a response_item copy of the first message, line 4 its UserMessage event, line 6 the copy of the second, line 7 its event
  const second = JSON.parse(fs.readFileSync(CODEX_TWINS, "utf8").split("\n")[6]).payload.item.content[0].text;
  const out = await scanContexts({ file: CODEX_TWINS, host: "codex", config, targets: [{ key: "second", line: 7, text: second }, { key: "first", line: 4, text: "Please add a CSV export button to the invoices table (and cover it with a test)\n\nAlso check whether the other tables need the same" }] });
  assert.match(out.get("second").owner, /^Please add a CSV export button to the invoices table \(and cover it with a test\)/);
  assert.deepEqual(out.get("first"), { owner: null, assistant: null });
});

test("Every Code (response items only): the previous owner message and assistant reply come from the rollout, the system status message is no owner message", async () => {
  const out = await scanContexts({ file: EVERY_CODE, host: "code", config, targets: [{ key: "q", line: 9, text: "what's new?" }] });
  assert.equal(out.get("q").assistant, "Hey! I am here. What are we working on today?");
  assert.equal(out.get("q").owner, "hey!", "the '== System Status ==' message between them is not the owner's");
});

test("zstd Claude transcript works the same", async () => {
  const file = writeTranscript("c.jsonl.zst", [claudeUser(OWNER_1), claudeAssistant(ASSISTANT_1), claudeUser(STATEMENT)]);
  assert.deepEqual((await scanContexts({ file, host: "claude", config, targets: [{ key: "st", line: 3, text: STATEMENT }] })).get("st"), { owner: OWNER_1, assistant: ASSISTANT_1 });
  assert.ok(fileExists(file) && !fileExists(`${file}.nope`));
  assert.equal(zlib.zstdDecompressSync(fs.readFileSync(file)).toString("utf8").split("\n").length, 4);
});

// ---- enrichment end to end: the context reaches the prompt, and the card says where it came from ----
const row = (over) => ({ id: "x", text: STATEMENT, ts: "2026-09-01T10:00:00.000Z", session_id: "sess", repo: "mobile-app", host: "claude", ...over });
const promptWorker = () => {
  const prompts = [];
  const fn = async (o) => {
    prompts.push(o.prompt);
    const n = Number(/exactly one entry for each of the (\d+) numbered/.exec(o.prompt)[1]);
    return { json: { cards: Array.from({ length: n }, (_, i) => ({ n: i + 1, kind: "rule", scope: "repo", gist: "the agent was working on the import" })) }, home: "/h/.claude_x", kind: "claude" };
  };
  fn.prompts = prompts;
  return fn;
};
const enrich = (statements, opts = {}) => {
  const logs = [];
  const outFile = path.join(tmpDir("recall-enrich-ctx"), "cards.jsonl");
  const w = promptWorker();
  return enrichStatements({ statements, existing: new Map(), outFile, runWorker: w, config, log: (s) => logs.push(s), ...opts }).then((result) => ({ result, logs, cards: loadCards(outFile), w }));
};

test("a statement with a src gets its transcript context; fallbacks are counted, logged and recorded on the card", async () => {
  const claudeFile = writeTranscript("5ccc0000-0000-0000-0000-000000000001.jsonl", [claudeUser(OWNER_1), claudeAssistant(ASSISTANT_1), claudeUser(STATEMENT, "2026-09-01T10:05:00.000Z"), claudeUser("What is next?", "2026-09-01T10:06:00.000Z")]);
  const codexFile = writeTranscript("rollout-2026-09-02T10-00-00-0000.jsonl.zst", [codexUser(OWNER_1), codexAgent(ASSISTANT_1), codexUser(STATEMENT, "2026-09-02T10:05:00.000Z")]);
  const statements = [
    row({ id: "c1", src: `${claudeFile}:L3`, ts: "2026-09-01T10:05:00.000Z" }),
    row({ id: "c0", src: `${claudeFile}:L1`, text: OWNER_1, ts: "2026-09-01T10:00:00.000Z" }),
    row({ id: "x1", host: "codex", src: `${codexFile}:L3`, session_id: "sess2", ts: "2026-09-02T10:05:00.000Z" }),
    row({ id: "gone", src: `${path.join(tmpDir(), "deleted.jsonl")}:L3`, session_id: "sess", ts: "2026-09-03T10:00:00.000Z", text: "A statement whose transcript was deleted." }),
    row({ id: "wrongline", src: `${claudeFile}:L4`, session_id: "sess3", ts: "2026-09-04T10:00:00.000Z", text: "This is not what line four says." }),
    row({ id: "nosrc", session_id: "sess", ts: "2026-09-05T10:00:00.000Z", text: "No source recorded for this one." }),
  ];
  const { result, logs, cards, w } = await enrich(statements);
  assert.equal(result.written, 6);
  const prompt = w.prompts.join("\n");
  assert.ok(prompt.includes(`Previous owner message: ${JSON.stringify(OWNER_1)}\nPrevious assistant message: ${JSON.stringify(ASSISTANT_1)}\nStatement: ${JSON.stringify(STATEMENT)}`), "claude context");
  assert.equal(cards.get("c1").gist_source, "transcript");
  assert.equal(cards.get("x1").gist_source, "transcript", "the codex .zst transcript was read too");
  assert.equal(cards.get("c0").gist_source, "none", "the first message of a session has nothing before it");
  // the fallbacks: previous owner statement of the same session in the statement set, said so on the card
  assert.equal(cards.get("gone").gist_source, "prior-statement");
  assert.equal(cards.get("wrongline").gist_source, "none", "its session has no earlier statement");
  assert.equal(cards.get("nosrc").gist_source, "prior-statement");
  assert.deepEqual(result.tally, { transcriptMissing: 1, lineIsNotTheStatement: 1, noTranscriptSource: 1 });
  const warning = logs.find((l) => l.startsWith("WARNING: some statements were enriched without their transcript"));
  assert.ok(warning, logs.join("\n"));
  for (const part of ["transcriptMissing: 1", "lineIsNotTheStatement: 1", "noTranscriptSource: 1"]) assert.ok(warning.includes(part), warning);
  const gonePrompt = w.prompts.find((p) => p.includes("A statement whose transcript was deleted"));
  assert.match(gonePrompt, /Previous owner message: "[^"]*"\nPrevious assistant message: \(none\)\nStatement: "A statement whose transcript was deleted\."/);
});

test("a contract corpus (no src): matched to the live index by host + normalized text + time, else the previous statement of its session", async () => {
  const transcript = writeTranscript("5ccc0000-0000-0000-0000-000000000009.jsonl", [claudeUser(OWNER_1), claudeAssistant(ASSISTANT_1), claudeUser(STATEMENT, "2026-09-01T10:05:00.000Z")]);
  const live = [row({ id: "live-1", src: `${transcript}:L3`, ts: "2026-09-01T10:05:00.000Z" })];
  const corpus = [
    row({ id: "k1", text: `  ${STATEMENT.toUpperCase()}  `, ts: "2026-09-01T10:05:00Z", session_id: "corpus-sess" }), // other words in the eyes of the match: normalization collapses spaces, it does not fold case
    row({ id: "k2", text: STATEMENT.replace(/ +/g, "  "), ts: "2026-09-01T10:05:00.000000Z", session_id: "corpus-sess2" }), // same text, extra spaces, same instant
    row({ id: "k3", text: "Something the live index never saw.", ts: "2026-09-02T10:00:00Z", session_id: "corpus-sess2" }),
    row({ id: "k4", text: "The very first statement of its session.", ts: "2026-09-03T10:00:00Z", session_id: "corpus-sess4" }),
  ];
  assert.equal(matchKey(corpus[1]), matchKey(live[0]), "host + normalized text + parsed time");
  assert.notEqual(matchKey(corpus[0]), matchKey(live[0]), "different words are a different statement");
  const { result, cards, w } = await enrich(corpus, { liveIndex: live });
  assert.equal(result.written, 4);
  assert.equal(cards.get("k2").gist_source, "index");
  assert.ok(w.prompts[0].includes(`Previous assistant message: ${JSON.stringify(ASSISTANT_1)}`), "the matched statement's transcript context");
  assert.equal(cards.get("k3").gist_source, "prior-statement");
  assert.equal(cards.get("k1").gist_source, "none");
  assert.equal(cards.get("k4").gist_source, "none");
  assert.deepEqual(result.tally, { noTranscriptSource: 3 });
  // priorStatement is by time within the session
  const by = groupBySession(corpus);
  assert.equal(priorStatement(by, corpus[2]).id, "k2");
  assert.equal(priorStatement(by, corpus[1]), null);
});

test("recall enrich on a corpus writes its own cards file, never the live one; a second enrich on the same file is refused while the first runs", async () => {
  const dataDir = tmpDir("recall-enrich-run");
  const cfg = loadConfig({ RECALL_DATA: dataDir });
  const store = createStore(dataDir);
  const corpusFile = path.join(dataDir, "contract.jsonl");
  fs.writeFileSync(corpusFile, `${[row({ id: "k1" }), row({ id: "k2", text: "A second contract statement about logs.", ts: "2026-09-02T10:00:00.000Z" })].map((r) => JSON.stringify(r)).join("\n")}\n`);
  const runtime = { store, runWorker: promptWorker() };
  const noPreflight = async () => ({ worker: "claude" });
  const res = await runEnrich({ config: cfg, runtime, corpus: corpusFile, preflight: noPreflight });
  assert.equal(res.out, path.join(dataDir, "cards-contract.jsonl"));
  assert.equal(res.written, 2);
  assert.equal(fs.existsSync(cardsPath(dataDir)), false, "the live cards file is untouched");
  await assert.rejects(runEnrich({ config: cfg, runtime, corpus: corpusFile, out: cardsPath(dataDir), preflight: noPreflight }), /must not write the live cards file/);
  // incremental on the same out file
  const again = await runEnrich({ config: cfg, runtime, corpus: corpusFile, preflight: noPreflight });
  assert.deepEqual([again.pending, again.written, again.alreadyCarded], [0, 0, 2]);
  // the live index: its statements, cards in <data>/cards.jsonl
  store.appendStatements([row({ id: "live-1", src: "test" })]);
  const live = await runEnrich({ config: cfg, runtime, preflight: noPreflight });
  assert.equal(live.out, cardsPath(dataDir));
  assert.equal(loadCards(cardsPath(dataDir)).size, 1);
  // a held lock refuses a second run, with the holder named
  const lock = acquireLock(path.join(dataDir, "locks", "enrich-cards.jsonl.lock"));
  store.appendStatements([row({ id: "live-2", text: "Another live statement to enrich.", ts: "2026-09-06T10:00:00.000Z" })]);
  await assert.rejects(runEnrich({ config: cfg, runtime, preflight: noPreflight }), (e) => e instanceof EnrichBusy && e.message.includes(`pid ${process.pid}`));
  lock.release();
  assert.equal((await runEnrich({ config: cfg, runtime, preflight: noPreflight })).written, 1);
  // a preflight that finds no worker home fails before anything is written
  const none = async () => { throw new Error("no claude worker home is eligible"); };
  store.appendStatements([row({ id: "live-3", text: "A third live statement to enrich later.", ts: "2026-09-07T10:00:00.000Z" })]);
  await assert.rejects(runEnrich({ config: cfg, runtime, preflight: none }), /no claude worker home is eligible/);
  assert.equal(loadCards(cardsPath(dataDir)).has("live-3"), false);
});
