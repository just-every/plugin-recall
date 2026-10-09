// Offline replay: `recall eval --corpus <jsonl> --cases <jsonl> --pipeline <name> --out <jsonl>`.
//   corpus  {"id","text","ts","session_id","repo","host"}                         (ts ISO-8601, host claude|codex|code)
//   cases   {"case_id","mode":"prompt"|"stop","query","decision_ts","session_id","exclude_ids":[...],
//            "context":{"project","prior":[{"role","text"}]}}    (context optional: it builds the v2 prompt-time situation and names the repo)
//   output  {"case_id","ranked":[{"id","score"} x top 50]}                          (best first)
//   --inject-out additionally writes, per case, the ranking with the judge probabilities and the block the prompt hook would inject before its apply gate (eval does not run the gate)
//   (gate, hubs, repeats of one text, k; noRepeat has nothing to repeat: each case is a separate turn)
//   --hub-history <jsonl> is the run's explicit injection history, {"id","session_id","ts"} per line (a statement injected into a session at a
//   time): a statement already injected into hubMaxSessions other sessions within hubWindowDays BEFORE a case's decision_ts is a hub and is
//   not injected. Without the file nothing is a hub: a replay never reads the live hub index, so it stays deterministic.
// Eligibility is exactly the contract: an item is eligible iff its ts < decision_ts (parsed) and its id is not in exclude_ids.
// session_id is NOT used to exclude anything here: the research prototype found that a third of needles live in the case's own session but outside the
// agent's context, which is what exclude_ids expresses (hooks compute these IDs from the last compaction boundary). It names the case's thread
// for the pipeline's same-thread list (the 30 newest eligible statements of that session).
// The run is resumable (cases already in --out are skipped), writes <out>.stats.jsonl (per-case latency, cost, request counts) and
// <out>.errors.jsonl, and exits non-zero if any case failed. Gold labels are never an input.
import fs from "node:fs";
import { attachCards } from "./cards/eligibility.mjs";
import { loadCards } from "./cards/cards-file.mjs";
import { needsCards } from "./config.mjs";
import { buildCorpus } from "./corpus.mjs";
import { ensureEmbeddings } from "./embed-store.mjs";
import { hubIds } from "./hubs.mjs";
import { caseQuery, validateContext } from "./eval-situation.mjs";
import { selectInjection } from "./injection.mjs";
import { retrieve } from "./retrieve.mjs";
import { situationOf } from "./situations.mjs";
import { textHash, tsMicros } from "./text.mjs";

const HOSTS = new Set(["claude", "codex", "code"]);

function readJsonl(file, what) {
  const rows = [];
  for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { throw new Error(`${what} ${file} line ${i + 1} is not JSON`); }
  }
  return rows;
}

export function validateCorpusRow(r, i) {
  const bad = (m) => { throw new Error(`corpus row ${i + 1}: ${m}`); };
  if (typeof r.id !== "string" || !r.id) bad("id must be a non-empty string");
  if (typeof r.text !== "string" || !r.text.trim()) bad(`text of ${r.id} must be a non-empty string`);
  tsMicros(r.ts);
  if (typeof r.session_id !== "string") bad(`session_id of ${r.id} must be a string`);
  if (!(r.repo === null || typeof r.repo === "string")) bad(`repo of ${r.id} must be a string or null`);
  if (!HOSTS.has(r.host)) bad(`host of ${r.id} must be claude, codex or code`);
}

export function validateCase(c, i) {
  const bad = (m) => { throw new Error(`case ${i + 1}: ${m}`); };
  if (typeof c.case_id !== "string" || !c.case_id) bad("case_id must be a non-empty string");
  if (!["prompt", "stop"].includes(c.mode)) bad(`mode of ${c.case_id} must be prompt or stop`);
  if (typeof c.query !== "string" || !c.query.trim()) bad(`query of ${c.case_id} must be a non-empty string`);
  tsMicros(c.decision_ts);
  if (!Array.isArray(c.exclude_ids)) bad(`exclude_ids of ${c.case_id} must be an array`);
  validateContext(c.context, c.case_id);
}

export function validateHistoryRow(r, i) {
  const bad = (m) => { throw new Error(`hub history row ${i + 1}: ${m}`); };
  if (typeof r.id !== "string" || !r.id) bad("id must be a non-empty string");
  if (typeof r.session_id !== "string" || !r.session_id) bad("session_id must be a non-empty string");
  try { tsMicros(r.ts); } catch (e) { bad(e.message); }
}

export async function runEval({ corpusPath, casesPath, pipeline, outPath, cardsFile = null, injectOutPath = null, hubHistoryPath = null, config, runtime, store = runtime.store, concurrency = 8, limit = 0, caseTimeoutMs = 180000, log = () => {} }) {
  const rows = readJsonl(corpusPath, "corpus");
  rows.forEach(validateCorpusRow);
  let cases = readJsonl(casesPath, "cases");
  cases.forEach(validateCase);
  if (new Set(cases.map((c) => c.case_id)).size !== cases.length) throw new Error("duplicate case_id in cases");
  if (limit) cases = cases.slice(0, limit);

  const hubHistory = hubHistoryPath ? readJsonl(hubHistoryPath, "hub history") : [];
  hubHistory.forEach(validateHistoryRow);

  const emb = await ensureEmbeddings({ texts: rows.map((r) => r.text), store, api: runtime.api, log });
  log(`corpus ${rows.length} items, embedded ${emb.embedded} new ($${emb.costUsd.toFixed(5)})`);
  const corpus = buildCorpus({ statements: rows.map((r) => ({ ...r, hash: textHash(r.text) })), embeddings: emb.have });
  if (corpus.withoutEmbedding.length) throw new Error(`${corpus.withoutEmbedding.length} corpus items have no embedding`);
  if (cardsFile) log(`${attachCards(corpus, loadCards(cardsFile))} of ${rows.length} corpus items have a card (${cardsFile})`);
  else if (needsCards(config)) throw new Error("this configuration needs statement cards (excludeKinds, scopeFilter or itemGist): pass --cards <cards.jsonl>, or --v1 for v1 behaviour");

  const statsFile = `${outPath}.stats.jsonl`;
  const errFile = `${outPath}.errors.jsonl`;
  const done = new Map();
  if (fs.existsSync(outPath)) for (const r of readJsonl(outPath, "output")) done.set(r.case_id, r);
  // A case with a ranking but no injection line is run again (its answers are cached): the injection needs the judge's probabilities.
  const injected = new Map();
  if (injectOutPath && fs.existsSync(injectOutPath)) for (const r of readJsonl(injectOutPath, "inject-out")) injected.set(r.case_id, r);
  if (injectOutPath) for (const id of [...done.keys()]) if (!injected.has(id)) done.delete(id);
  fs.rmSync(errFile, { force: true });
  const todo = cases.filter((c) => !done.has(c.case_id));
  log(`${cases.length} cases, ${done.size} already done, ${todo.length} to run, pipeline ${pipeline}`);

  let next = 0;
  let failed = 0;
  const worker = async () => {
    for (;;) {
      const c = todo[next++];
      if (!c) return;
      const stats = {};
      const t0 = performance.now();
      try {
        const query = caseQuery(c, config);
        const currentRepo = c.context?.project ?? null;
        const res = await retrieve({
          corpus, query, mode: c.mode, decisionTs: c.decision_ts, excludeIds: c.exclude_ids, excludeSession: null, threadId: c.session_id, currentRepo, pipeline,
          deps: runtime.makeDeps({ deadlineAt: Date.now() + caseTimeoutMs, stats }), cfg: config, stats,
        });
        const line = { case_id: c.case_id, ranked: res.ranked.map((r) => ({ id: r.id, score: r.score })) };
        if (injectOutPath) {
          const hubSet = hubIds(hubHistory, { sessionId: c.session_id, nowMs: tsMicros(c.decision_ts) / 1000, windowDays: config.hubWindowDays, maxSessions: config.hubMaxSessions });
          const { picked, repeats, hubs, context } = selectInjection({ ranked: res.ranked, corpus, pipeline, cfg: config, sessionId: c.session_id, currentRepo, hubIds: hubSet });
          const row = {
            case_id: c.case_id, mode: c.mode, current_repo: currentRepo, situation: situationOf(query, c.mode), ranked: res.ranked.map((r) => ({ id: r.id, score: r.score, d: r.parts?.d ?? null })),
            picked: picked.map((e) => e.id), ...(repeats.length ? { repeats } : {}), ...(hubs.length ? { hubs } : {}), context,
          };
          fs.appendFileSync(injectOutPath, `${JSON.stringify(row)}\n`);
          injected.set(c.case_id, row);
        }
        fs.appendFileSync(outPath, `${JSON.stringify(line)}\n`);
        done.set(c.case_id, line);
        fs.appendFileSync(statsFile, `${JSON.stringify({ case_id: c.case_id, mode: c.mode, pipeline, eligible: res.eligible, latency_ms: Math.round(performance.now() - t0), ...stats })}\n`);
      } catch (e) {
        failed++;
        fs.appendFileSync(errFile, `${JSON.stringify({ case_id: c.case_id, error: `${e.name}: ${e.message}` })}\n`);
        log(`CASE FAILED ${c.case_id}: ${e.name}: ${e.message}`);
        if (e.name === "CapExceededError") return; // every later case would fail the same way
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // Final output in case order (the append order above is completion order).
  const ordered = cases.filter((c) => done.has(c.case_id)).map((c) => JSON.stringify(done.get(c.case_id)));
  const tmp = `${outPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, ordered.length ? `${ordered.join("\n")}\n` : "");
  fs.renameSync(tmp, outPath);
  if (injectOutPath) {
    const rows = cases.filter((c) => done.has(c.case_id) && injected.has(c.case_id)).map((c) => JSON.stringify(injected.get(c.case_id)));
    const injectTmp = `${injectOutPath}.${process.pid}.tmp`;
    fs.writeFileSync(injectTmp, rows.length ? `${rows.join("\n")}\n` : "");
    fs.renameSync(injectTmp, injectOutPath);
  }
  return { cases: cases.length, written: ordered.length, failed, notRun: cases.length - ordered.length - failed };
}
