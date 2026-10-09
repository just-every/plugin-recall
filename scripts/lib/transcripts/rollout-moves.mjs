// A Codex or Every Code rollout lives in <home>/sessions/YYYY/MM/DD/ until its thread is archived, which moves it to <home>/archived_sessions/
// under the same file name; a copy can also sit in both places. A statement's id never depends on where its file is (host, time and text:
// indexer.mjs), so a move cannot change an id or orphan a card (cards are keyed by statement id). What does depend on the path is the scan
// state (keyed by file) and each statement's src. So:
//   - one copy per rollout name is scanned (pickRolloutCopies): the copy the scan state already knows, else the larger, else sessions/;
//   - a rollout that has no scan state, while the state still has the same name at a path of the same home that no longer exists, has moved:
//     it takes that state over (so an unchanged file is not opened, a grown one is read from where it stopped) and the statements whose src
//     names the old path are pointed at the new one (repointMovedSources).
import fs from "node:fs";
import path from "node:path";
import { parseSrc } from "../cards/context-source.mjs";
import { isArchivedRollout } from "./files.mjs";

const ROOTS = ["sessions", "archived_sessions"];

const rootPrefixes = (home) => ROOTS.map((r) => `${path.join(home, r)}${path.sep}`);
const underHome = (file, prefixes) => prefixes.some((p) => file.startsWith(p));

/**
 * One file per rollout name. `files` are one home's listing; dropped copies are counted in the tally as `rollout-copy`.
 * @returns {object[]} the kept files, in the listing's order
 */
export function pickRolloutCopies(files, state, tally) {
  const byName = new Map();
  for (const f of files) {
    const name = path.basename(f.file);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(f);
  }
  const keep = new Set();
  for (const copies of byName.values()) {
    if (copies.length === 1) { keep.add(copies[0]); continue; }
    const known = copies.find((f) => state.files[f.file]);
    const best = known ?? [...copies].sort((a, b) => b.size - a.size || Number(isArchivedRollout(a.file)) - Number(isArchivedRollout(b.file)))[0];
    keep.add(best);
    for (let i = 1; i < copies.length; i++) tally.drop("rollout-copy");
  }
  return files.filter((f) => keep.has(f));
}

/**
 * Move the scan state of every rollout of `home` that moved to its new path.
 * @returns {{from: string, to: string}[]} the moves made (state.files is changed in place)
 */
export function adoptMovedRollouts({ home, files, state }) {
  const prefixes = rootPrefixes(home);
  const fresh = files.filter((f) => !state.files[f.file]);
  if (!fresh.length) return [];
  const stateByName = new Map();
  for (const key of Object.keys(state.files)) {
    if (underHome(key, prefixes)) stateByName.set(path.basename(key), key);
  }
  const moves = [];
  for (const f of fresh) {
    const old = stateByName.get(path.basename(f.file));
    if (!old || old === f.file || fs.existsSync(old)) continue;
    state.files[f.file] = state.files[old];
    delete state.files[old];
    stateByName.delete(path.basename(f.file));
    moves.push({ from: old, to: f.file });
  }
  return moves;
}

/** Point the src of every statement read from a moved file at its new path. Returns how many statements were changed. */
export function repointMovedSources(store, moves) {
  if (!moves.length) return 0;
  const to = new Map(moves.map((m) => [m.from, m.to]));
  let changed = 0;
  store.updateStatements((rows) => {
    const next = rows.map((s) => {
      const src = parseSrc(s.src);
      if (!src || !to.has(src.file)) return s;
      changed++;
      return { ...s, src: `${to.get(src.file)}:L${src.line}` };
    });
    return changed ? next : null;
  });
  return changed;
}
