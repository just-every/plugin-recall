// Setup's records in <dataDir>/state: installs.json (which homes Recall was installed into or left out of, and at which version),
// provider-checks.json (when a key was accepted and when its access to a paid endpoint was proven, by key fingerprint, never the key) and
// key-choices.json (a provider whose key the person chose, with --no-save-key, to keep out of ~/.env; never the key).
import fs from "node:fs";
import path from "node:path";

const installsFile = (dataDir) => path.join(dataDir, "state", "installs.json");
const checksFile = (dataDir) => path.join(dataDir, "state", "provider-checks.json");
const choicesFile = (dataDir) => path.join(dataDir, "state", "key-choices.json");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${file} cannot be read (${e.message}); remove it and run setup again`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * @returns {{version: 1, homes: {home: string, host: "claude"|"codex", status: "installed"|"left-out", recallVersion: string, at: string}[],
 *   createdDirs?: string[]} | null} createdDirs: the folders setup made for the recall command (~/.local/bin, ~/.local), deepest first, which
 *   uninstall removes again when they are empty
 */
export function readInstalls(dataDir) {
  const r = readJson(installsFile(dataDir));
  return r && Array.isArray(r.homes) ? r : null;
}

/** Record what this run did; `entries` replace the entries of the same home, every other home keeps its entry. */
export function writeInstalls(dataDir, entries, { createdDirs = [] } = {}) {
  const before = readInstalls(dataDir);
  const homes = (before?.homes ?? []).filter((h) => !entries.some((e) => path.resolve(e.home) === path.resolve(h.home)));
  const made = [...(Array.isArray(before?.createdDirs) ? before.createdDirs : []), ...createdDirs];
  writeJson(installsFile(dataDir), { version: 1, homes: [...homes, ...entries], ...(made.length ? { createdDirs: made } : {}) });
}

/** Forget these homes (their entries), keeping the rest of the record. */
export function dropInstalls(dataDir, homes) {
  const before = readInstalls(dataDir);
  if (!before) return;
  writeJson(installsFile(dataDir), { ...before, homes: before.homes.filter((h) => !homes.some((x) => path.resolve(x) === path.resolve(h.home))) });
}

export function removeInstalls(dataDir) {
  fs.rmSync(installsFile(dataDir), { force: true });
}

/** @returns {Record<string, {keyFingerprint: string, acceptedAt: string, accessConfirmedAt: string}>} */
export const readProviderChecks = (dataDir) => readJson(checksFile(dataDir)) ?? {};

/** When the access of the key with this fingerprint was confirmed, or null. */
export function accessConfirmedAt(dataDir, providerId, fingerprint) {
  const c = readProviderChecks(dataDir)[providerId];
  return c && c.keyFingerprint === fingerprint && c.accessConfirmedAt ? c.accessConfirmedAt : null;
}

/** Has a key of this provider been accepted before (that is, used for sending)? */
export const hasProviderCheck = (dataDir, providerId) => Boolean(readProviderChecks(dataDir)[providerId]);

export function writeProviderCheck(dataDir, providerId, check) {
  writeJson(checksFile(dataDir), { ...readProviderChecks(dataDir), [providerId]: check });
}

/** Did an earlier run record, under --no-save-key, that this provider's key stays out of ~/.env? Nothing else leaves a key out of it. */
export const keyKeptOut = (dataDir, providerId) => readJson(choicesFile(dataDir))?.[providerId]?.keptOutOfEnvFile === true;

/** Record that choice (`out` true), or clear it once the key is saved to ~/.env after all. */
export function recordKeyKeptOut(dataDir, providerId, out, at) {
  const now = readJson(choicesFile(dataDir)) ?? {};
  if (out) now[providerId] = { keptOutOfEnvFile: true, at };
  else if (!now[providerId]) return;
  else delete now[providerId];
  writeJson(choicesFile(dataDir), now);
}
