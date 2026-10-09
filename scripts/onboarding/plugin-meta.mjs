// Facts about this plugin that setup and doctor print, read from the plugin's own files so they cannot drift from the manifests.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ...p), "utf8"));

/** Name, version, and the marketplace and plugin names each host knows it by. */
export function pluginMeta() {
  const pkg = readJson("package.json");
  const claudeMarketplace = readJson(".claude-plugin", "marketplace.json");
  const codexMarketplace = readJson(".agents", "plugins", "marketplace.json");
  const plugin = readJson(".claude-plugin", "plugin.json").name;
  return {
    name: pkg.name,
    version: pkg.version,
    plugin,
    claudeMarketplace: claudeMarketplace.name,
    codexMarketplace: codexMarketplace.name,
  };
}

/** The one command a person can always run, whether or not `recall` is on their PATH; every hint Recall prints uses it. */
export const ONE_LINER = "npx -y @just-every/plugin-recall";
