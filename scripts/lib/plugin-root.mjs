// Where the plugin is running from, and how a path is written for the agent: the root the host gave the hook (CLAUDE_PLUGIN_ROOT, then
// PLUGIN_ROOT), else the root this script lives in (scripts/lib/..), so a command printed into an agent's context runs the same copy of the
// plugin that printed it, in that home.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @param {object} [env] */
export const pluginRoot = (env = process.env) => env.CLAUDE_PLUGIN_ROOT || env.PLUGIN_ROOT || OWN_ROOT;

/** A path under the home dir written with "~"; any other path as it is. */
export function tildePath(file, home = os.homedir()) {
  if (typeof file !== "string" || !home) return file;
  const h = home.replace(/[\\/]+$/, "");
  return file === h ? "~" : file.startsWith(`${h}/`) ? `~${file.slice(h.length)}` : file;
}

/** A shell word for `file`: as it is when it needs no quoting, else in double quotes. */
export const shellWord = (file) => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(file) ? file : `"${file.replace(/(["\\$`])/g, "\\$1")}"`);
