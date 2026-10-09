// Claude Code: Recall's state in one home, read from the host's own files, and the `claude plugin` commands that install, update and remove it.
//   plugins/installed_plugins.json   {"version": 2, "plugins": {"recall@plugin-recall": [{"scope": "user", "version": "0.5.1", ...}]}}
//   plugins/known_marketplaces.json  {"plugin-recall": {"source": {"source": "directory", "path": "<M>"}, "installLocation": "<M>"}}
//   settings.json                    enabledPlugins["recall@plugin-recall"], extraKnownMarketplaces["plugin-recall"]
//   plugins/cache/plugin-recall/recall/<version>/   the copy Claude Code runs; a removed or replaced one is marked with .orphaned_at
// Never `claude plugin marketplace remove` while installing: it uninstalls the marketplace's plugins and deletes their data.
import fs from "node:fs";
import path from "node:path";
import { pluginMeta } from "../plugin-meta.mjs";
import { pruneEmpty } from "../prune.mjs";

const meta = pluginMeta();
export const MARKETPLACE = meta.claudeMarketplace;
export const ID = `${meta.plugin}@${MARKETPLACE}`;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

/** @returns {{installed: boolean, version: string|null, enabled: boolean, marketplace: string|null, otherCopy: string|null, trusted: true, versions: string[]}} */
export function readState(home) {
  const installed = readJson(path.join(home, "plugins", "installed_plugins.json"))?.plugins ?? {};
  const known = readJson(path.join(home, "plugins", "known_marketplaces.json"))?.[MARKETPLACE];
  const settings = readJson(path.join(home, "settings.json")) ?? {};
  const entries = Array.isArray(installed[ID]) ? installed[ID] : [];
  const entry = entries.find((e) => e.scope === "user") ?? entries[0];
  const ids = [...Object.keys(installed), ...Object.keys(settings.enabledPlugins ?? {})];
  return {
    installed: Boolean(entry),
    version: entry?.version ?? null,
    enabled: settings.enabledPlugins?.[ID] === true,
    marketplace: known?.installLocation ?? known?.source?.path ?? settings.extraKnownMarketplaces?.[MARKETPLACE]?.source?.path ?? null,
    otherCopy: ids.find((k) => k.startsWith(`${meta.plugin}@`) && k !== ID) ?? null,
    trusted: true,
    versions: entries.map((e) => e.version).filter(Boolean),
  };
}

/** The commands that bring this home to Recall `V` from the marketplace at `M` (`pointsHere`: the home's marketplace already is M). */
export function installSteps(state, { M, V, pointsHere }) {
  const steps = [];
  if (!pointsHere) steps.push(["plugin", "marketplace", "add", M, "--json"]);
  if (!state.installed) return [...steps, ["plugin", "install", ID, "--json"]];
  if (state.version !== V || !pointsHere) steps.push(["plugin", "marketplace", "update", MARKETPLACE, "--json"], ["plugin", "update", ID, "--json"]);
  if (!state.enabled) steps.push(["plugin", "install", ID, "--json"]); // install re-enables a disabled plugin
  return steps;
}

export function uninstallSteps(state) {
  return [
    ...(state.installed ? [["plugin", "uninstall", ID, "--json"]] : []),
    ...(state.marketplace ? [["plugin", "marketplace", "remove", MARKETPLACE, "--json"]] : []),
  ];
}

/** Did a command succeed? Claude prints a JSON line last with outcome "ok". */
export function succeeded(result, json) {
  return result.exitCode === 0 && json?.outcome === "ok";
}

/** After installing: version V, enabled, and the marketplace is M. */
export const verified = (state, { V, pointsHere }) => state.installed && state.version === V && state.enabled && pointsHere;

/** Nothing to prepare: the claude CLI creates a missing home. */
export function prepare() {}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * After an uninstall: Claude Code marks the plugin's cached copies with .orphaned_at and deletes them itself later. When every version
 * folder in <home>/plugins/cache/plugin-recall carries that mark (or there is none), the whole folder goes now. Returns "removed" or "left".
 */
export function clearCache(home) {
  const dir = path.join(home, "plugins", "cache", MARKETPLACE);
  if (!isDir(dir)) return "removed";
  const versions = fs.readdirSync(dir).flatMap((plugin) => (isDir(path.join(dir, plugin)) ? fs.readdirSync(path.join(dir, plugin)).map((v) => path.join(dir, plugin, v)) : [null]));
  if (versions.every((v) => v && isDir(v) && fs.existsSync(path.join(v, ".orphaned_at")))) {
    fs.rmSync(dir, { recursive: true, force: true });
    return "removed";
  }
  return pruneEmpty(dir) ? "removed" : "left";
}
