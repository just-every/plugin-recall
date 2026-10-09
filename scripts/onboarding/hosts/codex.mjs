// Codex: Recall's state in one home, read from its config.toml and plugin cache, and the `codex plugin` commands that install, update and
// remove it. Codex caches a plugin by version (<home>/plugins/cache/<marketplace>/<plugin>/<version>/) and refuses to re-add a marketplace
// from a different source, so a repointed marketplace is removed first; removal keeps the plugin entry and the hook trust entry.
//   [marketplaces.plugin-recall]          source = "<M>"
//   [plugins."recall@plugin-recall"]      enabled = false when disabled
//   [hooks.state."recall@plugin-recall:...]   present once the hook was trusted
import fs from "node:fs";
import path from "node:path";
import { compareVersions } from "../marketplace.mjs";
import { pluginMeta } from "../plugin-meta.mjs";
import { pruneEmpty } from "../prune.mjs";

const meta = pluginMeta();
export const MARKETPLACE = meta.codexMarketplace;
export const ID = `${meta.plugin}@${MARKETPLACE}`;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The body of a TOML table `[name]`, up to the next table header, or null. */
const table = (toml, name) => new RegExp(`^\\[${esc(name)}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m").exec(toml)?.[1] ?? null;

function tomlString(body, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')`, "m").exec(body ?? "");
  if (!m) return null;
  if (m[1].startsWith("'")) return m[1].slice(1, -1);
  try { return JSON.parse(m[1]); } catch { return m[1].slice(1, -1); }
}

const cacheDir = (home) => path.join(home, "plugins", "cache", MARKETPLACE, meta.plugin);

/** @returns {{installed: boolean, configured: boolean, version: string|null, enabled: boolean, marketplace: string|null, otherCopy: string|null, trusted: boolean, versions: string[]}} */
export function readState(home, { V } = {}) {
  let toml = "";
  try { toml = fs.readFileSync(path.join(home, "config.toml"), "utf8"); } catch { /* no config yet */ }
  const plugin = table(toml, `plugins."${ID}"`);
  let versions = [];
  try { versions = fs.readdirSync(cacheDir(home), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(compareVersions); } catch { /* nothing cached */ }
  const others = [...toml.matchAll(/^\[plugins\."([^"]+)"\]\s*$/gm)].map((m) => m[1]).filter((id) => id.startsWith(`${meta.plugin}@`) && id !== ID);
  const configured = plugin !== null;
  return {
    installed: configured && versions.length > 0,
    configured,
    version: versions.includes(V) ? V : (versions.at(-1) ?? null),
    enabled: configured && !/^\s*enabled\s*=\s*false\b/m.test(plugin),
    marketplace: tomlString(table(toml, `marketplaces.${MARKETPLACE}`), "source"),
    otherCopy: others[0] ?? null,
    trusted: new RegExp(`^\\[hooks\\.state\\."${esc(ID)}:`, "m").test(toml),
    versions,
  };
}

export function installSteps(state, { M, V, pointsHere }) {
  const steps = [];
  if (state.marketplace && !pointsHere) steps.push(["plugin", "marketplace", "remove", MARKETPLACE, "--json"]);
  if (!pointsHere) steps.push(["plugin", "marketplace", "add", M, "--json"]);
  if (!state.installed || !state.enabled || !state.versions.includes(V)) steps.push(["plugin", "add", ID, "--json"]);
  return steps;
}

export function uninstallSteps(state) {
  return [
    ...(state.configured ? [["plugin", "remove", ID, "--json"]] : []),
    ...(state.marketplace ? [["plugin", "marketplace", "remove", MARKETPLACE, "--json"]] : []),
  ];
}

/** Codex exits 0 and prints a JSON object on success. */
export const succeeded = (result) => result.exitCode === 0;

/** After installing: enabled, the marketplace is M, and the cache holds version V. */
export const verified = (state, { V, pointsHere }) => state.configured && state.enabled && pointsHere && state.versions.includes(V);

/** Codex refuses a CODEX_HOME that does not exist: create the default home (0700) before the first command. */
export function prepare(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
}

/** After an uninstall: `codex plugin remove` deletes the cached copy and may leave empty folders; remove those. Returns "removed" or "left". */
export function clearCache(home) {
  return pruneEmpty(path.join(home, "plugins", "cache", MARKETPLACE)) ? "removed" : "left";
}
