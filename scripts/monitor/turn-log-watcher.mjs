// The turn logs <data dir>/logs/turns-YYYY-MM-DD.jsonl (UTC days): one tailer per day file inside the retention window. The newest two days
// are polled on every tick (so the rollover at UTC midnight needs no special case: the new day's file appears and is read from byte 0 while the
// old one keeps being drained); older files are read once at start. A reset in any file (truncation, replacement, deletion) makes the
// consumer clear itself once, after which every file is re-read from byte 0, so nothing is counted twice.
import fs from "node:fs";
import path from "node:path";
import { createTailer } from "./tailer.mjs";

const FILE = /^turns-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;
export const utcDay = (date) => date.toISOString().slice(0, 10);

/**
 * @param {{dataDir: string, now?: () => Date, retainDays?: number, onLine: (line: object, ctx: {replay: boolean}) => void, onBad?: (raw: string) => void, onReset?: () => void}} o
 */
export function createTurnLogWatcher({ dataDir, now = () => new Date(), retainDays = 7, onLine, onBad = () => {}, onReset = () => {} }) {
  const dir = path.join(dataDir, "logs");
  const tailers = new Map(); // day -> {tailer, settled}
  let rebuild = false;

  const cutoffDay = () => utcDay(new Date(now().getTime() - retainDays * DAY_MS));

  function listDays() {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return []; throw e; }
    const cutoff = cutoffDay();
    return names.map((n) => FILE.exec(n)?.[1]).filter((d) => d && d >= cutoff).sort();
  }

  function tailerFor(day) {
    let entry = tailers.get(day);
    if (!entry) {
      const tailer = createTailer(path.join(dir, `turns-${day}.jsonl`), {
        onLine: (line, ctx) => onLine(line, ctx),
        onBad,
        onReset: () => { rebuild = true; },
      });
      entry = { tailer, settled: false };
      tailers.set(day, entry);
    }
    return entry;
  }

  /** One tick. replay=true marks lines that are history (start, rebuild), false the ones that just happened. @returns {number} lines delivered */
  function poll({ replay = false } = {}) {
    const days = listDays();
    const recent = new Set([utcDay(now()), utcDay(new Date(now().getTime() - DAY_MS))]);
    for (const day of [...tailers.keys()]) {
      if (days.includes(day)) continue;
      tailers.delete(day);
      if (day >= cutoffDay()) rebuild = true; // a file inside the window was deleted: its turns must go
    }
    let delivered = 0;
    for (const day of days) {
      const entry = tailerFor(day);
      if (entry.settled && !recent.has(day)) continue;
      delivered += entry.tailer.poll({ replay });
      entry.settled = true;
    }
    if (rebuild) {
      rebuild = false;
      for (const entry of tailers.values()) entry.tailer.rewind();
      onReset(); // the consumer drops everything it holds; the files are history again
      for (const day of days) delivered += tailerFor(day).tailer.poll({ replay: true });
    }
    return delivered;
  }

  return { poll, dir };
}
