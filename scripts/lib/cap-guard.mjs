// Spend guard for the hooks. When the (shared) daily or total cap is reached the hooks go silent: no retrieval, no request, nothing injected.
// The reason is logged on EVERY silenced turn as a quiet info line (outcome "silent", reason "cap-reached"), but only ONE line per hour is
// loud (level "error": also on stderr), so a capped day does not spray the host's UI or the log with errors.
import fs from "node:fs";
import path from "node:path";
import { withLockSync } from "./lock.mjs";

export const CAP_WARN_WINDOW_MS = 3_600_000;

/** True for the first caller in each window: the one that should be loud. Cross-process (the data dir is shared by every home). */
export function warnOncePerWindow({ dataDir, key, now = () => new Date(), windowMs = CAP_WARN_WINDOW_MS }) {
  const file = path.join(dataDir, "state", "warned.json");
  return withLockSync(path.join(dataDir, "locks", "warned.lock"), () => {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") state = {}; }
    const last = state[key] ? Date.parse(state[key]) : 0;
    if (now().getTime() - last < windowMs) return false;
    state[key] = now().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
    return true;
  }, { staleMs: 30_000, timeoutMs: 5_000 });
}

export const isCapError = (e) => e?.name === "CapExceededError";

/** The `error` text of the loud line. `cap` is ledger.capReached()'s result or a CapExceededError. */
export function capMessage(cap) {
  if (isCapError(cap)) return `${cap.name}: ${cap.message}`;
  const [env, key] = cap.scope === "daily" ? ["RECALL_DAILY_CAP_USD", "dailyCapUsd"] : ["RECALL_TOTAL_CAP_USD", "totalCapUsd"];
  const until = cap.scope === "daily" ? "it resets" : "it is raised";
  return `CapExceededError: ${cap.scope} spend cap reached: spent $${cap.spentUsd.toFixed(6)} of $${cap.capUsd} (${env}); recall hooks stay silent until ${until} (shared by every home; this line is logged once per hour; also settable as "${key}" in <data dir>/config.json)`;
}

/**
 * Log one capped (silent) turn. Returns nothing: the caller returns its own empty hook output.
 * @param {{log: {write: Function}, base: object, dataDir: string, cap: object, now?: () => Date, extra?: object}} o
 */
export function logCapSilence({ log, base, dataDir, cap, now = () => new Date(), extra = {} }) {
  const loud = warnOncePerWindow({ dataDir, key: "cap-reached", now });
  log.write({ ...base, ...extra, level: loud ? "error" : "info", outcome: "silent", reason: "cap-reached", ...(loud ? { error: capMessage(cap) } : {}) });
}
