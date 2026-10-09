// Spend ledger and caps. One JSON line per billable call in <dataDir>/ledger.jsonl, fields {ts, experiment, endpoint, inputTokens, costUsd, requestId}. Caps: a daily cap (UTC day, RECALL_DAILY_CAP_USD, default 1.0) and an
// optional total cap (RECALL_TOTAL_CAP_USD). reserve() throws CapExceededError BEFORE a request is sent. One ledger is shared by every
// hook process of every home and host (<dataDir> defaults to ~/.plugin-recall), so a reservation is a file in <dataDir>/inflight/ and the
// whole check (read spend, sum live reservations, compare, write ours) runs under a lock: two hooks racing for the last cents cannot both
// pass. A reservation whose process died, or that is older than RESERVATION_TTL_MS, is ignored and deleted. record() is a single
// append-only line (O_APPEND), so it needs no lock.
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, fstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withLockSync, pidAlive } from "./lock.mjs";

export const RESERVATION_TTL_MS = 10 * 60_000;

// USD per 1M input tokens (pricing page, checked 2026-10-07). Decisions bills input tokens only; gpt-6-luna is 2x above 272K tokens.
export const PRICES = {
  "gpt-6-luna": { perMTok: 0.1, longPerMTok: 0.2, longThreshold: 272_000 },
  "text-embedding-3-small": { perMTok: 0.02 },
};

export function costUsd(model, inputTokens) {
  const p = PRICES[model];
  if (!p) throw new Error(`no price known for model ${model}`);
  if (!Number.isFinite(inputTokens) || inputTokens < 0) throw new Error(`invalid inputTokens ${inputTokens}`);
  const rate = p.longThreshold !== undefined && inputTokens > p.longThreshold ? p.longPerMTok : p.perMTok;
  return (inputTokens * rate) / 1_000_000;
}

/** Pre-flight estimate used only for cap checks (the ledger always records the response's usage): chars/3 + 400 tokens. */
export const estimateTokens = (body, overhead = 400) => Math.ceil(JSON.stringify(body).length / 3) + overhead;

export class CapExceededError extends Error {
  constructor(scope, capUsd, spentUsd, inflightUsd, requestedUsd) {
    super(
      `${scope} spend cap exceeded: cap $${capUsd}, spent $${spentUsd.toFixed(6)}, in-flight $${inflightUsd.toFixed(6)}, this request ~$${requestedUsd.toFixed(6)} ` +
        `(${scope === "daily" ? "RECALL_DAILY_CAP_USD" : "RECALL_TOTAL_CAP_USD"})`,
    );
    this.name = "CapExceededError";
    this.scope = scope;
  }
}

const utcDay = (iso) => String(iso).slice(0, 10);

export function createLedger({ dir, dailyCapUsd, totalCapUsd = null, now = () => new Date(), experiment = "plugin-recall" }) {
  const file = path.join(dir, "ledger.jsonl");
  const inflightDir = path.join(dir, "inflight");
  const lockFile = path.join(dir, "locks", "ledger.lock");
  let reservationSeq = 0;
  // Incremental tail read: other processes append to the same file, so only bytes past our offset are parsed.
  let offset = 0;
  let carry = "";
  let total = 0;
  const byDay = new Map();
  let ino = null;

  function refresh() {
    if (!existsSync(file)) return;
    const fd = openSync(file, "r");
    try {
      const st = fstatSync(fd);
      if (ino !== null && (st.ino !== ino || st.size < offset)) {
        offset = 0; carry = ""; total = 0; byDay.clear();
      }
      ino = st.ino;
      if (st.size === offset) return;
      const buf = Buffer.allocUnsafe(st.size - offset);
      let read = 0;
      while (read < buf.length) {
        const n = readSync(fd, buf, read, buf.length - read, offset + read);
        if (n <= 0) break;
        read += n;
      }
      offset += read;
      const text = carry + buf.subarray(0, read).toString("utf8");
      const lines = text.split("\n");
      carry = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { throw new Error(`corrupt ledger line in ${file}: ${line.slice(0, 120)}`); }
        if (typeof e.costUsd !== "number") throw new Error(`ledger line without numeric costUsd in ${file}`);
        total += e.costUsd;
        const d = utcDay(e.ts);
        byDay.set(d, (byDay.get(d) ?? 0) + e.costUsd);
      }
    } finally {
      closeSync(fd);
    }
  }

  const spentToday = () => { refresh(); return byDay.get(utcDay(now().toISOString())) ?? 0; };
  const spentTotal = () => { refresh(); return total; };

  /** USD currently reserved by live requests of every process; reservations of dead processes and expired ones are deleted. */
  function liveReservedUsd() {
    if (!existsSync(inflightDir)) return 0;
    let sum = 0;
    for (const name of readdirSync(inflightDir)) {
      const f = path.join(inflightDir, name);
      let r;
      try { r = JSON.parse(readFileSync(f, "utf8")); } catch { rmSync(f, { force: true }); continue; }
      if (!pidAlive(r.pid) || now().getTime() - Date.parse(r.at) > RESERVATION_TTL_MS) { rmSync(f, { force: true }); continue; }
      sum += r.usd;
    }
    return sum;
  }

  /** Spend that already reached a cap: null, or {scope, capUsd, spentUsd}. The hooks use it to go silent without trying a request. */
  function capReached() {
    const today = spentToday();
    if (today >= dailyCapUsd) return { scope: "daily", capUsd: dailyCapUsd, spentUsd: today };
    if (totalCapUsd !== null && total >= totalCapUsd) return { scope: "total", capUsd: totalCapUsd, spentUsd: total };
    return null;
  }

  function reserve(estimatedUsd) {
    if (!(estimatedUsd > 0) || !Number.isFinite(estimatedUsd)) throw new Error(`estimatedUsd must be a positive number, got ${estimatedUsd}`);
    mkdirSync(inflightDir, { recursive: true });
    const mine = path.join(inflightDir, `${process.pid}-${++reservationSeq}-${Math.random().toString(36).slice(2, 8)}.json`);
    withLockSync(lockFile, () => {
      // Order matters: a request's spend is appended BEFORE its reservation is released, so reading the reservations first and the spend
      // second sees every request at least once (a request finishing in between is counted twice, which is only conservative).
      const inflight = liveReservedUsd();
      const today = spentToday();
      if (today + inflight + estimatedUsd > dailyCapUsd) throw new CapExceededError("daily", dailyCapUsd, today, inflight, estimatedUsd);
      if (totalCapUsd !== null && total + inflight + estimatedUsd > totalCapUsd) throw new CapExceededError("total", totalCapUsd, total, inflight, estimatedUsd);
      writeFileSync(mine, JSON.stringify({ pid: process.pid, at: now().toISOString(), usd: estimatedUsd }));
    }, { staleMs: 30_000, timeoutMs: 10_000 });
    let released = false;
    return { release() { if (!released) { released = true; rmSync(mine, { force: true }); } } };
  }

  /** kind: "billed" (usage came back) or "timeout-estimate" (no response: counted at the pre-flight estimate so caps stay conservative). */
  function record({ endpoint, inputTokens, costUsd: cost, requestId = null, kind = "billed", label = null }) {
    mkdirSync(dir, { recursive: true });
    const entry = { ts: now().toISOString(), experiment, endpoint, inputTokens, costUsd: cost, requestId, kind, ...(label ? { label } : {}) };
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  return { file, reserve, record, spentToday, spentTotal, capReached, dailyCapUsd, totalCapUsd };
}
