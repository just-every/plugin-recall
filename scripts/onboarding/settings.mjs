// What setup writes into <dataDir>/config.json: the daily spend cap and the installed homes that the default homes do not cover (so the
// index reads them). The file is merged, never replaced: every other key stays. Read and validated by config.mjs as before.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILE_NAME } from "../lib/config.mjs";
import { homeKind, resolveHome } from "../lib/home-paths.mjs";
import { tildePath } from "./ui.mjs";

export const DEFAULT_DAILY_CAP_USD = 1;

/** The raw config.json object ({} when there is none). loadConfig has validated it already. */
export function readSettings(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, CONFIG_FILE_NAME), "utf8")); } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

/**
 * The merged settings: dailyCapUsd set when absent (default 1) or when --daily-cap differs, and each installed home other than ~/.claude and
 * ~/.codex added to `homes` (as ~/... under the home folder), unless a roster decides the homes.
 * @param {{current: object, capFlag?: number|null, homes: {home: string, host: "claude"|"codex"}[], homeDir?: string, roster?: boolean}} o
 * @returns {{next: object, changed: boolean, cap: {old: number|null, now: number}}}
 */
export function mergeSettings({ current, capFlag = null, homes, homeDir = os.homedir(), roster = Boolean(current.homesRoster) }) {
  const next = { ...current };
  const old = Object.hasOwn(current, "dailyCapUsd") ? current.dailyCapUsd : null;
  if (old === null) next.dailyCapUsd = capFlag ?? DEFAULT_DAILY_CAP_USD;
  else if (capFlag !== null && capFlag !== old) next.dailyCapUsd = capFlag;
  if (!roster) {
    const list = [...(current.homes ?? [])];
    const have = new Set(list.map((h) => resolveHome(typeof h === "string" ? h : h.path, homeDir)));
    const standard = new Set([path.join(homeDir, ".claude"), path.join(homeDir, ".codex")].map((p) => path.resolve(p)));
    for (const { home, host } of homes) {
      const abs = path.resolve(home);
      // a `homes` entry's kind is read from its folder name; a home whose name says another kind is read through its host's variable instead
      if (standard.has(abs) || have.has(abs) || homeKind(abs) !== host) continue;
      have.add(abs);
      list.push(tildePath(abs, homeDir));
    }
    if (list.length !== (current.homes ?? []).length) next.homes = list;
  }
  return { next, changed: JSON.stringify(next) !== JSON.stringify(current), cap: { old, now: next.dailyCapUsd } };
}

/** The configuration a run uses before (or without) writing: the merged homes and cap over what loadConfig read. */
export function withSettings(config, next) {
  return Object.freeze({
    ...config,
    homes: config.sources.homes === "env" ? config.homes : Object.freeze([...(next.homes ?? config.homes)]),
    dailyCapUsd: config.sources.dailyCapUsd === "env" ? config.dailyCapUsd : next.dailyCapUsd,
  });
}

export function writeSettings(dataDir, next) {
  const file = path.join(dataDir, CONFIG_FILE_NAME);
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}
