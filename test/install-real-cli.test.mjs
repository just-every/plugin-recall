// Optional: install, re-run and uninstall with the real `claude plugin` and `codex plugin` commands, in a temp HOME with temp homes, to catch
// drift in the hosts' state formats. Every other subcommand (--version, the login probes, the card writers) is the stand-in. Skipped unless both
// CLIs are on PATH. The real CLIs only ever see the temp HOME and its homes, never a real one.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readHomeState } from "../scripts/onboarding/hosts/index.mjs";
import { fakeClis } from "./fake-cli.mjs";
import { startFakeServer } from "./helpers.mjs";
import { KEY, recall, sandboxHome, waitForCards } from "./sandbox.mjs";

const which = (bin) => {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? fs.realpathSync(r.stdout.trim()) : null;
};
const real = { claude: which("claude"), codex: which("codex") };

test("the real host CLIs: install into two homes of each, re-run (up to date), uninstall", { skip: !real.claude || !real.codex ? "claude and codex are not both on PATH" : false, timeout: 240000 }, async () => {
  const server = await startFakeServer();
  const home = sandboxHome({ claude: [".claude", ".claude_work"], codex: [".codex", ".codex_work"] });
  const clis = fakeClis({ real });
  const V = "0.5.2";
  const rows = [[".claude", "claude"], [".claude_work", "claude"], [".codex", "codex"], [".codex_work", "codex"]].map(([n, host]) => ({ host, home: path.join(home, n) }));
  try {
    const first = await recall(["--yes"], { home, clis, env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /Done\. Recall 0\.5\.2 is on in 4 homes\./);
    const M = path.join(home, ".plugin-recall", "marketplace");
    for (const r of rows) {
      const s = readHomeState(r, V);
      assert.ok(s.installed && s.enabled && s.version === V, `${r.home}: ${JSON.stringify(s)}`);
      assert.equal(fs.realpathSync(s.marketplace), fs.realpathSync(M));
    }
    await waitForCards(path.join(home, ".plugin-recall"));

    const again = await recall([], { home, clis, stdin: "", env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /Everything is up to date: Recall 0\.5\.2 in 4 homes\./);

    const gone = await recall(["uninstall", "--yes"], { home, clis });
    assert.equal(gone.code, 0, gone.stdout + gone.stderr);
    for (const r of rows) {
      const s = readHomeState(r, V);
      assert.ok(!s.installed && !s.marketplace, `${r.home}: ${JSON.stringify(s)}`);
      const cache = path.join(r.home, "plugins", "cache", "plugin-recall");
      assert.ok(!fs.existsSync(cache) || gone.stdout.includes(`${cache.replace(home, "~")}: Claude Code deletes its cached copy there itself`), `${cache} is gone or the summary says who clears it`);
    }
    assert.ok(!fs.existsSync(M));
  } finally {
    await server.close();
  }
});
