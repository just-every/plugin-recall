// The indexer: mines the statements you typed from your agent homes (homes.mjs), incrementally, and embeds each new statement once.
//   claude   <home>/projects/**/<session>.jsonl                         (sub-agent transcripts excluded)
//   codex    <home>/{sessions,archived_sessions}/**/rollout-*.jsonl[.zst] (interactive sessions only; exec and sub-agent rollouts excluded)
//   code     the same, for Every Code (~/.code)
//   history  <home>/history.jsonl, every kind: the typed-prompt log, for what no transcript holds any more (transcripts/history-scan.mjs)
// Transcripts are read first, then the typed-prompt logs, so that a row a transcript already yields is skipped.
// Incremental: per file the scan state keeps (size, mtime, byte offset, line count), so a growing transcript is read from where it
// stopped and an unchanged one is not opened, except once after the owner-text rules change what a turn yields (transcripts/peel-backfill.mjs).
// A statement's id is a hash of (host, ts, text): re-reading a file, the same turn copied into another home or a forked session, or a
// rollout archived to another directory, never duplicates it (transcripts/rollout-moves.mjs keeps the scan state and the src of a moved
// rollout), and a turn whose text an earlier version of the rules read differently keeps the statement it has (turn-identity.mjs), which the
// one-time backfill rewrites in place or retires (transcripts/rejudge.mjs).
// Everything dropped is counted by reason, and every candidate turn that ownerText() rejected is written to
// <dataDir>/logs/index-dropped.jsonl with its reason.
// A dry run (`recall index --dry-run`) scans every transcript from scratch in memory and writes nothing: no statements, no scan state, no
// embeddings, no logs. It reports what an index would hold, and compares that with the index already on disk, per source.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filterOptions, judgeOwnerText } from "./owner-filter.mjs";
import { repairStatementRepos } from "./repo-repair.mjs";
import { indexedHomes } from "./homes.mjs";
import { historyLog, isArchivedRollout, listTranscripts } from "./transcripts/files.mjs";
import { rolloutSessionId } from "./transcripts/codex.mjs";
import { isHistoryFile } from "./transcripts/history.mjs";
import { claudeStatementKey, scanHistoryFile, sessionStatementKey } from "./transcripts/history-scan.mjs";
import { needsPeelBackfill, stampPeel } from "./transcripts/peel-backfill.mjs";
import { createRejudge } from "./transcripts/rejudge.mjs";
import { adoptMovedRollouts, pickRolloutCopies, repointMovedSources } from "./transcripts/rollout-moves.mjs";
import { scanClaudeFile, scanCodexFile } from "./transcripts/scan.mjs";
import { createTally } from "./transcripts/tally.mjs";
import { readTypedLogs } from "./transcripts/typed-rows.mjs";
import { createTurnIndex } from "./turn-identity.mjs";
import { ensureEmbeddings } from "./embed-store.mjs";
import { embedInput, norm, sha1, textHash, tsMicros } from "./text.mjs";

const RECALL_BLOCK = /<recall-context>[\s\S]*?<\/recall-context>/g;

/**
 * Judge one raw owner turn and build the statement row, or say why not. `peeled` names the envelope peels that kept the owner's words.
 * @returns {{statement: object, peeled?: string[]}|{reason: string}}
 */
export function buildStatement({ raw, ts, host, session_id, repo, src, tsSeq }, config) {
  const judged = judgeOwnerText(String(raw).replace(RECALL_BLOCK, " "), filterOptions(config));
  if (!judged.text) return { reason: judged.reason };
  if (!ts) return { reason: "no-timestamp" };
  try { tsMicros(ts); } catch { return { reason: "bad-timestamp" }; }
  const text = judged.text;
  return {
    ...(judged.peeled ? { peeled: judged.peeled } : {}),
    statement: {
      id: `${host}-${sha1(`${host}\u0000${ts}\u0000${norm(text)}`, 16)}`,
      text,
      ts,
      session_id,
      repo: repo ?? null,
      host,
      hash: textHash(text),
      src,
      // a rollout turn's place among the turns of its file that share its time (turn-identity.mjs)
      ...(Number.isInteger(tsSeq) ? { ts_seq: tsSeq } : {}),
    },
  };
}

/** Which source a candidate came from, for the per-source counts: "<home>|transcripts", "<home>|archived" or "<home>|history". */
const sourceOf = (home, file) => `${home.dir}|${isHistoryFile(file) ? "history" : isArchivedRollout(file) ? "archived" : "transcripts"}`;

/** A file is unchanged when its size and mtime are what the scan state says (and the state is not waiting for rows to settle). */
const unchanged = (prev, f) => prev && !prev.pending && prev.size === f.size && prev.mtimeMs === f.mtimeMs;

/**
 * Where a pass reads a file from: its scan state (on from there), or null (from the start) for a rollout skipped before legacy rollouts were
 * readable, a .zst rollout (it cannot be resumed), a file shorter than the state says, and once for a state from before the current peel
 * version (`backfill`: peel-backfill.mjs).
 */
function readFrom(prev, f) {
  if (!prev) return { from: null, backfill: false };
  const backfill = needsPeelBackfill(prev);
  const shrank = !f.file.endsWith(".zst") && f.size < prev.offset;
  const restart = backfill || shrank || f.file.endsWith(".zst") || prev.skip === "no-session-meta";
  return { from: restart ? null : prev, backfill, shrank };
}

/** The key of every indexed Claude transcript statement (project directory + text), so a history row it already holds is skipped. */
function claudeKeysOf(statements) {
  const keys = new Set();
  for (const s of statements) {
    const file = s.host === "claude" && typeof s.src === "string" ? s.src.replace(/:L\d+$/, "") : null;
    if (file && !isHistoryFile(file)) keys.add(claudeStatementKey(path.basename(path.dirname(file)), s.text));
  }
  return keys;
}

/** The key of every indexed Every Code rollout statement (session + text), so an /auto goal row a rollout already holds is skipped. */
function codeKeysOf(statements) {
  const keys = new Set();
  for (const s of statements) if (s.host === "code" && typeof s.src === "string" && !isHistoryFile(s.src.replace(/:L\d+$/, ""))) keys.add(sessionStatementKey(s.session_id, s.text));
  return keys;
}

/**
 * Run one incremental index pass.
 * @param {{config: object, store: object, api?: object, log?: (s: string) => void, homeDir?: string, env?: object, concurrency?: number, embed?: boolean, deadlineAt?: number, dryRun?: boolean, now?: () => number, onStatement?: (statement: object, about: {source: string, peeled: string[]}) => void}} o
 *   homeDir / env: the home folder and the environment the standard homes are looked up in (default: this process's).
 *   onStatement: called with every statement the pass keeps (a dry run's too), for tools that look at what an index would hold.
 */
export async function runIndex({ config, store, api, log = () => {}, homeDir, env = process.env, concurrency = 4, embed = true, deadlineAt, dryRun = false, now = Date.now, onStatement = () => {} }) {
  const started = Date.now();
  const state = dryRun ? { files: {} } : store.loadState();
  const mined = await indexedHomes(config, { ...(homeDir ? { homeDir } : {}), env });
  if (mined.skipped.length) log(`agent homes found but not read (add them to config "homes" to read them): ${mined.skipped.join(", ")}`);
  let existing = store.loadStatements();
  const known = dryRun ? new Set() : new Set(existing.map((s) => s.id));
  const found = dryRun ? new Map() : null; // dry run: statement id -> {hash, chars, ts, source, peeled} of what a scan would index
  const tally = createTally();
  const home = homeDir ?? os.homedir();
  const claudeKeys = claudeKeysOf(existing); // grows with every Claude transcript statement this pass reads
  const codeKeys = codeKeysOf(existing); // grows with every Every Code rollout statement this pass keeps
  const dropFile = path.join(config.dataDir, "logs", "index-dropped.jsonl");
  if (!dryRun) fs.mkdirSync(path.dirname(dropFile), { recursive: true });
  const summary = { homes: mined.homes.map((h) => h.dir), files: 0, scanned: 0, skippedUnchanged: 0, rescanned: 0, backfilled: 0, backfillLinesKept: 0, candidates: 0, added: 0, duplicates: 0, sameTurnOtherId: 0, sourcesMoved: 0, perHost: {}, perSource: {} };

  const jobs = [];
  const moves = [];
  const rolloutSessions = new Set(); // the session of every rollout of every home read: a history row of one of them is skipped
  const histories = [];
  for (const h of mined.homes) {
    let files = listTranscripts(h.dir, h.kind);
    if (h.kind !== "claude") {
      files = pickRolloutCopies(files, state, tally);
      moves.push(...adoptMovedRollouts({ home: h.dir, files, state }));
      for (const f of files) rolloutSessions.add(rolloutSessionId(f.file));
    }
    for (const f of files) jobs.push({ home: h, f });
    const typedLog = historyLog(h.dir);
    if (typedLog) histories.push({ home: h, f: typedLog });
  }
  summary.files = jobs.length + histories.length;
  log(`${jobs.length} transcript files and ${histories.length} typed-prompt logs in ${mined.homes.length} homes`);
  // Statements follow a moved rollout before any scan state is saved: a pass that dies in between finds the move again next time.
  if (moves.length) {
    log(`${moves.length} rollouts moved (archived) since the last pass: their scan state and statement sources follow them`);
    summary.sourcesMoved = repointMovedSources(store, moves);
    if (summary.sourcesMoved) existing = store.loadStatements();
  }
  const turns = createTurnIndex(dryRun ? [] : existing); // grows with every statement this pass keeps
  const rejudge = createRejudge(existing); // a backfill judges again the lines that hold a statement (transcripts/rejudge.mjs)
  const save = () => { rejudge.flush(store); store.saveState(state); };

  // What the typed-prompt logs say (transcripts/typed-rows.mjs): a legacy rollout (no session_meta) is the owner's when a log names its
  // session, an Every Code rollout's turns are decided against the typed rows. Read once, and only when such a rollout needs it.
  let typed = null;
  const typedLogs = () => (typed ??= readTypedLogs(histories));
  const ctx = { tally, home, typedLogs, now: now() };

  /**
   * The rules that judge a statement by what the index holds from other sources: a Claude history row a transcript of its project already
   * holds, an /auto goal row a rollout statement of its session already holds. Records the keys a transcript statement adds. Null: none applies.
   */
  const heldElsewhere = (c, s, file) => {
    const key = c.claudeProject ? claudeStatementKey(c.claudeProject, s.text) : null;
    if (key && isHistoryFile(file)) {
      if (claudeKeys.has(key)) return "history-in-transcript";
    } else if (key) claudeKeys.add(key);
    if (c.autoGoal && codeKeys.has(sessionStatementKey(c.session_id, s.text))) return "history-in-transcript";
    if (c.host === "code" && !isHistoryFile(file)) codeKeys.add(sessionStatementKey(c.session_id, s.text));
    return null;
  };
  /** Judge a candidate with every current rule: buildStatement's result, or {reason} when heldElsewhere drops it. */
  const judge = (c, file) => {
    const b = buildStatement(c, config);
    const why = b.statement ? heldElsewhere(c, b.statement, file) : null;
    return why ? { reason: why } : b;
  };

  /**
   * Judge a file's candidates and keep the new statements. A backfill admits only lines that hold no statement yet, and judges the statements
   * of the others again, those of the lines it judged (`judged`: up to `through`, judgedOf) but was offered no candidate for included
   * (rejudge.mjs).
   */
  const admit = (h, file, candidates, { backfill = false, judged = { through: 0 } } = {}) => {
    const rows = [];
    const source = sourceOf(h, file);
    const offered = new Set();
    const produced = new Set();
    for (const c of candidates) {
      const held = backfill ? rejudge.held(c.src) : [];
      if (held.length) {
        summary.backfillLinesKept++;
        const b = judge(c, file);
        offered.add(c.src);
        if (b.statement) produced.add(b.statement.id);
        for (const s of rejudge.line(held, b, known)) turns.add(s);
        continue;
      }
      summary.candidates++;
      const b = judge(c, file);
      if (!b.statement) {
        tally.drop(b.reason);
        if (!dryRun && b.reason !== "history-in-transcript") fs.appendFileSync(dropFile, `${JSON.stringify({ ts: new Date().toISOString(), host: c.host, src: c.src, reason: b.reason, preview: norm(c.raw).slice(0, 80) })}\n`);
        continue;
      }
      produced.add(b.statement.id);
      if (known.has(b.statement.id)) { summary.duplicates++; continue; }
      if (turns.other(b.statement, { alone: c.tsAlone === true })) { summary.sameTurnOtherId++; continue; }
      known.add(b.statement.id);
      turns.add(b.statement);
      rejudge.added(b.statement);
      rows.push(b.statement);
      summary.perHost[c.host] = (summary.perHost[c.host] ?? 0) + 1;
      summary.perSource[source] = (summary.perSource[source] ?? 0) + 1;
      if (dryRun) found.set(b.statement.id, { hash: b.statement.hash, chars: embedInput(b.statement.text).length, ts: b.statement.ts, source, peeled: b.peeled ?? [] });
      onStatement(b.statement, { source, peeled: b.peeled ?? [] });
    }
    if (rows.length) {
      if (!dryRun) store.appendStatements(rows);
      summary.added += rows.length;
    }
    if (backfill) rejudge.unoffered({ file, offered, produced, ...judged });
  };
  /** How far a scan judged a file: all of a file it rejected whole (a session that is not a person's), with its verdict, else up to where it stopped. */
  const judgedOf = (st) => (st.skip && st.skip !== "no-session-meta" ? { through: Infinity, reason: st.skip } : { through: st.lines });
  /** A file's new scan state. A backfill that stopped before a turn that must wait is not stamped: the next pass backfills it again whole. */
  const nextState = (st, backfill) => (backfill && st.pending ? st : stampPeel(st));

  let next = 0;
  let sinceSave = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const { home: h, f } = jobs[i];
      const prev = state.files[f.file];
      if (unchanged(prev, f) && prev.skip !== "no-session-meta" && !needsPeelBackfill(prev)) { summary.skippedUnchanged++; continue; }
      const { from, backfill, shrank } = readFrom(prev, f);
      if (prev && !from) { summary.rescanned++; if (backfill) summary.backfilled++; if (shrank) log(`file shrank, rescanning from 0: ${f.file}`); }
      let result;
      try {
        result = h.kind === "claude" ? await scanClaudeFile(f, from, ctx) : await scanCodexFile(f, h.kind, from, { ...ctx, agentHome: h.dir });
      } catch (e) {
        if (e.code === "ENOENT") { tally.drop("file-vanished"); continue; }
        throw new Error(`indexing ${f.file}: ${e.message}`);
      }
      summary.scanned++;
      admit(h, f.file, result.out, { backfill, judged: judgedOf(result.state) });
      state.files[f.file] = nextState(result.state, backfill);
      if (!dryRun && ++sinceSave >= 200) { sinceSave = 0; save(); log(`scanned ${summary.scanned + summary.skippedUnchanged}/${jobs.length} files, ${summary.added} new statements`); }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // the typed-prompt logs, once every transcript statement is known
  for (const { home: h, f } of histories) {
    const prev = state.files[f.file];
    if (unchanged(prev, f) && !needsPeelBackfill(prev)) { summary.skippedUnchanged++; continue; }
    const { from, backfill, shrank } = readFrom(prev, f);
    if (prev && !from) { summary.rescanned++; if (backfill) summary.backfilled++; if (shrank) log(`file shrank, rescanning from 0: ${f.file}`); }
    let result;
    try {
      result = await scanHistoryFile(f, from, { kind: h.kind, rolloutSessions, tally, home, now: now() });
    } catch (e) {
      if (e.code === "ENOENT") { tally.drop("file-vanished"); continue; }
      throw new Error(`indexing ${f.file}: ${e.message}`);
    }
    summary.scanned++;
    admit(h, f.file, result.out, { backfill, judged: judgedOf(result.state) });
    state.files[f.file] = nextState(result.state, backfill);
  }

  if (dryRun) return dryRunReport({ started, summary, found, existing, store, tally });
  state.lastIndexAt = new Date().toISOString();
  save();
  summary.rejudged = rejudge.counts;
  summary.reposRepaired = repairStatementRepos({ store, state, homeDir: home });

  let embedding = { embedded: 0, requests: 0, costUsd: 0, inputTokens: 0 };
  if (embed) {
    const have = store.loadEmbeddings();
    const todo = store.loadStatements().filter((s) => !have.has(s.hash));
    if (todo.length) {
      log(`embedding ${todo.length} statements`);
      embedding = await ensureEmbeddings({ texts: todo.map((s) => s.text), store, api, deadlineAt, log, have });
    }
  }
  const report = { at: new Date().toISOString(), durationMs: Date.now() - started, ...summary, excluded: tally.counts, embedding: { embedded: embedding.embedded, requests: embedding.requests, costUsd: embedding.costUsd, inputTokens: embedding.inputTokens } };
  fs.mkdirSync(path.join(config.dataDir, "state"), { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, "state", "last-index.json"), JSON.stringify(report, null, 2));
  return report;
}

/**
 * What a dry run reports: the scan's counts, what embedding it would cost, how it differs from the index on disk (vsIndex), the same per
 * source and per envelope peel (bySource, byPeel: statements the scan finds / of them not in the index yet), and whether every indexed
 * statement is still produced with the same text (idStability; an indexed statement whose transcript is gone cannot be).
 */
function dryRunReport({ started, summary, found, existing, store, tally }) {
  const indexed = new Map(existing.map((s) => [s.id, s]));
  const addedTs = [...found].filter(([id]) => !indexed.has(id)).map(([, v]) => v.ts).sort();
  const { added: _found, perSource: _perSource, ...counts } = summary;
  // what embedding the scan's statements would cost: one request input per distinct text that has no embedding yet
  const have = store.embeddedHashes();
  const todo = new Map([...found.values()].filter((v) => !have.has(v.hash)).map((v) => [v.hash, v.chars]));
  const bySource = {};
  const byPeel = {};
  const count = (map, key, isNew) => { map[key] ??= { statements: 0, added: 0 }; map[key].statements++; if (isNew) map[key].added++; };
  for (const [id, v] of found) {
    const isNew = !indexed.has(id);
    count(bySource, v.source, isNew);
    for (const p of v.peeled) count(byPeel, p, isNew);
  }
  const removed = [...indexed.values()].filter((s) => !found.has(s.id));
  const srcGone = (s) => { const file = typeof s.src === "string" ? s.src.replace(/:L\d+$/, "") : null; return !file || !fs.existsSync(file); };
  const present = removed.filter((s) => !srcGone(s));
  return {
    dryRun: true, at: new Date().toISOString(), durationMs: Date.now() - started, ...counts, statements: found.size,
    toEmbed: { texts: todo.size, chars: [...todo.values()].reduce((a, b) => a + b, 0) },
    vsIndex: { indexed: indexed.size, added: addedTs.length, addedOldest: addedTs[0] ?? null, addedNewest: addedTs.at(-1) ?? null, removed: removed.length },
    idStability: {
      kept: indexed.size - removed.length,
      textChanged: [...found].filter(([id, v]) => indexed.has(id) && indexed.get(id).hash !== v.hash).length,
      removedSourceGone: removed.length - present.length,
      removedSourcePresent: present.length,
      removedSourcePresentSample: present.slice(0, 10).map((s) => s.id),
    },
    bySource, byPeel,
    excluded: tally.counts,
  };
}
