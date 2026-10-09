// Statements indexed with no repo because their directory was gone (or was no checkout) get the repo their session's working directory names.
// The working directory is the one the scan state kept for the transcript (Codex session_meta); no transcript is read again. Idempotent: a
// statement whose session names no repo stays without one, and a statement that has a repo is never touched.
import { repoOfSession } from "./repo-identity.mjs";

const fileOf = (src) => (typeof src === "string" ? src.replace(/:L\d+$/, "") : null);

/**
 * @param {{store: object, state: {files: object}, homeDir?: string}} o
 * @returns {number} how many statements were given a repo
 */
export function repairStatementRepos({ store, state, homeDir }) {
  const byFile = new Map();
  const repoOf = (file) => {
    if (!byFile.has(file)) {
      const meta = state.files[file]?.meta;
      byFile.set(file, meta?.cwd ? repoOfSession({ cwd: meta.cwd, gitUrl: meta.git_url ?? null, ...(homeDir ? { home: homeDir } : {}) }) : null);
    }
    return byFile.get(file);
  };
  let repaired = 0;
  store.updateStatements((rows) => {
    const next = rows.map((s) => {
      if (s.repo) return s;
      const file = fileOf(s.src);
      const repo = file ? repoOf(file) : null;
      if (!repo) return s;
      repaired++;
      return { ...s, repo };
    });
    return repaired ? next : null;
  });
  return repaired;
}
