// `recall uninstall [--yes] [--purge] [--homes <list>]`: remove Recall from every agent home it is in (through each host's own CLI), then its
// marketplace copy and the recall command, and with --purge the whole data dir. With --homes only those homes lose Recall, and the copy, the
// command and the data stay for the others. Another copy of Recall in a home is never touched. It may run from the installed copy itself
// (~/.local/bin/recall uninstall): every import is static and the copy is removed last.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDataDir } from "../lib/config.mjs";
import { resolveHome } from "../lib/home-paths.mjs";
import { UsageError } from "../lib/usage-error.mjs";
import { requiredProviders } from "../lib/providers/index.mjs";
import { discoverHomes, hostLabel } from "./agent-homes.mjs";
import { envFileState } from "./env-file.mjs";
import { hasOwnCopy, readHomeState, uninstallHome } from "./hosts/index.mjs";
import { mapLimit, run as runCommand } from "./hosts/runner.mjs";
import { dropInstalls, readInstalls, removeInstalls } from "./install-record.mjs";
import { launcherState, removeLauncher } from "./launcher.mjs";
import { marketplaceDir } from "./marketplace.mjs";
import { ONE_LINER, pluginMeta } from "./plugin-meta.mjs";
import { cliVersion } from "./probes.mjs";
import { keep, padRows, plural, tildePath } from "./ui.mjs";

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** Is `dir` the root, the home folder, or a folder that holds the home folder? --purge refuses those. */
const unsafeToPurge = (dir, homeDir) => {
  const d = real(dir);
  const h = real(homeDir);
  return d === path.parse(d).root || h === d || h.startsWith(`${d}${path.sep}`);
};

/** The homes to act on: recorded as installed, or discovered with Recall's copy or marketplace; and the ones holding another copy. */
function targets({ homeDir, env, dataDir, V }) {
  const found = { claude: cliVersion("claude", { env }).found, codex: cliVersion("codex", { env }).found };
  const rows = discoverHomes({ homeDir, env, hosts: found }).filter((r) => r.exists);
  for (const h of readInstalls(dataDir)?.homes ?? []) {
    if (h.status !== "installed" || rows.some((r) => real(r.home) === real(h.home))) continue;
    rows.push({ host: h.host, label: hostLabel(h.host), home: h.home, display: tildePath(h.home, homeDir), recorded: true });
  }
  const mine = [];
  const others = [];
  for (const r of rows) {
    r.state = readHomeState(r, V);
    if (r.state.otherCopy) others.push(r);
    else if (r.recorded || hasOwnCopy(r.state)) mine.push(r);
  }
  return { mine, others };
}

/** --homes: the rows of `mine` it names (comma separated, ~/x or absolute). */
function namedRows(value, mine, homeDir) {
  const picked = new Set();
  for (const raw of String(value).split(",").map((x) => x.trim()).filter(Boolean)) {
    const row = mine.find((r) => real(r.home) === real(resolveHome(raw, homeDir)));
    if (!row) throw new UsageError(`--homes: ${raw} is not a home Recall is installed in`);
    picked.add(row);
  }
  return mine.filter((r) => picked.has(r));
}

/**
 * @param {{flags: {yes?: boolean, purge?: boolean, homes?: string|null}, env?: object, homeDir?: string, prompter: object, ui: object, run?: Function}} o
 * @returns {Promise<number>}
 */
export async function runUninstall({ flags, env = process.env, homeDir = os.homedir(), prompter, ui, run = runCommand }) {
  const V = pluginMeta().version;
  const dataDir = resolveDataDir({ ...env, HOME: homeDir });
  if (flags.homes && flags.purge) throw new UsageError("--purge removes Recall everywhere; it does not go with --homes");
  ui.say(`Recall ${V} · uninstall`, "");
  if (flags.purge && unsafeToPurge(dataDir, homeDir)) return (ui.say(`--purge refuses to delete ${ui.path(dataDir)}: it is the home folder or holds it. Nothing was changed.`), 1);
  const { mine: all, others } = targets({ homeDir, env, dataDir, V });
  const mine = flags.homes ? namedRows(flags.homes, all, homeDir) : all;
  const staying = all.filter((r) => !mine.includes(r)); // homes that keep Recall because --homes did not name them
  const M = marketplaceDir(dataDir);
  const launcher = launcherState({ homeDir, dataDir, V });
  const leftovers = fs.existsSync(M) || launcher === "current" || launcher === "stale" || Boolean(readInstalls(dataDir));
  const data = ui.path(dataDir);
  if (!mine.length && !leftovers && !(flags.purge && fs.existsSync(dataDir))) {
    ui.say("Recall is not installed in any agent home.");
    if (fs.existsSync(dataDir)) ui.say(`Your data is still in ${data}. To delete it:`, `  ${keep(`${ONE_LINER} uninstall --purge`)}`);
    return 0;
  }
  if (mine.length || others.length) {
    ui.say(`Recall is installed in ${plural(all.length, "home")}:`);
    ui.raw(...padRows([...all.map((r) => [r.display, r.label]), ...others.map((r) => [`·  ${r.display}`, r.label, `has ${r.state.otherCopy}; left alone`])]));
  }
  const what = mine.length ? `Remove Recall from ${plural(mine.length, "home")}` : "Remove what is left of Recall";
  const question = flags.purge ? `${what} and delete ${data} (index, summaries, logs, settings)?` : `${what}?`;
  if (!(await prompter.confirm(question, { fallback: false }))) return (ui.say("Stopped. Nothing was changed."), 0);

  const results = await mapLimit(mine, 4, (row) => uninstallHome(row, { run, base: env, homeDir }));
  ui.raw(...padRows(mine.map((r, i) => [`${ui.glyph(results[i].ok ? "ok" : "fail")} ${r.display}`, r.label, results[i].ok ? "removed" : `failed: ${results[i].reason}`])));
  if (results.some((r) => !r.ok)) {
    ui.blank();
    ui.say("Recall is still in the homes listed as failed; its copy and the recall command are kept for them.", `Fix the cause, then run: ${keep(`${ONE_LINER} uninstall`)}`);
    return 1;
  }
  if (staying.length) {
    dropInstalls(dataDir, mine.map((r) => r.home));
    ui.blank();
    ui.say(`Recall is removed from ${plural(mine.length, "home")}. It stays in ${staying.map((r) => r.display).join(", ")}.`, `  To remove it everywhere: ${keep(`${ONE_LINER} uninstall`)}`);
    return 0;
  }
  const createdDirs = (readInstalls(dataDir)?.createdDirs ?? []).filter((d) => typeof d === "string");
  removeInstalls(dataDir);
  if (fs.existsSync(M)) { fs.rmSync(M, { recursive: true, force: true }); ui.item("ok", `Removed ${ui.path(M)}`); }
  if (removeLauncher({ homeDir, dataDir, V, createdDirs })) ui.item("ok", "Removed the recall command (~/.local/bin/recall)");
  if (flags.purge && fs.existsSync(dataDir)) { fs.rmSync(dataDir, { recursive: true, force: true }); ui.item("ok", `Deleted ${data}`); }
  for (const [i, r] of mine.entries()) {
    if (results[i].cacheLeft) ui.item("skip", `${ui.path(results[i].cacheLeft)}: ${r.label} deletes its cached copy there itself`);
  }

  ui.blank();
  ui.say("Recall is uninstalled.");
  if (!flags.purge) ui.say(`  Kept: your index, summaries and logs in ${data}.`, `    Delete them with: ${keep(`rm -rf ${data}`)}`, `    or: ${keep(`${ONE_LINER} uninstall --purge`)}`);
  for (const p of requiredProviders({})) {
    if (envFileState(path.join(homeDir, ".env"), p.envName).value) ui.say(`  Kept: ${p.envName} in ~/.env, which other tools may use.`);
  }
  return 0;
}
