// Path helpers for agent homes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** An absolute path from a home path as written in a config (`~`, `~/x`, absolute, or relative to the cwd). */
export const resolveHome = (value, homeDir = os.homedir()) => {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("a home path is required");
  if (text === "~") return path.resolve(homeDir);
  return path.resolve(text.startsWith("~/") ? path.join(homeDir, text.slice(2)) : text);
};

/** claude | codex | code, from the directory name (.claude*, .codex*, .code*). */
export function homeKind(dir) {
  const base = path.basename(dir);
  if (/^\.codex($|[_-])/.test(base)) return "codex";
  if (/^\.code($|[_-])/.test(base)) return "code";
  return "claude";
}

export const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
