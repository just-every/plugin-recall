// Home routing for every claude/codex CLI worker the plugin launches (statement cards, the optional rerank and HyDE stages).
//
// Default (no roster, no usageCmd): the worker runs under the CURRENT HOST's own home: `claude -p --model haiku` under $CLAUDE_CONFIG_DIR
// (else ~/.claude), `codex exec` under $CODEX_HOME (else ~/.codex). Nothing else is asked of the machine: no usage command is needed.
// Optional, for people who run several accounts:
//   usageCmd      a command that prints usage as JSON (`<cmd> --json`, shape in README "Home routing"). The candidate homes are then every
//                 discovered home of the kind (homes.mjs); one whose usage row is missing, errored, needs auth or is at usageMaxPercent or
//                 more is dropped, and the one with the most headroom is used (usage is cached for usageTtlMs).
//   homesRoster   a roster file (roster.mjs): the candidates are its entries with protected:false AND manual:false, and usage is required.
//   claudeHome / codexHome   pin the home. With a roster it must itself be eligible and healthy.
// A home that config `homes` lists as {path, kind} is read for indexing only (homes.mjs) and is never a worker's: not by the default, not by
// usage, not from a roster, and not when it is pinned (the pin is refused). No candidate means null plus the reason for every home considered: the caller skips its stage and logs loudly. There is no fallback.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDir, resolveHome } from "./home-paths.mjs";
import { indexOnlyHomes, minedHomes } from "./homes.mjs";
import { eligibleForWork, loadRoster, RosterError } from "./roster.mjs";

export class RouterError extends Error {
  constructor(message) {
    super(message);
    this.name = "RouterError";
  }
}

/** The command that prints usage JSON: config usageCmd (`node` means this node), else `usage` on PATH. */
export function usageCommand(config) {
  if (!config.usageCmd) return { cmd: "usage", args: ["--json"] };
  const parts = config.usageCmd.trim().split(/\s+/);
  return { cmd: parts[0] === "node" ? process.execPath : parts[0], args: [...parts.slice(1), "--json"] };
}

function execUsage({ cmd, args }, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new RouterError(`usage --json failed: ${err.message}${stderr ? ` | ${String(stderr).slice(0, 300)}` : ""}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new RouterError(`usage --json printed something that is not JSON: ${String(stdout).slice(0, 200)}`));
      }
    });
  });
}

/** `usage --json` through a short on-disk TTL cache (shared by every hook process). Never polled in a loop. */
export async function readUsage({ config, run = execUsage, now = Date.now }) {
  const cacheFile = path.join(config.dataDir, "router", "usage-cache.json");
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (now() - c.fetchedAt < config.usageTtlMs && Array.isArray(c.json?.results)) return { json: c.json, cached: true, fetchedAt: c.fetchedAt };
  } catch { /* no cache yet, or unreadable: fetch */ }
  const json = await run(usageCommand(config));
  if (!Array.isArray(json?.results)) throw new RouterError("usage --json has no results array");
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: now(), json }));
  fs.renameSync(tmp, cacheFile);
  return { json, cached: false, fetchedAt: now() };
}

/** Verdict on one home from its usage row: {ok, headroom, pace, usedPercent} or {ok:false, reason}. */
export function judgeUsageRow(row, maxPercent) {
  if (!row) return { ok: false, reason: "no row in usage --json" };
  if (row.error) return { ok: false, reason: `usage error: ${String(row.error).slice(0, 120)}` };
  if (row.needsAuth) return { ok: false, reason: "needsAuth" };
  const windows = Array.isArray(row.windows) ? row.windows.filter((w) => typeof w.usedPercent === "number") : [];
  if (!windows.length) return { ok: false, reason: "no usage windows" };
  const worst = windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  if (worst.usedPercent >= maxPercent) return { ok: false, reason: `${worst.label} at ${worst.usedPercent}% (limit ${maxPercent}%)`, usedPercent: worst.usedPercent };
  const pace = Math.max(...windows.map((w) => w.usedPercent / Math.max(w.elapsedPercent ?? 100, 1)));
  return { ok: true, headroom: 100 - worst.usedPercent, pace, usedPercent: worst.usedPercent };
}

/** Is `bin` an executable file in one of the PATH directories of `env`? */
export function onPath(bin, env = process.env) {
  return String(env.PATH ?? "").split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return fs.statSync(path.join(dir, bin)).isFile(); } catch { return false; }
  });
}

/** The home the current host runs in, for a worker of this kind. */
const hostHome = (kind, env, homeDir) => {
  if (kind === "claude") return env.CLAUDE_CONFIG_DIR ? resolveHome(env.CLAUDE_CONFIG_DIR, homeDir) : path.join(homeDir, ".claude");
  return env.CODEX_HOME ? resolveHome(env.CODEX_HOME, homeDir) : path.join(homeDir, ".codex");
};

/**
 * @returns a router with pick(kind) -> {home, id?, usedPercent?, explicit, considered} | {home: null, considered, reason}. `explicit` is false
 * when the home is just the current host's own (the worker then inherits the host's CLAUDE_CONFIG_DIR / CODEX_HOME as they are). Never throws
 * for "nothing eligible"; throws RouterError when the roster or usage cannot be read at all (the caller treats both the same: skip the stage).
 */
export function createRouter({ config, homeDir = os.homedir(), env = process.env, run = execUsage, now = Date.now, hasCli = (bin) => onPath(bin, env) }) {
  const pinnedOf = (kind) => (kind === "claude" ? config.claudeHome : config.codexHome);

  /** The candidate homes of a kind, each {home, id, ...} with the reasons the others were left out. An index-only home is never one. */
  async function candidates(kind) {
    const indexOnly = new Set(indexOnlyHomes(config, { homeDir }).map((h) => h.dir));
    const found = await homesOf(kind);
    if (!found.eligible.length) return found;
    const considered = [...found.considered];
    for (const e of found.eligible) if (indexOnly.has(e.home)) considered.push({ home: e.home, ok: false, reason: "index-only (config homes {path, kind})" });
    const eligible = found.eligible.filter((e) => !indexOnly.has(e.home));
    if (eligible.length) return { ...found, eligible, considered };
    // a pin is one home, so a pinned index-only home leaves none
    const pinned = pinnedOf(kind) ? resolveHome(pinnedOf(kind), homeDir) : null;
    const reason = pinned ? `pinned ${kind} home ${pinned} is read for indexing only (config homes lists it as {path, kind}): no worker runs there` : `every ${kind} home on offer is read for indexing only (config homes {path, kind})`;
    return { eligible, considered, reason, explicit: found.explicit };
  }

  /** The homes of a kind the configuration offers a worker, before the index-only homes are taken out. */
  async function homesOf(kind) {
    const considered = [];
    if (config.homesRoster) {
      let roster;
      try {
        roster = await loadRoster(config.homesRoster, homeDir);
      } catch (e) {
        if (e instanceof RosterError) throw new RouterError(`no roster, so no home can be proven eligible: ${e.message}`);
        throw e;
      }
      let eligible = eligibleForWork(roster).filter((e) => e.kind === kind);
      for (const e of roster) if (e.kind === kind && !eligible.includes(e)) considered.push({ home: e.home, ok: false, reason: e.protected ? "protected" : "manual" });
      const pinned = pinnedOf(kind);
      if (pinned) {
        const want = resolveHome(pinned, homeDir);
        if (!eligible.some((e) => e.home === want)) return { eligible: [], considered, reason: `pinned home ${want} is not an eligible roster home (protected:false, manual:false)` };
        eligible = eligible.filter((e) => e.home === want);
      }
      return { eligible, considered, reason: `no eligible ${kind} home in the roster`, explicit: true };
    }
    // Without a roster the worker is the user's own CLI: it must be installed for this kind to be a candidate at all.
    const bin = kind === "claude" ? "claude" : "codex";
    if (!hasCli(bin)) return { eligible: [], considered, reason: `the ${bin} CLI is not on PATH`, explicit: false };
    const pinned = pinnedOf(kind);
    if (pinned) {
      const home = resolveHome(pinned, homeDir);
      if (!isDir(home)) return { eligible: [], considered, reason: `pinned ${kind} home ${home} does not exist`, explicit: true };
      return { eligible: [{ id: home, home }], considered, reason: "", explicit: true };
    }
    if (config.usageCmd) {
      const mined = await minedHomes(config, { homeDir, env });
      const eligible = mined.homes.filter((h) => h.kind === kind).map((h) => ({ id: h.dir, home: h.dir }));
      return { eligible, considered, reason: `no ${kind} home found (looked in ${mined.homes.map((h) => h.dir).join(", ") || "none"})`, explicit: true };
    }
    const home = hostHome(kind, env, homeDir);
    if (!isDir(home)) return { eligible: [], considered, reason: `the ${kind} home ${home} does not exist`, explicit: false };
    return { eligible: [{ id: home, home }], considered, reason: "", explicit: false };
  }

  return {
    async pick(kind) {
      if (!["claude", "codex"].includes(kind)) throw new RouterError(`unknown worker kind ${JSON.stringify(kind)}`);
      const { eligible, considered, reason, explicit } = await candidates(kind);
      if (!eligible.length) return { home: null, considered, reason };
      // Without a roster or a usage command there is nothing to measure: the home is used as it is.
      if (!config.homesRoster && !config.usageCmd) return { home: eligible[0].home, id: eligible[0].id, explicit, considered };
      const usage = await readUsage({ config, run, now });
      const byPath = new Map(usage.json.results.map((r) => [resolveHome(r.path, homeDir), r]));
      const ok = [];
      for (const e of eligible) {
        const v = judgeUsageRow(byPath.get(e.home), config.usageMaxPercent);
        considered.push({ home: e.home, ...v });
        if (v.ok) ok.push({ e, v });
      }
      if (!ok.length) return { home: null, considered, reason: `every eligible ${kind} home is walled, errored or needs auth` };
      ok.sort((a, b) => b.v.headroom - a.v.headroom || a.v.pace - b.v.pace || (a.e.home < b.e.home ? -1 : 1));
      const best = ok[0];
      return { home: best.e.home, id: best.e.id, usedPercent: best.v.usedPercent, usageCached: usage.cached, explicit, considered };
    },
  };
}
