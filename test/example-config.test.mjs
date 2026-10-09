// docs/examples/fleet-config.json shows every option a multi-account setup uses (homesRoster, usageCmd, ownerNames, ownerEmails,
// filterProfiles, homes with {path, kind} entries) with placeholders only: paths under ~/, addresses at the reserved example domains.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../scripts/lib/config.mjs";
import { indexOnlyHomes } from "../scripts/lib/homes.mjs";
import { tmpDir } from "./helpers.mjs";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "examples", "fleet-config.json");

test("the example config demonstrates each multi-account key and loads as a config.json", () => {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  for (const key of ["homesRoster", "usageCmd", "ownerNames", "ownerEmails", "filterProfiles", "homes"]) assert.ok(key in raw, key);
  assert.ok(raw.homes.length >= 2 && raw.homes.every((h) => typeof h.path === "string" && ["claude", "codex", "code"].includes(h.kind)), "homes are {path, kind} entries");
  assert.ok(new Set(raw.homes.map((h) => h.kind)).size === 3, "one of each kind");
  const dir = tmpDir("recall-example-config");
  fs.copyFileSync(FILE, path.join(dir, "config.json"));
  const c = loadConfig({ RECALL_DATA: dir });
  assert.equal(indexOnlyHomes(c, { homeDir: dir }).length, 0, "placeholder paths: none exists here");
});

test("the example config holds placeholders only", () => {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const paths = [raw.homesRoster, raw.usageCmd.replace(/^node /, ""), ...raw.homes.map((h) => h.path)];
  for (const p of paths) assert.match(p, /^~\//, p);
  for (const e of raw.ownerEmails) assert.match(e, /@example\.(?:com|org)$/, e);
});
