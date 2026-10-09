/**
 * Which repository a Claude project directory (or a Codex working directory) belongs to, answered from git on disk and never invented.
 * A Claude project directory name writes `/` and `.` both as `-`, so the name alone cannot say where one directory ends and the next
 * begins; the disk can. `repoOfCwd` answers the same question for a Codex session's cwd.
 */

import fs from "node:fs";
import path from "node:path";

/** The directory name a worktree lives under, in the layouts agent tools use. */
const WORKTREE_PART = /^(?:worktrees?|wt)$/i;

const isDirectory = (file) => {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
};

/**
 * The path a Claude project directory was named after, as far as it still exists. Claude writes `/` and `.` both as `-`, so
 * `-home-me-code-acme-web-app` is `acme/web-app` and not `acme/web/app`, and only the disk knows which. Longest run first, one directory at
 * a time, stopping at the first segment that no longer exists: a worktree is deleted when its branch lands, and its transcripts outlive it.
 */
function decodeProjectDir(parts, root) {
  let dir = root;
  let taken = 0;
  // What owned the first worktree directory the walk went through: the segments before the marker in the same name (`app-worktrees` → the
  // sibling `app`), or the checkout the walk was standing in when the marker was its own directory (`app` + `.worktrees`). `undefined`
  // until one is met.
  let marker;
  walk: while (taken < parts.length) {
    for (let run = parts.length - taken; run >= 1; run -= 1) {
      const segment = parts.slice(taken, taken + run);
      for (const candidate of [segment.join("-"), `.${segment.join("-")}`]) {
        const next = path.join(dir, candidate);
        if (!isDirectory(next)) continue;
        const at = segment.findIndex((part) => WORKTREE_PART.test(part));
        if (at >= 0 && marker === undefined) marker = at > 0 ? segment.slice(0, at).join("-") : repoContaining(dir, root);
        dir = next;
        taken += run;
        continue walk;
      }
    }
    break;
  }
  return { dir: taken ? dir : null, rest: parts.slice(taken), marker };
}

/**
 * The repository `dir` sits in, itself or just above it, or null. The walk up is short and it is for one thing: a decode can stop one turn
 * down a side road, because `app/.claude` is a real directory and `app/.claude-worktrees/<slug>` is the directory the name meant. From either
 * of them the repo overhead is the same `app`, and two levels is as far as a checkout is ever from the transcript's own cwd.
 */
function repoContaining(dir, root, levels = 2) {
  for (let at = dir, left = levels; at !== root && at !== path.dirname(at); at = path.dirname(at), left -= 1) {
    const repo = repoOfCheckout(at);
    if (repo) return repo;
    if (left <= 0) break;
  }
  return null;
}

/** The repository a checkout belongs to, from its own `.git`, or null. */
function repoOfCheckout(dir) {
  const git = path.join(dir, ".git");
  let stat;
  try { stat = fs.statSync(git); } catch { return null; }
  if (stat.isDirectory()) return path.basename(dir);
  // A linked worktree's `.git` is a file naming the repository that owns it:
  // `gitdir: /path/to/app/.git/worktrees/<branch slug>`.
  let link = "";
  try { link = fs.readFileSync(git, "utf8"); } catch { return path.basename(dir); }
  const owner = /gitdir:\s*(.+?)\/\.git\/worktrees\//.exec(link.trim());
  return path.basename(owner ? owner[1] : dir);
}

/**
 * `-home-me-code-acme` → `acme`, and a worktree of it → `acme` as well.
 *
 * A repo name is a citation ("you asked for this in `strip`" is a claim about a repository), so the name is decoded against the disk and the
 * answer comes from git: the checkout's own `.git`, or, for a linked worktree, the repository its `.git` file points back at. Taking the last
 * segment of the project directory name would file a task worktree's statements under the task's slug. When the directory is gone (the common
 * case for a finished branch) the fallback is structural: cut the name at the worktree segment and take what is left. Nothing invents a repo:
 * a path with a worktree in it that cannot be resolved is `null`, because no repo is better than the wrong one.
 */
const REPO_OF_DIR = new Map();

export function repoFromProjectDir(name, { root = path.sep } = {}) {
  const key = `${root}\u0000${name}`;
  if (REPO_OF_DIR.has(key)) return REPO_OF_DIR.get(key);
  const repo = resolveRepo(String(name).split("-").filter(Boolean), root);
  // A home holds thousands of transcripts across a few dozen project directories, and each answer costs a handful of `stat` calls.
  REPO_OF_DIR.set(key, repo);
  return repo;
}

function resolveRepo(parts, root) {
  if (!parts.length) return null;
  const { dir, rest, marker } = decodeProjectDir(parts, root);
  if (dir && !rest.length) {
    const repo = repoOfCheckout(dir);
    if (repo) return repo;
  }
  // A marker met on a directory that really exists is the better answer: it was
  // read off the layout rather than guessed at from the name.
  if (marker) return marker;
  const at = rest.findIndex((part) => WORKTREE_PART.test(part));
  // The marker is in the part of the name the disk could not confirm. What
  // stands before it is the repo — the whole of it when a real directory was
  // decoded first, and only its last segment when nothing was, because then
  // those parts are still a whole path.
  if (at > 0) return dir ? rest.slice(0, at).join("-") : rest[at - 1];
  if (at === 0) return dir ? repoContaining(dir, root) : null;
  if (marker === null) return null;
  if (dir && !rest.length) return path.basename(dir);
  return rest[rest.length - 1] ?? null;
}

/**
 * The repository a working directory belongs to (Codex records its cwd), by the
 * same rule: the checkout's own `.git`, or the repository a linked worktree
 * points back at, looking a few levels up. Null when there is none.
 */
export function repoOfCwd(cwd) {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
  for (let dir = cwd, left = 6; left > 0 && dir !== path.dirname(dir); dir = path.dirname(dir), left -= 1) {
    const repo = repoOfCheckout(dir);
    if (repo) return repo;
  }
  return null;
}
