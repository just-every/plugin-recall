// Statement enrichment: one card per statement, written by a CLI worker (`claude -p --model haiku` when a Claude home is eligible, else
// `codex exec`: run.mjs chooses; routed to an eligible home by the router) from the statement and the context BEFORE it only. Statements are numbered into batches of about 40; at most 4 calls run at
// once. Every returned card is validated; what is invalid or missing is asked again once, and a statement still without a valid card after
// its second attempt is left without one and listed loudly (never given a made-up card). Incremental: ids that already have a card are
// skipped. No eligible worker home aborts the run (nothing is retried against a wall).
import path from "node:path";
import { WorkerSkipped } from "../cli-worker.mjs";
import { RouterError } from "../router.mjs";
import { appendCards } from "./cards-file.mjs";
import { createCodeOwners } from "./code-owner.mjs";
import { isHistoryFile } from "../transcripts/history.mjs";
import { historyContexts } from "../transcripts/history-context.mjs";
import { fileExists, groupBySession, matchKey, parseSrc, priorStatement, scanContexts } from "./context-source.mjs";
import { buildPrompt, loadPromptTemplate } from "./prompt.mjs";
import { BATCH_SCHEMA, buildCard, modelEntryProblems } from "./schema.mjs";

export const BATCH_SIZE = 40;
export const CONCURRENCY = 4;
export const MAX_ATTEMPTS = 2;
// A card needs no reasoning: with extended thinking on, haiku took 137 s for a batch of 40 that takes 21 s without (measured 2026-10-08).
export const WORKER_ENV = Object.freeze({ MAX_THINKING_TOKENS: "0" });
const SCAN_CONCURRENCY = 4;

const isFatal = (e) => e instanceof WorkerSkipped || e instanceof RouterError;

/** A small async queue: the transcript scanners put contexts in, the batch workers take batches out. */
function createQueue(batchSize) {
  const items = [];
  const waiters = [];
  let closed = false;
  const wake = () => waiters.splice(0).forEach((w) => w());
  return {
    push(batch) { items.push(...batch); wake(); },
    close() { closed = true; wake(); },
    abort() { items.length = 0; closed = true; wake(); },
    async take() {
      for (;;) {
        if (items.length >= batchSize || (closed && items.length)) return items.splice(0, batchSize);
        if (closed) return null;
        await new Promise((r) => waiters.push(r));
      }
    },
  };
}

/**
 * Work out the context of every pending statement, by transcript where there is one. Calls `emit` with batches of
 * {statement, context, gistSource} as they become ready.
 */
async function resolveContexts({ pending, population, liveIndex, config, codeOwners, emit, log, tally }) {
  const bySession = groupBySession(population);
  const live = liveIndex ? new Map(liveIndex.filter((s) => parseSrc(s.src)).map((s) => [matchKey(s), s])) : null;
  const jobs = []; // statements with a transcript line to read
  const ready = [];
  const viaPrior = (statement, why) => {
    tally[why] = (tally[why] ?? 0) + 1;
    const prev = priorStatement(bySession, statement);
    return { statement, context: { owner: prev?.text ?? null, assistant: null }, gistSource: prev ? "prior-statement" : "none" };
  };
  for (const statement of pending) {
    let src = parseSrc(statement.src);
    let via = "transcript";
    if (!src && live) {
      const match = live.get(matchKey(statement));
      if (match) { src = parseSrc(match.src); via = "index"; }
    }
    if (src) jobs.push({ statement, src, via }); else ready.push(viaPrior(statement, "noTranscriptSource"));
  }
  if (ready.length) emit(ready.splice(0));

  const byFile = new Map();
  for (const job of jobs) {
    if (!byFile.has(job.src.file)) byFile.set(job.src.file, []);
    byFile.get(job.src.file).push(job);
  }
  const files = [...byFile.entries()];
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const entry = files[next++];
      if (!entry) return;
      const [file, group] = entry;
      const out = [];
      if (!fileExists(file)) {
        for (const job of group) out.push(viaPrior(job.statement, "transcriptMissing"));
      } else {
        const host = group[0].statement.host;
        const history = isHistoryFile(file);
        const targets = group.map((j) => ({ key: j.statement.id, line: j.src.line, text: j.statement.text }));
        let contexts = null;
        try {
          // a typed-prompt log: the previous row of the same session is the context (history-context.mjs)
          // an Every Code rollout: only the turns the person typed are owner messages (code-owner.mjs)
          contexts = history ? await historyContexts({ file, config, targets, host })
            : await scanContexts({ file, host, config, targets, ...(host === "code" ? { codeOwner: await codeOwners(file) } : {}) });
        } catch (e) {
          log(`ERROR: cannot read the context from ${file}: ${e.message}; its ${group.length} statements get the previous owner statement instead`);
          for (const job of group) out.push(viaPrior(job.statement, "transcriptUnreadable"));
        }
        for (const job of contexts ? group : []) {
          const c = contexts.get(job.statement.id);
          if (!c) out.push(viaPrior(job.statement, "lineBeyondTranscript"));
          else if (c.mismatch) out.push(viaPrior(job.statement, "lineIsNotTheStatement"));
          else out.push({ statement: job.statement, context: c, gistSource: c.owner || c.assistant ? (history ? "history" : job.via) : "none" });
        }
      }
      emit(out);
      if (++done % 200 === 0) log(`read the context of ${done}/${files.length} transcripts`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, files.length) }, worker));
}

/** Check one batch answer against the batch; returns {good: Map(n -> entry), problems: Map(n -> [..]), strays: string[]}. */
export function checkAnswer(answer, count) {
  const good = new Map();
  const problems = new Map();
  const strays = [];
  const seen = new Map();
  const entries = Array.isArray(answer?.cards) ? answer.cards : null;
  if (!entries) return { good, problems, strays: ["the answer has no cards array"], fatal: true };
  for (const e of entries) {
    const n = e?.n;
    if (!Number.isInteger(n) || n < 1 || n > count) { strays.push(`an entry numbered ${JSON.stringify(n)} is not in this batch of ${count}`); continue; }
    seen.set(n, (seen.get(n) ?? 0) + 1);
    const p = modelEntryProblems(e);
    if (p.length) problems.set(n, p); else good.set(n, e);
  }
  for (const [n, times] of seen) {
    if (times > 1) { good.delete(n); problems.set(n, [`answered ${times} times`]); }
  }
  return { good, problems, strays, fatal: false };
}

/**
 * @param {{statements: object[], existing: Set<string>|Map<string, object>, outFile: string, runWorker: Function, config: object,
 *          population?: object[], liveIndex?: object[]|null, model?: string, batchSize?: number, concurrency?: number, limit?: number,
 *          promptTemplate?: string, now?: () => Date, log?: (s: string) => void}} o
 *   statements   the statements to enrich (a live index, or a contract corpus)
 *   population   the statements context may be taken from when there is no transcript (default: statements)
 *   liveIndex    for a corpus without src: the live index to match its statements against
 *   homeDir, env where the homes are whose typed-prompt logs decide an Every Code rollout's owner turns (as for the indexer)
 * @returns {Promise<{pending: number, written: number, failed: {id: string, problems: string[]}[], tally: object, calls: number, homes: string[]}>}
 */
export async function enrichStatements({
  statements, existing, outFile, runWorker, config, population = statements, liveIndex = null, worker = "claude", model = worker === "claude" ? "haiku" : null,
  batchSize = BATCH_SIZE, concurrency = CONCURRENCY, limit = 0, promptTemplate = loadPromptTemplate(), now = () => new Date(), log = () => {},
  homeDir, env,
}) {
  const missing = statements.filter((s) => !existing.has(s.id));
  const pending = limit ? missing.slice(0, limit) : missing;
  const result = { pending: pending.length, written: 0, failed: [], tally: {}, calls: 0, homes: [] };
  if (!pending.length) return result;
  log(`${pending.length} statements to enrich (${statements.length - missing.length} already have a card${limit && missing.length > pending.length ? `, ${missing.length - pending.length} more beyond --limit` : ""})`);

  const queue = createQueue(batchSize);
  let fatal = null;
  const homes = new Set();

  const askBatch = async (items) => {
    let todo = items;
    for (let attempt = 1; todo.length; attempt++) {
      let answer;
      let reasons = null;
      try {
        result.calls++;
        const r = await runWorker({ kind: worker, ...(model ? { model } : {}), schema: BATCH_SCHEMA, env: WORKER_ENV, prompt: buildPrompt(promptTemplate, todo) });
        if (r.home) homes.add(r.home);
        answer = r.json;
      } catch (e) {
        if (isFatal(e)) throw e;
        reasons = [`the worker call failed: ${e.message}`];
      }
      const retry = [];
      const cards = [];
      if (reasons) todo.forEach((it) => retry.push({ it, problems: reasons }));
      else {
        const checked = checkAnswer(answer, todo.length);
        for (const s of checked.strays) log(`WARNING: ${s}`);
        todo.forEach((it, i) => {
          const entry = checked.good.get(i + 1);
          if (entry) cards.push(buildCard({ statement: it.statement, entry, model: model ?? worker, at: now().toISOString(), gistSource: it.gistSource }));
          else retry.push({ it, problems: checked.problems.get(i + 1) ?? [checked.fatal ? "the answer was unusable" : "the statement got no card"] });
        });
      }
      if (cards.length) { appendCards(outFile, cards); result.written += cards.length; }
      if (!retry.length) return;
      if (attempt >= MAX_ATTEMPTS) {
        for (const { it, problems } of retry) {
          result.failed.push({ id: it.statement.id, problems });
          log(`ERROR: no card for ${it.statement.id} after ${MAX_ATTEMPTS} attempts: ${problems.join("; ")}`);
        }
        return;
      }
      log(`${retry.length} of ${todo.length} statements need another attempt (${retry[0].problems[0]})`);
      todo = retry.map((r) => ({ ...r.it, note: r.problems.join("; ") }));
    }
  };

  const batchWorker = async () => {
    for (;;) {
      const batch = await queue.take();
      if (!batch) return;
      try {
        await askBatch(batch);
      } catch (e) {
        fatal ??= e;
        queue.abort();
        return;
      }
      log(`${result.written} cards written, ${result.failed.length} failed`);
    }
  };

  const codeOwners = createCodeOwners({ config, ...(homeDir ? { homeDir } : {}), ...(env ? { env } : {}), now: now().getTime() });
  const producer = resolveContexts({ pending, population, liveIndex, config, codeOwners, emit: (b) => queue.push(b), log, tally: result.tally })
    .catch((e) => { fatal ??= e; queue.abort(); })
    .finally(() => queue.close());
  await Promise.all([producer, ...Array.from({ length: concurrency }, batchWorker)]);
  result.homes = [...homes];
  if (fatal) throw fatal;
  const lost = Object.entries(result.tally).map(([k, v]) => `${k}: ${v}`).join(", ");
  if (lost) log(`WARNING: some statements were enriched without their transcript (${lost}); their cards say gist_source prior-statement or none`);
  return result;
}

export const cardsOutName = (corpusPath) => `cards-${path.basename(corpusPath).replace(/\.jsonl$/, "")}.jsonl`;
