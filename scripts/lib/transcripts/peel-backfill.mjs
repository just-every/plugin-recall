// A file the indexer has read is never read again while it is unchanged (indexer.mjs), so a change to the owner-text rules would reach new
// files only: a peel that keeps words an earlier version threw away (the Codex app envelope, the Claude Desktop quote reply:
// text-filter/desktop.mjs) would never reach the turns already read, and a rule that rejects what an earlier version kept would never take
// it out. Every scan state records the PEEL_VERSION it was read under. A file whose state records an older one (or none: written before
// 0.4.0) is read once more from the start: a line that holds no statement is judged like a new turn, and a line that holds one is judged
// again (rejudge.mjs: the statement is kept, rewritten in place under its id, or retired). Bump PEEL_VERSION whenever a change to the
// owner-text rules or the scanners changes what a turn already read yields.
//   1  0.4.0: the desktop-app envelope peels, legacy rollouts, typed-prompt logs, Every Code turns decided by the logs
//   2  lines that hold a statement are judged again; the Auto Drive idle gap; host prompts (Claude Desktop auto-resume, /init); the
//      Auto Drive goal of a session that has a rollout
export const PEEL_VERSION = 2;

/** Does this scan state need the one-time read from the start? */
export const needsPeelBackfill = (prev) => Boolean(prev) && prev.peel !== PEEL_VERSION;

/** A file's new scan state, stamped with the peel version it was read under. */
export const stampPeel = (state) => ({ ...state, peel: PEEL_VERSION });
