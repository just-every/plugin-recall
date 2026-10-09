// The one place node:sqlite is loaded, and only when a database is first opened: paths that never touch SQLite (--version, help,
// a disabled hook) do not load it at all.
import "./quiet-sqlite-warning.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let DatabaseSync;
/** Open a SQLite database file (node:sqlite DatabaseSync). */
export function openDatabase(file) {
  DatabaseSync ??= require("node:sqlite").DatabaseSync;
  return new DatabaseSync(file);
}
