// The monitor's whole picture of the data dir, kept in memory and refreshed by poll(): the paired turns of the last `retainDays` UTC days,
// spend, and the index. Read-only: it opens files for reading and never writes under the data dir. Nothing here calls any API.
import os from "node:os";
import { activeSessions, dayCounters, reasonCounts } from "./counters.mjs";
import { viewTurn } from "./describe.mjs";
import { createIndexInfo } from "./index-info.mjs";
import { createPairer } from "./pairer.mjs";
import { readSettings } from "./settings.mjs";
import { createSpend } from "./spend.mjs";
import { createTurnLogWatcher, utcDay } from "./turn-log-watcher.mjs";

const HOUR_MS = 3_600_000;
const RECENT_LOOKUPS = 8;

/**
 * @param {{dataDir: string, env?: object, now?: () => Date, retainDays?: number, homedir?: string, onProblem?: (message: string) => void}} o
 *   env is what the configuration resolver reads (RECALL_DATA must name dataDir); now is injectable for tests.
 */
export function createMonitorState({ dataDir, env = process.env, now = () => new Date(), retainDays = 7, homedir = os.homedir(), onProblem = () => {} }) {
  const pairer = createPairer();
  const lookups = []; // `recall show` lines ("Agent looked up context"), oldest first; they are not turns and never enter the pairer
  const spend = createSpend(dataDir);
  const index = createIndexInfo(dataDir);
  const listeners = new Set();
  const emit = (event) => { for (const fn of listeners) fn(event); };
  let badLines = 0;
  let resetPending = false;
  const problems = new Map(); // message -> first time seen; shown in the page until it stops happening

  const settingsNow = () => readSettings(env);
  const barsNow = () => settingsNow().bars;

  const watcher = createTurnLogWatcher({
    dataDir, now, retainDays,
    onLine(line, { replay }) {
      if (line.event === "show") { lookups.push(line); return; }
      const turn = pairer.add(line);
      if (!replay) emit({ type: "line", line, turn: viewTurn(turn, barsNow()) });
    },
    onBad: () => { badLines++; },
    onReset() { pairer.clear(); lookups.length = 0; badLines = 0; resetPending = true; },
  });

  const guard = (what, fn) => {
    try { const out = fn(); problems.delete(what); return out; } catch (e) {
      const message = `${what}: ${e.message}`;
      if (!problems.has(what) || problems.get(what) !== message) onProblem(message);
      problems.set(what, message);
      return 0;
    }
  };

  /** Read whatever was appended since the last call and emit line / reset / summary events. @returns {boolean} whether anything changed */
  function poll({ replay = false } = {}) {
    const lines = guard("turn log", () => watcher.poll({ replay }));
    const spent = guard("ledger", () => spend.poll());
    const indexed = guard("index", () => index.poll());
    const cutoff = new Date(now().getTime() - retainDays * 24 * HOUR_MS).toISOString();
    pairer.prune(cutoff);
    while (lookups.length && lookups[0].ts < cutoff) lookups.shift();
    const changed = Boolean(lines || spent || indexed || resetPending);
    if (resetPending) { resetPending = false; emit({ type: "reset" }); }
    if (changed && !replay) emit({ type: "summary", summary: summary() });
    return changed;
  }

  /** A lookup line with the statement it was about (text, repo, source) when the index has it. */
  const viewLookup = (l) => {
    const row = index.statements([l.statement_id])[0];
    return { ts: l.ts, statement_id: l.statement_id, cwd: l.cwd ?? null, project: l.project ?? null, session_id: l.session_id ?? null, text: row?.text ?? null, repo: row?.repo ?? null, host: row?.host ?? null, src: row?.src ?? null };
  };

  /** Header numbers, side column and settings. Small; pushed on every change. */
  function summary() {
    const settings = settingsNow();
    const turns = pairer.turns();
    const day = utcDay(now());
    return {
      now: now().toISOString(),
      day,
      spend: spend.summary(day),
      caps: settings.caps,
      settings: settings.ok ? settings.settings : null,
      configFile: settings.configFile ?? null,
      configError: settings.error,
      bars: settings.bars,
      index: index.summary(),
      counters: dayCounters(turns, day, lookups),
      lookups: lookups.slice(-RECENT_LOOKUPS).reverse().map(viewLookup),
      sessions: activeSessions(turns, now().getTime()),
      problems: [...problems.values()],
      badLines,
    };
  }

  function snapshot({ hours = 24 } = {}) {
    const settings = settingsNow();
    const since = new Date(now().getTime() - hours * HOUR_MS).toISOString();
    const held = pairer.turns();
    const turns = held.map((t) => viewTurn(t, settings.bars)).filter((t) => t.updated >= since).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return { hours, dataDir, homeDir: homedir, summary: summary(), reasons: reasonCounts(held, since), turns };
  }

  return {
    dataDir,
    poll,
    summary,
    snapshot,
    statements: (ids) => index.statements(ids),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
