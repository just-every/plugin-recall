// The `recall` command: ~/.local/bin/recall, a symlink to bin/recall in the installed version directory. Setup creates or updates it only
// when the path is free or already Recall's own link (one that points into <dataDir>/marketplace/plugins/); anything else there is left alone.
import fs from "node:fs";
import path from "node:path";
import { pluginsDir, versionDir } from "./marketplace.mjs";
import { ONE_LINER } from "./plugin-meta.mjs";

export const launcherPath = (homeDir) => path.join(homeDir, ".local", "bin", "recall");
export const launcherTarget = (dataDir, V) => path.join(versionDir(dataDir, V), "bin", "recall");

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** "absent", "current" (Recall's link to this version), "stale" (Recall's link to another version) or "foreign". */
export function launcherState({ homeDir, dataDir, V }) {
  const link = launcherPath(homeDir);
  let stat;
  try { stat = fs.lstatSync(link); } catch { return "absent"; }
  if (!stat.isSymbolicLink()) return "foreign";
  const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
  const plugins = pluginsDir(dataDir);
  const ours = [target, real(target)].some((t) => [plugins, real(plugins)].some((p) => t.startsWith(`${p}${path.sep}`)));
  if (!ours) return "foreign";
  return real(target) === real(launcherTarget(dataDir, V)) || target === launcherTarget(dataDir, V) ? "current" : "stale";
}

/**
 * Point ~/.local/bin/recall at version V (only when launcherState says it is free or Recall's). Returns the folders it had to make, deepest
 * first (~/.local/bin, and ~/.local when that was missing too), so uninstall can remove them again.
 */
export function writeLauncher({ homeDir, dataDir, V }) {
  const link = launcherPath(homeDir);
  const createdDirs = [path.dirname(link), path.dirname(path.dirname(link))].filter((d) => !fs.existsSync(d));
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o755 });
  const tmp = `${link}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(launcherTarget(dataDir, V), tmp);
  fs.renameSync(tmp, link);
  return { createdDirs };
}

/** Remove the launcher if it is Recall's own link, then the folders setup made for it (`createdDirs`) that are empty now. Returns whether it removed the link. */
export function removeLauncher({ homeDir, dataDir, V, createdDirs = [] }) {
  const state = launcherState({ homeDir, dataDir, V });
  if (state !== "current" && state !== "stale") return false;
  fs.rmSync(launcherPath(homeDir), { force: true });
  for (const dir of createdDirs) {
    try { fs.rmdirSync(dir); } catch { break; /* not empty: something else lives there now, and so in its parent */ }
  }
  return true;
}

/**
 * How the summary names the command: `recall` when the first `recall` on PATH is the launcher, else `~/.local/bin/recall` when the
 * launcher is Recall's, else the one-liner.
 */
export function commandName({ homeDir, env, dataDir, V }) {
  const link = launcherPath(homeDir);
  const state = launcherState({ homeDir, dataDir, V });
  if (state !== "current") return ONE_LINER;
  for (const dir of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(path.resolve(dir), "recall");
    try { fs.accessSync(candidate, fs.constants.X_OK); } catch { continue; }
    return path.resolve(candidate) === path.resolve(link) ? "recall" : "~/.local/bin/recall";
  }
  return "~/.local/bin/recall";
}

const EXPORT = `echo 'export PATH="$HOME/.local/bin:$PATH"'`;

/**
 * The one command that puts ~/.local/bin on the PATH of the person's login shell ($SHELL). zsh: appended to ~/.zshrc; bash: to
 * ~/.bash_profile on macOS (Terminal starts login shells), ~/.bashrc elsewhere; fish: fish_add_path; any other shell: ~/.profile.
 */
export function pathLine(env, platform = process.platform) {
  const shell = path.basename(String(env.SHELL ?? ""));
  if (shell === "fish") return "fish_add_path ~/.local/bin";
  const file = shell === "zsh" ? "~/.zshrc" : shell === "bash" ? (platform === "darwin" ? "~/.bash_profile" : "~/.bashrc") : "~/.profile";
  return `${EXPORT} >> ${file}`;
}
