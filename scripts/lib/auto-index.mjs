// Keep the index fresh without putting indexing on the prompt's critical path: after answering, a hook may start `recall index` as a
// detached background process, at most once per RECALL_AUTO_INDEX_MINUTES (default 30). The data dir is shared by every home, so the guard is
// a real cross-process lock (lock.mjs: <dataDir>/state/index.lock, created atomically, recovered when its holder died): the hook takes it,
// starts the indexer and hands the lock to the indexer's pid; the indexer holds it for the whole run. RECALL_AUTO_INDEX=0 turns it off.
// The background run is `recall index --enrich`: once the new statements are embedded the lock is released and the same process writes their
// cards (kind, scope, gist) through the router, so v2 can inject them.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, LockTimeoutError, transferLock } from "./lock.mjs";

export const INDEX_LOCK_STALE_MS = 6 * 3_600_000;

const RECALL_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "recall.mjs");

/** @returns {{started: boolean, reason: string}} */
export function maybeStartIndex({ config, store, now = Date.now, spawnImpl = spawn }) {
  if (!config.autoIndex) return { started: false, reason: "auto-index-off" };
  const state = store.loadState();
  const last = state.lastIndexAt ? Date.parse(state.lastIndexAt) : 0;
  const lockFile = path.join(config.dataDir, "state", "index.lock");
  const maxAge = config.autoIndexMinutes * 60_000;
  if (now() - last < maxAge) return { started: false, reason: "indexed-recently" };
  let lock;
  try {
    lock = acquireLock(lockFile, { staleMs: INDEX_LOCK_STALE_MS, timeoutMs: 0, now });
  } catch (e) {
    if (e instanceof LockTimeoutError) return { started: false, reason: "index-running" };
    throw e;
  }
  try {
    fs.mkdirSync(path.join(config.dataDir, "logs"), { recursive: true });
    const logFile = fs.openSync(path.join(config.dataDir, "logs", "auto-index.log"), "a");
    const child = spawnImpl(process.execPath, [RECALL_CLI, "index", "--enrich", "--lock", lockFile], {
      detached: true,
      stdio: ["ignore", logFile, logFile],
      env: { ...process.env, RECALL_DATA: config.dataDir, RECALL_AUTO_INDEX: "0" },
    });
    child.unref();
    if (child.pid) transferLock(lockFile, lock.token, child.pid);
  } catch (e) {
    lock.release();
    throw e;
  }
  return { started: true, reason: "started" };
}
