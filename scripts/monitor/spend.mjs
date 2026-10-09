// Spend, read from <data dir>/ledger.jsonl by tailing it. The daily cap's day is the UTC day, so everything here is keyed by UTC day and hour.
// A line that is not valid JSON or has no numeric costUsd is counted in `skipped` and ignored (the monitor never stops on a bad ledger line).
import path from "node:path";
import { createTailer } from "./tailer.mjs";

export function createSpend(dataDir) {
  let total = 0;
  let entries = 0;
  let skipped = 0;
  let last = null;
  const byDay = new Map();
  const byHour = new Map(); // "YYYY-MM-DDTHH" -> usd

  const clear = () => { total = 0; entries = 0; skipped = 0; last = null; byDay.clear(); byHour.clear(); };
  const tailer = createTailer(path.join(dataDir, "ledger.jsonl"), {
    onLine(e) {
      if (typeof e?.costUsd !== "number" || !Number.isFinite(e.costUsd) || typeof e.ts !== "string") { skipped++; return; }
      total += e.costUsd;
      entries++;
      const day = e.ts.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + e.costUsd);
      const hour = e.ts.slice(0, 13);
      byHour.set(hour, (byHour.get(hour) ?? 0) + e.costUsd);
      if (!last || e.ts > last) last = e.ts;
    },
    onBad: () => { skipped++; },
    onReset: clear,
  });

  return {
    poll: () => tailer.poll(),
    /** @param {string} day UTC YYYY-MM-DD */
    summary(day) {
      return {
        day, todayUsd: byDay.get(day) ?? 0, totalUsd: total, entries, skipped, lastAt: last,
        byHour: Array.from({ length: 24 }, (_, h) => byHour.get(`${day}T${String(h).padStart(2, "0")}`) ?? 0),
      };
    },
  };
}
