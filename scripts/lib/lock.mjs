// Cross-process lock for the shared data dir (~/.plugin-recall is used by every installed home and host at once). A lock is a file created
// with O_EXCL (atomic) holding {pid, at, token}. A holder that died (its pid is gone) or that has held the lock longer than `staleMs` is
// stale: the next process renames the lock file away (atomic, so only one process wins) and takes it. Release deletes the file only if it
// still carries our token, so a holder whose lock was recovered as stale can never delete the new holder's lock.
// Critical sections are milliseconds (ledger cap check, statement append); the index run holds its lock for the whole run and is long.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class LockTimeoutError extends Error {
  constructor(file, holder, waitedMs) {
    super(`could not take lock ${file} within ${waitedMs}ms; held by ${holder ? `pid ${holder.pid} since ${holder.at}` : "an unreadable owner"}`);
    this.name = "LockTimeoutError";
    this.holder = holder;
  }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
export const sleepSync = (ms) => { Atomics.wait(sleepCell, 0, 0, ms); };

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** The holder recorded in a lock file: {pid, at, token}; the pre-lock-module format was just the pid. null when unreadable. */
export function readLock(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  try {
    const o = JSON.parse(text);
    if (o && Number.isInteger(o.pid)) return { pid: o.pid, at: o.at ?? null, token: o.token ?? null };
  } catch { /* fall through to the legacy format */ }
  if (/^\d+$/.test(text.trim())) return { pid: Number(text.trim()), at: null, token: null };
  return null;
}

function isStale(file, holder, { staleMs, now }) {
  let st;
  try { st = fs.statSync(file); } catch (e) { if (e.code === "ENOENT") return false; throw e; }
  const age = now() - (holder?.at ? Date.parse(holder.at) : st.mtimeMs);
  if (!holder) return age > 2000; // created but not yet written (or garbage): give the creator a moment
  if (!pidAlive(holder.pid)) return true;
  return age > staleMs;
}

/** Remove a stale lock file. Returns true if this process removed it (or it was already gone). */
function breakStale(file, holder) {
  const again = readLock(file);
  if (again && holder && again.token !== holder.token) return false; // replaced since we looked
  const aside = `${file}.stale-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  try { fs.renameSync(file, aside); } catch (e) { if (e.code === "ENOENT") return true; throw e; }
  fs.rmSync(aside, { force: true });
  return true;
}

/**
 * Take the lock, waiting up to `timeoutMs` (0 = a single attempt). Synchronous, so it can guard a synchronous critical section.
 * @returns {{file: string, token: string, release: () => void}}
 */
export function acquireLock(file, { staleMs = 60_000, timeoutMs = 10_000, pollMs = 15, now = Date.now, pid = process.pid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = now();
  for (;;) {
    const token = crypto.randomBytes(8).toString("hex");
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, at: new Date(now()).toISOString(), token }), { flag: "wx" });
      return { file, token, release: () => releaseLock(file, token) };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const holder = readLock(file);
    if (isStale(file, holder, { staleMs, now }) && breakStale(file, holder)) continue;
    if (now() - started >= timeoutMs) throw new LockTimeoutError(file, holder, now() - started);
    sleepSync(pollMs);
  }
}

export function releaseLock(file, token) {
  const holder = readLock(file);
  if (holder && holder.token !== null && holder.token !== token) return false; // not ours any more
  fs.rmSync(file, { force: true });
  return true;
}

/** Rewrite the holder's pid (the hook takes the index lock, then hands it to the detached indexer it spawned). */
export function transferLock(file, token, pid) {
  const holder = readLock(file);
  if (!holder || holder.token !== token) throw new Error(`lock ${file} is no longer ours; cannot hand it to pid ${pid}`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid, at: holder.at, token }));
  fs.renameSync(tmp, file);
}

/** Take over a lock another process created for us (transferLock wrote our pid into it). null if it is not ours. */
export function adoptLock(file, pid = process.pid) {
  const holder = readLock(file);
  if (!holder || holder.pid !== pid) return null;
  return { file, token: holder.token, release: () => releaseLock(file, holder.token) };
}

/** Run a synchronous critical section under the lock. */
export function withLockSync(file, fn, opts) {
  const lock = acquireLock(file, opts);
  try { return fn(); } finally { lock.release(); }
}
