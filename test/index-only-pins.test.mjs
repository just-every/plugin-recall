// A home that config `homes` lists as {path, kind} is read for indexing only, and no CLI worker is ever placed there: not when it is pinned
// (RECALL_CLAUDE_HOME / RECALL_CODEX_HOME, claudeHome / codexHome), with or without a roster or a usage command, and not when the same folder
// is also one of the standard homes. Synthetic homes under a temp HOME; usage is a stand-in; no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { createRouter } from "../scripts/lib/router.mjs";
import { tmpDir } from "./helpers.mjs";

function world() {
  const root = tmpDir("recall-index-only-pins");
  const homes = { claude: path.join(root, ".claude"), spare: path.join(root, ".claude_spare"), codex: path.join(root, ".codex"), backup: path.join(root, ".codex_backup") };
  for (const dir of Object.values(homes)) fs.mkdirSync(dir, { recursive: true });
  const entries = [{ path: homes.spare, kind: "claude" }, { path: homes.backup, kind: "codex" }];
  // every home has headroom, the index-only ones the most: only the rule keeps them out
  const usage = { results: Object.values(homes).map((p) => ({ path: p, windows: [{ label: "1w", usedPercent: p.includes("_") ? 1 : 40, elapsedPercent: 50 }] })) };
  const roster = path.join(root, "roster.json");
  fs.writeFileSync(roster, JSON.stringify([
    { id: "main", kind: "claude", home: homes.claude, protected: false, manual: false },
    { id: "spare", kind: "claude", home: homes.spare, protected: false, manual: false },
    { id: "codex", kind: "codex", home: homes.codex, protected: false, manual: false },
    { id: "backup", kind: "codex", home: homes.backup, protected: false, manual: false },
  ]));
  const router = (env) => createRouter({ config: loadConfig({ RECALL_DATA: tmpDir("recall-pins-data"), RECALL_HOMES: JSON.stringify(entries), ...env }), homeDir: root, env: {}, run: async () => usage, hasCli: () => true });
  return { root, homes, roster, router };
}

test("a pin on an index-only home is refused, with or without a roster or a usage command", async () => {
  const w = world();
  const combos = {
    "pin only": {},
    "pin + usageCmd": { RECALL_USAGE_CMD: "my-usage" },
    "pin + roster": { RECALL_HOMES_ROSTER: w.roster },
    "pin + roster + usageCmd": { RECALL_HOMES_ROSTER: w.roster, RECALL_USAGE_CMD: "my-usage" },
  };
  for (const [name, env] of Object.entries(combos)) {
    const claude = await w.router({ ...env, RECALL_CLAUDE_HOME: w.homes.spare }).pick("claude");
    assert.equal(claude.home, null, `${name}: claude`);
    assert.match(claude.reason, /read for indexing only/, name);
    const codex = await w.router({ ...env, RECALL_CODEX_HOME: w.homes.backup }).pick("codex");
    assert.equal(codex.home, null, `${name}: codex`);
    assert.match(codex.reason, /read for indexing only/, name);
  }
});

test("a pin on a worker home still works next to index-only homes; unpinned routing never offers an index-only home either", async () => {
  const w = world();
  assert.equal((await w.router({ RECALL_CLAUDE_HOME: w.homes.claude }).pick("claude")).home, w.homes.claude);
  assert.equal((await w.router({ RECALL_HOMES_ROSTER: w.roster, RECALL_CLAUDE_HOME: w.homes.claude }).pick("claude")).home, w.homes.claude);
  const byRoster = await w.router({ RECALL_HOMES_ROSTER: w.roster }).pick("claude");
  assert.equal(byRoster.home, w.homes.claude, "the roster offers the spare home with more headroom, but it is index-only");
  assert.ok(byRoster.considered.some((c) => c.home === w.homes.spare && c.ok === false && /index-only/.test(c.reason)));
  assert.equal((await w.router({ RECALL_HOMES_ROSTER: w.roster }).pick("codex")).home, w.homes.codex);
});

test("a standard home that config homes also lists as {path, kind} is index-only: the default router does not place a worker there", async () => {
  const w = world();
  const config = loadConfig({ RECALL_DATA: tmpDir("recall-pins-data"), RECALL_HOMES: JSON.stringify([{ path: w.homes.claude, kind: "claude" }]) });
  const r = createRouter({ config, homeDir: w.root, env: {}, hasCli: () => true });
  const claude = await r.pick("claude");
  assert.equal(claude.home, null);
  assert.match(claude.reason, /read for indexing only/);
  assert.equal((await r.pick("codex")).home, w.homes.codex);
  const byUsage = createRouter({ config: { ...config, usageCmd: "my-usage" }, homeDir: w.root, env: {}, run: async () => ({ results: [{ path: w.homes.claude, windows: [{ label: "1w", usedPercent: 1 }] }] }), hasCli: () => true });
  assert.equal((await byUsage.pick("claude")).home, null);
});
