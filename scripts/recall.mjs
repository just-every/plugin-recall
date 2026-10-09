#!/usr/bin/env node
// recall CLI.
//   recall setup [--yes] [--homes <list>] [--exclude <list>] [--new-key] [--no-index] [--skip-key] [--no-save-key] [--daily-cap <usd>] [--dry-run]   set up or update Recall in every agent home (also: recall, recall install, npx -y @just-every/plugin-recall)
//   recall pause, recall resume                                 stop Recall at once in every agent home without removing it ("disabled" in config.json), and turn it back on
//   recall uninstall [--yes] [--purge] [--homes <list>]         remove Recall from every agent home (--purge: and delete the data dir; --homes: only from these homes)
//   recall doctor [--json] [--offline]                          check the setup: node, OpenAI key, CLIs, homes and transcripts, data dir, plugin installs
//   recall monitor [--port 4777] [--host 127.0.0.1]             live web view of what the hooks do (read-only, loopback only, never opens a browser)
//   recall query <text> [--session <id>] [--before <iso>] [--pipeline <name>] [--mode prompt|stop] [--k <n>] [--repo <name>] [--any-repo] [--kind <kind[,kind]>] [--json] [--no-cache]   (the text may also be given as --text <t>)
//   recall show <statement-id> [--before 4] [--after 3] [--json]  the conversation around a recalled statement, from its transcript (reads only; logs one line)
//   recall logs [--day YYYY-MM-DD] [--days n] [--json]          what the hooks did: counts by outcome and silence reason (default: today, UTC)
//   recall spend                                                ledger totals (today, all time) and the caps
//   recall index [--no-embed] [--enrich] [--quiet] [--dry-run]  index statements now (--enrich: then write cards for the new ones; --dry-run: scan and count, write nothing)
//   recall enrich [--limit n] [--worker auto|claude|codex] [--model haiku]   write a card (kind, scope, gist) for each statement without one
//   recall help [--all], recall --version                      the help (--all: every command, wrapped; onboarding/help.mjs), the version
// Developer commands (evaluation and research; `recall help --all` lists them only with RECALL_DEVELOPER=1):
//   recall index --durable [--corpus <jsonl>]                   also build the offline A4 durable typing
//   recall enrich --corpus <contract corpus jsonl> --out <cards jsonl>   write cards for a contract corpus instead of the index
//   recall eval --corpus <jsonl> --cases <jsonl> --pipeline <name> --out <jsonl> [--cards <jsonl>] [--inject-out <jsonl>] [--hub-history <jsonl>] [--v1|--v2] [--embedding-store dir] [--concurrency n] [--limit n] [--no-cache]
//   recall pipelines                                            the named pipelines
// Data lives in RECALL_DATA (default: ~/.plugin-recall, shared by every home and host). See README.md for every setting.
import "./lib/quiet-sqlite-warning.mjs"; // first: drops Node 22's SQLite ExperimentalWarning before node:sqlite can load
import fs from "node:fs";
import path from "node:path";
import { attachCards } from "./lib/cards/eligibility.mjs";
import { cardsPath, loadCards } from "./lib/cards/cards-file.mjs";
import { EnrichBusy, runEnrich } from "./lib/cards/run.mjs";
import { KINDS } from "./lib/cards/schema.mjs";
import { loadConfig, needsCards, V1_ENV, V2_ENV } from "./lib/config.mjs";
import { runEval, validateCorpusRow } from "./lib/eval.mjs";
import { buildDurableIndex } from "./lib/durable-store.mjs";
import { runIndex } from "./lib/indexer.mjs";
import { DEFAULT_AFTER, DEFAULT_BEFORE, showStatement } from "./lib/show.mjs";
import { loadIndexedCorpus } from "./lib/index-corpus.mjs";
import { INDEX_LOCK_STALE_MS } from "./lib/auto-index.mjs";
import { acquireLock, adoptLock, LockTimeoutError, readLock, sleepSync } from "./lib/lock.mjs";
import { runMonitor } from "./monitor/cli.mjs";
import { checkArgv, runOnboarding } from "./onboarding/cli.mjs";
import { fullHelp, help } from "./onboarding/help.mjs";
import { ONE_LINER, pluginMeta } from "./onboarding/plugin-meta.mjs";
import { wrapWidth } from "./onboarding/ui.mjs";
import { UsageError } from "./lib/usage-error.mjs";
import { formatSummary, logDays, summarizeLogs } from "./lib/log-summary.mjs";
import { PIPELINES } from "./lib/pipelines/index.mjs";
import { gated, retrieve } from "./lib/retrieve.mjs";
import { repoOfSession } from "./lib/repo-identity.mjs";
import { createRuntime } from "./lib/runtime.mjs";
import { createStore } from "./lib/store.mjs";
import { clip, norm } from "./lib/text.mjs";

const BOOLEAN = ["json", "no-embed", "enrich", "quiet", "no-cache", "durable", "v1", "v2", "dry-run", "any-repo", "yes", "offline", "no-index", "skip-key", "no-save-key", "new-key", "purge", "help", "all", "version"];
const SHORT = { "-y": "yes", "-h": "help", "-v": "version" };

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = SHORT[argv[i]] ? `--${SHORT[argv[i]]}` : argv[i];
    if (!a.startsWith("--")) {
      // one bare argument is allowed: the query text (`recall query "should I add a fallback"`)
      if (flags.has("_")) throw new UsageError(`unexpected argument ${JSON.stringify(a)}`);
      flags.set("_", a);
      continue;
    }
    const name = a.slice(2);
    if (BOOLEAN.includes(name)) flags.set(name, true);
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      flags.set(name, v);
    }
  }
  return flags;
}
const need = (flags, name) => { if (!flags.has(name)) throw new Error(`--${name} is required`); return flags.get(name); };
const err = (s) => process.stderr.write(`${s}\n`);

/** The index lock: adopt the one the auto-index hook handed us (--lock), else take it; a second concurrent index is an error, never a race. */
function takeIndexLock(config, flags) {
  const file = flags.get("lock") ?? path.join(config.dataDir, "state", "index.lock");
  if (flags.has("lock")) {
    for (let waited = 0; waited < 3000; waited += 25) {
      const adopted = adoptLock(file);
      if (adopted) return adopted;
      sleepSync(25); // the hook hands the lock over right after spawning us
    }
  }
  try {
    return acquireLock(file, { staleMs: INDEX_LOCK_STALE_MS, timeoutMs: 0 });
  } catch (e) {
    if (!(e instanceof LockTimeoutError)) throw e;
    const holder = readLock(file);
    throw new Error(`another recall index is already running (pid ${holder?.pid ?? "?"} since ${holder?.at ?? "?"}); lock ${file}`);
  }
}

/** `recall index --dry-run`: scan every transcript from scratch in memory and report what an index would hold. Writes nothing, takes no lock, spends nothing. */
async function cmdIndexDryRun(flags) {
  if (["no-embed", "enrich", "durable", "corpus"].some((f) => flags.has(f))) throw new Error("--dry-run scans and counts only; it takes none of --no-embed, --enrich, --durable, --corpus");
  const config = loadConfig();
  const quiet = flags.has("quiet");
  const report = await runIndex({ config, store: createStore(config.dataDir), embed: false, dryRun: true, log: (s) => { if (!quiet) err(s); } });
  console.log(JSON.stringify(report, null, 2));
}

async function cmdIndex(flags) {
  if (flags.has("dry-run")) return cmdIndexDryRun(flags);
  const env = flags.has("no-cache") ? { ...process.env, RECALL_NO_CACHE: "1" } : process.env;
  const config = loadConfig(env);
  const lock = takeIndexLock(config, flags);
  const quiet = flags.has("quiet");
  const runtime = createRuntime(config, { log: (e) => { if (e.level === "error") err(`[recall worker] ${JSON.stringify(e)}`); } });
  let report;
  try {
    if (flags.has("corpus") && !flags.has("durable")) throw new Error("index --corpus requires --durable");
    report = flags.has("corpus") ? {} : await runIndex({ config, store: runtime.store, api: runtime.api, embed: !flags.has("no-embed"), log: (s) => { if (!quiet) err(s); } });
    if (flags.has("durable")) {
      const items = flags.has("corpus") ? fs.readFileSync(flags.get("corpus"), "utf8").split("\n").filter(Boolean).map(JSON.parse) : runtime.store.loadStatements();
      if (flags.has("corpus")) items.forEach(validateCorpusRow);
      report.durable = await buildDurableIndex({ items, dir: config.dataDir, deps: runtime.makeDeps() });
    }
  } finally {
    lock.release(); // the enrichment below can take long; a new index pass must not wait for it
  }
  // New statements get their cards through the router (a claude worker on an eligible home, else a codex one). The index above is already safe on disk.
  if (flags.has("enrich") && !flags.has("corpus")) {
    try {
      report.enrich = await runEnrich({ config, runtime, log: (s) => { if (!quiet) err(s); } });
      if (report.enrich.failed.length) process.exitCode = 1;
    } catch (e) {
      if (e instanceof EnrichBusy) report.enrich = { skipped: e.message };
      else { report.enrich = { error: e.message }; err(`recall index: enrich FAILED: ${e.message}`); process.exitCode = 1; }
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

async function cmdEnrich(flags) {
  const config = loadConfig();
  const runtime = createRuntime(config, { log: (e) => { if (e.level === "error") err(`[recall worker] ${JSON.stringify(e)}`); } });
  const limit = flags.has("limit") ? Number(flags.get("limit")) : 0;
  if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer");
  const worker = flags.get("worker") ?? "auto";
  if (!["auto", "claude", "codex"].includes(worker)) throw new Error("--worker must be auto, claude or codex");
  const result = await runEnrich({ config, runtime, corpus: flags.get("corpus") ?? null, out: flags.get("out") ?? null, limit, worker, ...(flags.has("model") ? { model: flags.get("model") } : {}), log: err });
  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length) { err(`recall enrich: ${result.failed.length} statements have no card (listed above and in the result)`); process.exitCode = 1; }
}

function cmdLogs(flags) {
  const config = loadConfig();
  let days;
  if (flags.has("day")) days = [flags.get("day")];
  else if (flags.has("days")) days = logDays(config.dataDir, Number(need(flags, "days")));
  else days = [new Date().toISOString().slice(0, 10)];
  const summary = summarizeLogs(config.dataDir, days);
  console.log(flags.has("json") ? JSON.stringify({ dataDir: config.dataDir, ...summary }, null, 2) : `${config.dataDir}/logs\n\n${formatSummary(summary)}`);
}

/** The settings a query runs under: the config, with --kind limiting the eligible card kinds and --any-repo lifting the repo rules (the scope rule and the cross-repo length limit). */
function queryConfig(config, flags) {
  let cfg = config;
  if (flags.has("kind")) {
    const want = String(flags.get("kind")).split(/[\s,]+/).filter(Boolean);
    const bad = want.filter((k) => !KINDS.includes(k));
    if (!want.length || bad.length) throw new Error(`--kind takes ${KINDS.join(", ")} (comma separated); got ${JSON.stringify(flags.get("kind"))}`);
    cfg = { ...cfg, excludeKinds: KINDS.filter((k) => !want.includes(k)) };
  }
  if (flags.has("any-repo")) cfg = { ...cfg, scopeFilter: false, crossRepoMaxChars: 0 };
  return cfg;
}

async function cmdQuery(flags) {
  if (flags.has("_") && flags.has("text")) throw new Error("give the query text once: as the argument or as --text, not both");
  const text = flags.get("text") ?? flags.get("_");
  if (!text) throw new Error('the query text is required: recall query "<text>"');
  const base = loadConfig(flags.has("no-cache") ? { ...process.env, RECALL_NO_CACHE: "1" } : process.env);
  const config = queryConfig(base, flags);
  const runtime = createRuntime(base);
  const pipeline = flags.get("pipeline") ?? config.pipeline;
  const mode = flags.get("mode") ?? "prompt";
  const k = flags.has("k") ? Number(flags.get("k")) : config.k;
  if (!Number.isInteger(k) || k < 1) throw new Error("--k must be a positive integer");
  const decisionTs = flags.get("before") ?? new Date().toISOString();
  const info = loadIndexedCorpus(runtime.store);
  if (!info.corpus.items.length) throw new Error(`the index at ${config.dataDir} is empty; run: recall index`);
  if (info.withoutEmbedding) err(`WARNING: ${info.withoutEmbedding} indexed statements have no embedding yet and are not searchable (run: recall index)`);
  if (needsCards(config) && !attachCards(info.corpus, loadCards(cardsPath(config.dataDir)))) throw new Error(`no statement cards in ${cardsPath(config.dataDir)}; run: recall enrich (or set the v2 flags to their v1 values)`);
  // The repo the card filter compares with: --repo, else the repository this command runs in (what a hook takes from its payload's cwd).
  const currentRepo = flags.has("repo") ? flags.get("repo") : repoOfSession({ cwd: process.cwd() });
  const stats = {};
  const res = await retrieve({
    corpus: info.corpus, query: text, mode, decisionTs, excludeSession: flags.get("session") ?? null, threadId: flags.get("session") ?? null, currentRepo, pipeline,
    deps: runtime.makeDeps({ deadlineAt: Date.now() + 120000, stats }), cfg: config, stats,
  });
  const top = res.ranked.slice(0, k);
  const injected = new Set(gated(pipeline, res.ranked, config, config.k).map((e) => e.id));
  const rows = top.map((e, i) => {
    const it = info.corpus.items[info.corpus.byId.get(e.id)];
    return { rank: i + 1, id: e.id, score: e.score, parts: e.parts, ts: it.ts, repo: it.repo, host: it.host, session_id: it.session_id, text: it.text, kind: it.card?.kind ?? null, would_inject: injected.has(e.id) };
  });
  if (flags.has("json")) {
    console.log(JSON.stringify({ query: text, pipeline, mode, decision_ts: decisionTs, eligible: res.eligible, results: rows, stats }, null, 2));
    return;
  }
  console.log(`pipeline ${pipeline}, ${res.eligible} eligible statements, ${Math.round(stats.totalMs ?? 0)} ms, $${((stats.costUsd ?? 0) + (stats.embedCostUsd ?? 0)).toFixed(5)}`);
  for (const r of rows) console.log(`${String(r.rank).padStart(2)}. ${r.score.toFixed(4)}${r.would_inject ? " *" : "  "} ${r.ts.slice(0, 10)} ${r.repo ?? "-"} | ${clip(norm(r.text), 160)}`);
  console.log("(* = would pass to the hook's apply gate; query does not run the gate)");
}

async function cmdEval(flags) {
  if (flags.has("v1") && flags.has("v2")) throw new Error("--v1 and --v2 are exclusive");
  // --v1 / --v2 set every v2 flag (and k) over the environment and config.json, so one command line names the behaviour under test
  const config = loadConfig({ ...process.env, ...(flags.has("no-cache") ? { RECALL_NO_CACHE: "1" } : {}), ...(flags.has("v1") ? V1_ENV : {}), ...(flags.has("v2") ? V2_ENV : {}) });
  const runtime = createRuntime(config);
  const result = await runEval({
    // the eval corpus is embedded into its own store, so it never grows (and slows) the hooks' index
    store: createStore(flags.get("embedding-store") ?? path.join(config.dataDir, "eval-store")),
    corpusPath: need(flags, "corpus"), casesPath: need(flags, "cases"), pipeline: need(flags, "pipeline"), outPath: need(flags, "out"),
    cardsFile: flags.get("cards") ?? null, injectOutPath: flags.get("inject-out") ?? null, hubHistoryPath: flags.get("hub-history") ?? null, config, runtime,
    concurrency: flags.has("concurrency") ? Number(flags.get("concurrency")) : 8, limit: flags.has("limit") ? Number(flags.get("limit")) : 0, log: err,
  });
  console.log(JSON.stringify({ ...result, spentToday: runtime.ledger.spentToday(), spentTotal: runtime.ledger.spentTotal() }));
  if (result.failed || result.notRun) process.exitCode = 1;
}

async function cmdShow(id, flags) {
  if (!id) throw new Error("usage: recall show <statement-id> [--before N] [--after N] [--json]");
  const count = (name, dflt) => (flags.has(name) ? Number(flags.get(name)) : dflt);
  const { view, text } = await showStatement({ id, before: count("before", DEFAULT_BEFORE), after: count("after", DEFAULT_AFTER), config: loadConfig() });
  process.stdout.write(flags.has("json") ? `${JSON.stringify(view, null, 2)}\n` : text);
}

function cmdSpend() {
  const config = loadConfig();
  const runtime = createRuntime(config);
  console.log(JSON.stringify({ dataDir: config.dataDir, ledger: runtime.ledger.file, spentToday: runtime.ledger.spentToday(), dailyCapUsd: config.dailyCapUsd, spentTotal: runtime.ledger.spentTotal(), totalCapUsd: config.totalCapUsd, configFile: config.configFile, sources: { dailyCapUsd: config.sources.dailyCapUsd, totalCapUsd: config.sources.totalCapUsd } }, null, 2));
}

/** The commands whose usage errors exit 2 (the others keep exiting 1). */
const ONBOARDING = new Set(["setup", "install", "uninstall", "pause", "resume", "doctor", "help"]);

const argv = process.argv.slice(2);
// `recall`, `recall -y`, `recall --homes ...`: setup. `--help` (alone, or with setup's options) and `--version` stand alone.
let [cmd, ...rest] = argv;
if (cmd === "--help" || cmd === "-h") { cmd = "help"; rest = []; }
else if (cmd === "--version" || cmd === "-v") cmd = "version";
else if (cmd === undefined || cmd.startsWith("-")) { cmd = "setup"; rest = argv; }
try {
  const positional = cmd === "show" && rest[0] && !rest[0].startsWith("--") ? rest.shift() : null; // the statement id
  if (ONBOARDING.has(cmd) && cmd !== "help") checkArgv(cmd === "install" ? "setup" : cmd, rest);
  const flags = parseArgs(rest);
  if (flags.has("_") && cmd !== "query" && !ONBOARDING.has(cmd)) throw new Error(`unexpected argument ${JSON.stringify(flags.get("_"))}`);
  if (cmd === "index") await cmdIndex(flags);
  else if (cmd === "enrich") await cmdEnrich(flags);
  else if (cmd === "query") await cmdQuery(flags);
  else if (cmd === "eval") await cmdEval(flags);
  else if (cmd === "show") await cmdShow(positional, flags);
  else if (cmd === "spend") cmdSpend();
  else if (cmd === "logs") cmdLogs(flags);
  else if (cmd === "monitor") await runMonitor(flags);
  else if (cmd === "pipelines") console.log(Object.keys(PIPELINES).join("\n"));
  else if (cmd === "setup" || cmd === "install") process.exitCode = await runOnboarding("setup", flags);
  else if (cmd === "doctor" || cmd === "uninstall" || cmd === "pause" || cmd === "resume") process.exitCode = await runOnboarding(cmd, flags);
  else if (cmd === "help") console.log(flags.has("all") ? fullHelp({ width: wrapWidth(process.stdout), developer: process.env.RECALL_DEVELOPER === "1" }) : help(pluginMeta().version));
  else if (cmd === "version") console.log(pluginMeta().version);
  else { err(`recall: unknown command ${JSON.stringify(cmd)}. Run: ${ONE_LINER} --help`); process.exitCode = 2; }
} catch (e) {
  err(`recall ${cmd === "install" ? "setup" : cmd}: ${e.message}`);
  process.exitCode = e instanceof UsageError && ONBOARDING.has(cmd) ? 2 : 1;
}
