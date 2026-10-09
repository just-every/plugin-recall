// Removing folders that hold nothing: what setup made before a stop, and the host cache folders uninstall leaves empty.
import fs from "node:fs";
import path from "node:path";

/** Remove `dir` when it holds nothing but empty folders; returns whether it is gone. */
export function pruneEmpty(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
  if (!entries.every((e) => e.isDirectory() && pruneEmpty(path.join(dir, e.name)))) return false;
  fs.rmdirSync(dir);
  return true;
}

/** The entries of `dir` now (null when it does not exist), to undo with pruneSince what a run then made empty. */
export function entriesOf(dir) {
  try { return new Set(fs.readdirSync(dir)); } catch { return null; }
}

/** Remove the entries of `dir` that were not in `before` and hold only empty folders, then `dir` itself if it did not exist and is empty. */
export function pruneSince(dir, before) {
  for (const name of entriesOf(dir) ?? []) if (!before?.has(name)) pruneEmpty(path.join(dir, name));
  if (before === null) pruneEmpty(dir);
}
