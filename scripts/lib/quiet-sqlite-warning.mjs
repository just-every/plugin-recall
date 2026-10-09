// Node 22 prints "ExperimentalWarning: SQLite is an experimental feature and might change at any time" to stderr the first time
// node:sqlite loads (Node 24+ does not). Recall's output is read by hosts and people, so that one line is dropped. Every other
// warning, and every other ExperimentalWarning, still goes through untouched.
// Import this module FIRST in every entry point, before anything that can load node:sqlite (scripts/lib/sqlite.mjs also imports it).
const SQLITE_WARNING = /^SQLite is an experimental feature\b/;

export function isSqliteExperimentalWarning(warning, type) {
  const kind = typeof type === "object" && type !== null ? type.type : type;
  const name = kind ?? (warning instanceof Error ? warning.name : undefined);
  if (name !== "ExperimentalWarning") return false;
  const message = warning instanceof Error ? warning.message : String(warning);
  return SQLITE_WARNING.test(message);
}

const INSTALLED = Symbol.for("plugin-recall.quietSqliteWarning");
if (!process[INSTALLED]) {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, type, ...rest) {
    if (isSqliteExperimentalWarning(warning, type)) return;
    return emitWarning.call(this, warning, type, ...rest);
  };
  process[INSTALLED] = true;
}
