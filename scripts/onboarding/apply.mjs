// Carrying out an accepted plan, one printed line per step, in this order: prove paid access, record it, save the key (or record that it
// stays out of ~/.env), write the settings, write the local marketplace, build the index, start card writing in the background, install
// into every chosen home (4 at a time), the recall command, the installs record, and old copies removed. A failed access check or index
// stops before anything is installed; a failed access check also removes the empty folders the check made, so nothing is left behind.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { INDEX_LOCK_STALE_MS } from "../lib/auto-index.mjs";
import { createApi } from "../lib/api.mjs";
import { runIndex } from "../lib/indexer.mjs";
import { createLedger } from "../lib/ledger.mjs";
import { acquireLock, LockTimeoutError } from "../lib/lock.mjs";
import { keyFingerprint, PROVIDERS } from "../lib/providers/index.mjs";
import { createQuestionCache } from "../lib/question-cache.mjs";
import { createResponseCache } from "../lib/response-cache.mjs";
import { createStore } from "../lib/store.mjs";
import { upsertEnvLine } from "./env-file.mjs";
import { dollars, usd } from "./estimate.mjs";
import { chosen } from "./home-rows.mjs";
import { installHome, readHomeState } from "./hosts/index.mjs";
import { mapLimit } from "./hosts/runner.mjs";
import { recordKeyKeptOut, writeInstalls, writeProviderCheck } from "./install-record.mjs";
import { writeLauncher } from "./launcher.mjs";
import { collectGarbage, versionDir, writeMarketplace } from "./marketplace.mjs";
import { entriesOf, pruneSince } from "./prune.mjs";
import { writeSettings } from "./settings.mjs";
import { padRows } from "./ui.mjs";

/** Prove the key may call each paid endpoint (one tiny request each) and record it. Returns the cost, or the lines to stop with. */
async function checkAccess(ui, a, cfg, now) {
  let spent = 0;
  for (const k of a.accessChecks) {
    const r = await k.provider.access.check({ key: k.key, config: cfg });
    const { label, ability } = k.provider.access;
    if (!r.ok && r.reason === "denied") return { stop: [`  ${ui.glyph("fail")} ${label}: your key has no access.`, ...k.provider.access.deniedText, "Nothing was installed."] };
    if (!r.ok) return { stop: [`  ${ui.glyph("fail")} The check that your key can ${ability} failed (${r.reason}).`, "Run this again in a minute.", "Nothing was installed."] };
    ui.item("ok", `Your key can ${ability} (${usd(r.costUsd)})`);
    spent += r.costUsd;
    const at = now().toISOString();
    writeProviderCheck(cfg.dataDir, k.provider.id, { keyFingerprint: keyFingerprint(k.key), acceptedAt: at, accessConfirmedAt: at });
  }
  return { spent };
}

/** The foreground index, with one progress line on a terminal. Returns {statements, costUsd} or {error}. */
async function buildIndex(ui, cfg, { key, homeDir, env }) {
  const dir = cfg.dataDir;
  const api = createApi({
    ledger: createLedger({ dir, dailyCapUsd: cfg.dailyCapUsd, totalCapUsd: cfg.totalCapUsd }),
    cache: createResponseCache({ dir, enabled: !cfg.noCache }),
    questionCache: createQuestionCache({ dir, enabled: !cfg.noCache }),
    baseUrl: cfg.openaiBaseUrl,
    apiKey: () => key,
  });
  const store = createStore(dir);
  let lock;
  try {
    lock = acquireLock(path.join(dir, "state", "index.lock"), { staleMs: INDEX_LOCK_STALE_MS, timeoutMs: 0 });
  } catch (e) {
    if (e instanceof LockTimeoutError) return { error: "another recall index is running; wait for it to finish" };
    throw e;
  }
  ui.progress("Indexing: reading what you typed");
  try {
    const report = await runIndex({ config: cfg, store, api, homeDir, env, log: (s) => {
      const m = /embedded (\d+)\/(\d+)/.exec(s);
      if (m) ui.progress(`Indexing: ${m[1]}/${m[2]} statements`);
    } });
    return { statements: store.loadStatements().length, costUsd: report.embedding.costUsd };
  } catch (e) {
    return { error: String(e.message).split("\n")[0].slice(0, 200) };
  } finally {
    lock.release();
  }
}

/**
 * `recall enrich --worker <kind>` from the installed copy, detached; its output goes to <dataDir>/logs/setup-enrich.log. The card writer
 * needs only its CLI's own login, so Recall's provider keys (OPENAI_API_KEY) are not passed on to it.
 */
function startCards(cfg, V, writer, env) {
  const childEnv = { ...env, RECALL_DATA: cfg.dataDir };
  for (const p of PROVIDERS) delete childEnv[p.envName];
  const logs = path.join(cfg.dataDir, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const out = fs.openSync(path.join(logs, "setup-enrich.log"), "a");
  const child = spawn(process.execPath, [path.join(versionDir(cfg.dataDir, V), "scripts", "recall.mjs"), "enrich", "--worker", writer], {
    detached: true, stdio: ["ignore", out, out], env: childEnv, cwd: cfg.dataDir, // not the person's cwd (the writer runs its CLI in its own temp dir)
  });
  child.unref();
  fs.closeSync(out);
}

/**
 * @returns {Promise<{exit?: number, stop?: string[], spent: number, results: {row: object, ok: boolean, outcome?: string, reason?: string, trusted: boolean}[], cardsStarted: boolean, indexed: boolean, launcher: string}>}
 */
export async function applyPlan({ ui, plan, rows, keys, V, root, homeDir, env, run, now = () => new Date() }) {
  const { cfg, next, actions: a } = plan;
  const dataDir = cfg.dataDir;
  const before = entriesOf(dataDir);
  const access = await checkAccess(ui, a, cfg, now);
  if (access.stop) { pruneSince(dataDir, before); return { exit: 1, stop: access.stop }; }
  let spent = access.spent;
  for (const k of a.saveKeys) {
    upsertEnvLine(path.join(homeDir, ".env"), k.provider.envName, k.key);
    recordKeyKeptOut(dataDir, k.provider.id, false);
    ui.item("ok", `Saved your ${k.provider.label} key to ~/.env`);
  }
  for (const k of a.keepOutKeys) {
    recordKeyKeptOut(dataDir, k.provider.id, true, now().toISOString());
    ui.item("ok", `Your ${k.provider.label} key stays out of ~/.env on later runs too`);
  }
  if (a.settings.write) {
    const file = writeSettings(dataDir, next);
    ui.item("ok", `Settings: ${ui.path(file)} (daily cap ${dollars(next.dailyCapUsd)})`);
  }
  const market = writeMarketplace({ dataDir, root, V });
  if (market.copy === "differs") {
    ui.item("warn", `Recall ${V} was copied again with different files;`);
    ui.say("    Claude Code and Codex keep their cached copies until the version changes.");
  }
  const key = keys.find((k) => k.provider.roles.includes("embeddings"))?.key;
  if (a.index) {
    const r = await buildIndex(ui, cfg, { key, homeDir, env });
    if (r.error) return { exit: 1, stop: [`  ${ui.glyph("fail")} Indexing failed: ${r.error}`, "What was indexed is kept; run this again to continue."] };
    ui.item("ok", `Indexed ${r.statements} statements (${usd(r.costUsd)})`);
    spent += r.costUsd;
  }
  if (a.cards) {
    startCards(cfg, V, a.writer, env);
    ui.item("ok", `Writing short summaries in the background with your ${a.writer} CLI`);
  }

  const picked = rows.filter(chosen);
  const M = market.M;
  const outcomes = await mapLimit(picked, 4, (row) => installHome(row, row.status, { M, V, run, base: env, homeDir }));
  const results = picked.map((row, i) => ({ row, ...outcomes[i] }));
  const lines = padRows(results.map(({ row, ok, outcome, reason, trusted }) => [
    `${ui.glyph(ok ? "ok" : "fail")} ${row.display}`, row.label,
    ok ? `${outcome}${row.host === "codex" && !trusted ? " · approve Recall once in its Hooks page" : ""}` : `failed: ${reason}`,
  ]));
  ui.raw(...lines);

  let createdDirs = [];
  if (a.launcher === "absent" || a.launcher === "stale") {
    ({ createdDirs } = writeLauncher({ homeDir, dataDir, V }));
    ui.item("ok", "recall command: ~/.local/bin/recall");
  } else if (a.launcher === "foreign") ui.item("warn", "recall command: ~/.local/bin/recall exists and is not Recall's; left as it is");

  const at = now().toISOString();
  writeInstalls(dataDir, [
    ...results.filter((r) => r.ok).map(({ row }) => ({ home: row.home, host: row.host, status: "installed", recallVersion: V, at })),
    ...rows.filter((r) => r.named && r.leftOut && r.status.kind !== "other").map((row) => ({ home: row.home, host: row.host, status: "left-out", recallVersion: V, at })),
  ], { createdDirs });
  const referenced = new Set(rows.flatMap((r) => readHomeState(r, V).versions));
  collectGarbage({ dataDir, V, referenced });
  return { spent, results, cardsStarted: Boolean(a.cards), indexed: Boolean(a.index) };
}
