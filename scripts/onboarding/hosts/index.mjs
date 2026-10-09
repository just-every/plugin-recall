// One agent home, either host: its status against the Recall version being installed, and the install or uninstall run through the host's
// own CLI, verified by reading the host's files again. A failure belongs to its home only.
import fs from "node:fs";
import path from "node:path";
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import { failureReason, hostEnv, resultJson } from "./runner.mjs";

export const HOST_MODULES = Object.freeze({ claude, codex });

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
export const samePath = (a, b) => Boolean(a && b) && real(a) === real(b);

/** A home's Recall state, read from the host's own files. */
export const readHomeState = (row, V) => HOST_MODULES[row.host].readState(row.home, { V });

/**
 * Where a home stands: {kind: "other", id} (another copy of Recall, left alone), "new", {kind: "update", old}, "reinstall" (this version,
 * another marketplace), "disabled", or "current".
 */
export function homeStatus(state, { M, V }) {
  if (state.otherCopy) return { kind: "other", id: state.otherCopy };
  if (!state.installed) return { kind: "new" };
  if (state.version !== V) return { kind: "update", old: state.version };
  if (!samePath(state.marketplace, M)) return { kind: "reinstall" };
  if (!state.enabled) return { kind: "disabled" };
  return { kind: "current" };
}

/** The status column of the homes table. */
export function statusText(status, V) {
  switch (status.kind) {
    case "other": return `has ${status.id}; left alone`;
    case "new": return "new";
    case "update": return `update ${status.old} → ${V}`;
    case "reinstall": return `reinstall ${V} from this copy`;
    case "disabled": return "disabled; will be enabled";
    default: return "up to date";
  }
}

/** Does this status need the host's CLI to run? */
export const needsInstall = (status) => ["new", "update", "reinstall", "disabled"].includes(status.kind);

/** What a run line says about a home once it worked. */
function outcomeText(status, V) {
  if (status.kind === "update") return `updated ${status.old} → ${V}`;
  if (status.kind === "disabled") return "enabled";
  if (status.kind === "current") return "up to date";
  return "installed";
}

async function runSteps(mod, row, steps, { run, base, homeDir, ifMissing }) {
  const env = hostEnv(row.host, row.home, { base, homeDir });
  for (const argv of steps) {
    const r = await run(row.host, argv, { env, timeoutMs: 60000 });
    if (!mod.succeeded(r, resultJson(r.stdout))) return failureReason(r, row.host, ifMissing);
  }
  return null;
}

/**
 * Install or update Recall `V` from the marketplace at `M` in one home.
 * @returns {Promise<{ok: boolean, outcome?: string, reason?: string, trusted: boolean}>}
 */
export async function installHome(row, status, { M, V, run, base, homeDir }) {
  const mod = HOST_MODULES[row.host];
  if (!needsInstall(status)) return { ok: true, outcome: outcomeText(status, V), trusted: mod.readState(row.home, { V }).trusted };
  try {
    if (row.isDefault && !row.exists) mod.prepare(row.home);
    const before = mod.readState(row.home, { V });
    const steps = mod.installSteps(before, { M, V, pointsHere: samePath(before.marketplace, M) });
    const failed = await runSteps(mod, row, steps, { run, base, homeDir, ifMissing: " or leave the home out with --exclude" });
    if (failed) return { ok: false, reason: failed, trusted: before.trusted };
    const after = mod.readState(row.home, { V });
    if (!mod.verified(after, { V, pointsHere: samePath(after.marketplace, M) })) {
      return { ok: false, reason: `the ${row.host} CLI reported success, but ${row.display} does not list Recall ${V}`, trusted: after.trusted };
    }
    return { ok: true, outcome: outcomeText(status, V), trusted: after.trusted };
  } catch (e) {
    return { ok: false, reason: String(e.message).split("\n")[0].slice(0, 200), trusted: false };
  }
}

/** Is Recall's own copy (or its marketplace) in this home, so that uninstall has something to remove? */
export function hasOwnCopy(state) {
  return !state.otherCopy && (state.installed || state.configured || Boolean(state.marketplace));
}

/**
 * Remove Recall and its marketplace from one home, then the host's cache folder for that marketplace (the host's clearCache). `cacheLeft`
 * names that folder when the host still holds a copy there that it clears itself.
 * @returns {Promise<{ok: true, cacheLeft?: string} | {ok: false, reason: string}>}
 */
export async function uninstallHome(row, { run, base, homeDir }) {
  const mod = HOST_MODULES[row.host];
  try {
    const failed = await runSteps(mod, row, mod.uninstallSteps(mod.readState(row.home, {})), { run, base, homeDir, ifMissing: " or remove the home with --homes" });
    if (failed) return { ok: false, reason: failed };
    return mod.clearCache(row.home) === "left" ? { ok: true, cacheLeft: path.join(row.home, "plugins", "cache", mod.MARKETPLACE) } : { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e.message).split("\n")[0].slice(0, 200) };
  }
}
