// The facts doctor and setup look at. Every probe is read-only and returns plain data; none prints a secret.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { neutralCwd } from "./hosts/neutral-cwd.mjs";

/** `<bin> --version`, or why it cannot be run. */
export function cliVersion(bin, { env = process.env, timeoutMs = 10000 } = {}) {
  const r = spawnSync(bin, ["--version"], { env, cwd: neutralCwd(), encoding: "utf8", timeout: timeoutMs });
  if (r.error) return { found: false, version: null, error: r.error.code === "ENOENT" ? "not found on PATH" : r.error.message };
  if (r.status !== 0) return { found: true, version: null, error: `exited ${r.status}` };
  return { found: true, version: (r.stdout || r.stderr).trim().split("\n")[0], error: null };
}

/** Total bytes of the regular files under `dir` (0 when it does not exist). */
export function dirSizeBytes(dir) {
  let total = 0;
  const visit = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* vanished */ } }
    }
  };
  visit(dir);
  return total;
}
