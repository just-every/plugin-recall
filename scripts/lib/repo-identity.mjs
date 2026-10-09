// Which repo a session belongs to, and when two repo names are the same repo.
//   1. the checkout on disk: its own .git, or the repository a linked worktree points back at (repoOfCwd);
//   2. when the directory is gone, or was never a checkout, the working directory's layout alone (structuralRepo, no disk access);
//   3. when that names nothing either, the name of the repository the session recorded (a Codex session_meta git.repository_url).
// A directory that was deleted or renamed after the session must not make its statements repo-less: with no repo, the scope rule can only
// treat them as another repo's. Nothing is invented: a cwd none of these layouts explains is null.
// Aliases (config repoAliases) say that a renamed or sibling repo is the same repo for the scope rule: canonicalRepo / sameRepo.
import os from "node:os";
import { repoOfCwd } from "./repo-of-dir.mjs";

// Directories directly under the home folder that are not projects.
const NOT_PROJECTS = new Set(["Documents", "Desktop", "Downloads", "Library", "Applications", "Movies", "Music", "Pictures", "Public", "www"]);

/**
 * The repo a working directory's PATH names, without looking at the disk:
 *   <tool home>/worktrees/<id>/<repo>[/..]          Codex and Every Code worktrees          -> <repo>
 *   <repo>/.claude/worktrees/<name>, <repo>/.worktrees/<name>, <repo>-worktrees/<name>   -> <repo>
 *   <home>/www/<org>/<repo>[/..]                    a project directory under an org        -> <repo>
 *   <home>/www/<repo>[/..], <home>/<repo>[/..]      a project directory                     -> <repo>
 * @param {string} cwd absolute path
 * @param {string} [home] the home folder the project directories hang from (default: this machine's)
 * @returns {string|null}
 */
export function structuralRepo(cwd, home = os.homedir()) {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
  const parts = cwd.split("/").filter(Boolean);
  const wt = parts.findIndex((p, i) => i > 0 && (p === "worktrees" || p === ".worktrees" || p.endsWith("-worktrees")));
  if (wt > 0) {
    const dir = parts[wt];
    const owner = parts[wt - 1];
    if (dir.endsWith("-worktrees") && dir !== "worktrees") return dir.slice(0, -"-worktrees".length) || null;
    if (dir === ".worktrees") return owner;
    if (owner === ".claude") return parts[wt - 2] ?? null;
    return parts[wt + 2] ?? null; // <tool home>/worktrees/<id>/<repo>
  }
  const base = home.replace(/\/+$/, "").split("/").filter(Boolean);
  if (base.length === 0 || base.some((p, i) => parts[i] !== p) || parts.length <= base.length) return null;
  const rest = parts.slice(base.length);
  if (rest[0] === "www") return rest[2] ?? rest[1] ?? null;
  if (rest[0].startsWith(".") || NOT_PROJECTS.has(rest[0])) return null;
  return rest[0];
}

/** The repository name in a git remote URL (https://host/org/name(.git), git@host:org/name.git), or null. */
export function repoOfGitUrl(url) {
  if (typeof url !== "string") return null;
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop()?.replace(/\.git$/, "");
  return last || null;
}

/**
 * The repo of a session, from the working directory it was started in (and the git remote it recorded, if any).
 * @param {{cwd: string|null, gitUrl?: string|null, home?: string}} o
 */
export function repoOfSession({ cwd, gitUrl = null, home = os.homedir() }) {
  return repoOfCwd(cwd) ?? structuralRepo(cwd, home) ?? repoOfGitUrl(gitUrl);
}

/** The canonical name of a repo under an alias map ({"old-or-sibling": "canonical"}, validated by the config: no chains). */
export const canonicalRepo = (repo, aliases) => (repo && aliases && Object.hasOwn(aliases, repo) ? aliases[repo] : repo ?? null);

/** Are two repo names the same repo? A missing repo (null) is never the same as anything. */
export const sameRepo = (a, b, aliases) => Boolean(a) && Boolean(b) && canonicalRepo(a, aliases) === canonicalRepo(b, aliases);
