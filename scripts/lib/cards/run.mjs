// `recall enrich` and the enrichment pass of `recall index`: pick the statements and the output file, take the lock, run the worker pool.
import fs from "node:fs";
import path from "node:path";
import { acquireLock, LockTimeoutError, readLock } from "../lock.mjs";
import { validateCorpusRow } from "../eval.mjs";
import { cardsPath, loadCards } from "./cards-file.mjs";
import { cardsOutName, enrichStatements } from "./enrich.mjs";

const ENRICH_LOCK_STALE_MS = 12 * 3_600_000;

/** Another process is already writing the same cards file. */
export class EnrichBusy extends Error {
  constructor(message) { super(message); this.name = "EnrichBusy"; }
}

function readCorpus(file) {
  const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`corpus ${file} line ${i + 1} is not JSON`); }
  });
  rows.forEach(validateCorpusRow);
  return rows;
}

/**
 * Which worker writes the cards, as an eligible-worker choice like home routing. "auto": `claude -p --model haiku` when the router finds a
 * usable Claude home (by default the current host's own), otherwise codex when it finds a usable codex home, otherwise an error naming why
 * neither is. "claude" or "codex" asks for that one only. The choice is made once per run, before anything is written.
 * @returns {Promise<{worker: "claude"|"codex", home: string, usedPercent: number}>}
 */
export async function pickWorker({ router, requested = "auto", log = () => {} }) {
  const kinds = requested === "auto" ? ["claude", "codex"] : [requested];
  const refused = [];
  for (const kind of kinds) {
    const p = await router.pick(kind);
    if (p.home) {
      log(`card writer: ${kind} worker, home ${p.home}${p.usedPercent === undefined ? "" : ` (${p.usedPercent}% used)`}${refused.length ? `; ${refused.join("; ")}` : ""}`);
      return { worker: kind, home: p.home, usedPercent: p.usedPercent };
    }
    refused.push(`no ${kind} worker home is eligible: ${p.reason} (${JSON.stringify(p.considered)})`);
  }
  throw new Error(refused.join("; "));
}

/**
 * @param {{config: object, runtime: object, corpus?: string, out?: string, limit?: number, worker?: "auto"|"claude"|"codex", model?: string, log?: (s: string) => void,
 *          preflight?: () => Promise<{worker: "claude"|"codex"}>}} o
 *   Without `corpus`: the data dir's statements, cards written to <data>/cards.jsonl. With a contract corpus (no src): its statements, cards
 *   written to `out` (default <data>/cards-<corpus name>.jsonl, never the live file), context matched to the live index.
 *   `preflight` chooses the worker (default: pickWorker over the router); `model` overrides the worker's model (default: haiku for claude, the
 *   home's default for codex).
 */
export async function runEnrich({ config, runtime, corpus = null, out = null, limit = 0, worker = "auto", model = null, log = () => {}, preflight = () => pickWorker({ router: runtime.router, requested: worker, log }) }) {
  const live = runtime.store.loadStatements();
  const statements = corpus ? readCorpus(corpus) : live;
  const outFile = path.resolve(out ?? (corpus ? path.join(config.dataDir, cardsOutName(corpus)) : cardsPath(config.dataDir)));
  if (corpus && outFile === cardsPath(config.dataDir)) throw new Error("a contract corpus must not write the live cards file; pass another --out");
  const lockFile = path.join(config.dataDir, "locks", `enrich-${path.basename(outFile)}.lock`);
  let lock;
  try {
    lock = acquireLock(lockFile, { staleMs: ENRICH_LOCK_STALE_MS, timeoutMs: 0 });
  } catch (e) {
    if (!(e instanceof LockTimeoutError)) throw e;
    const holder = readLock(lockFile);
    throw new EnrichBusy(`another recall enrich is already writing ${outFile} (pid ${holder?.pid ?? "?"} since ${holder?.at ?? "?"}); lock ${lockFile}`);
  }
  try {
    const existing = loadCards(outFile);
    const chosen = await preflight();
    const result = await enrichStatements({
      statements, existing, outFile, runWorker: runtime.runWorker, config, worker: chosen.worker, model: model ?? (chosen.worker === "claude" ? "haiku" : null), limit, log,
      liveIndex: corpus ? live : null, ...(runtime.homeDir ? { homeDir: runtime.homeDir } : {}),
    });
    return { out: outFile, worker: chosen.worker, statements: statements.length, alreadyCarded: existing.size, ...result };
  } finally {
    lock.release();
  }
}
