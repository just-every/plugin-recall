// Response cache for Decisions and embeddings calls, keyed by the sha256 of (endpoint, the exact JSON request body). The API is
// deterministic (identical requests return identical answers), so a hit is a correct answer for free: replays and re-runs cost nothing.
// NEVER use it for latency measurement: a hit reports cached:true with latencyMs 0, and RECALL_NO_CACHE=1 / --no-cache turns it off.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const cacheKey = (endpoint, body) => createHash("sha256").update(endpoint).update("\u0000").update(JSON.stringify(body)).digest("hex");

export function createResponseCache({ dir, enabled = true }) {
  const fileOf = (key) => path.join(dir, "cache", key.slice(0, 2), `${key}.json`);
  return {
    enabled,
    get(endpoint, body) {
      if (!enabled) return null;
      const file = fileOf(cacheKey(endpoint, body));
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, "utf8")).response;
    },
    put(endpoint, body, response) {
      if (!enabled) return;
      const key = cacheKey(endpoint, body);
      const file = fileOf(key);
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, JSON.stringify({ key, endpoint, storedAt: new Date().toISOString(), response }));
      renameSync(tmp, file); // atomic: concurrent readers never see a partial file
    },
  };
}
