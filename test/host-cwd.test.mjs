// Host CLI children never run in the person's cwd. Both hosts read the cwd as a project (codex: <cwd>/.codex/config.toml, claude:
// <cwd>/.claude/settings.json), and `npx -y @just-every/plugin-recall` is often run from the home folder, where ~/.codex and ~/.claude are
// exactly that. The stand-in CLIs behave the way the real ones do there (test/fake-cli.cjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { run } from "../scripts/onboarding/hosts/runner.mjs";
import { neutralCwd } from "../scripts/onboarding/hosts/neutral-cwd.mjs";
import { fakeClis } from "./fake-cli.mjs";
import { startFakeServer, tmpDir } from "./helpers.mjs";
import { KEY, recall, sandboxHome, waitForCards } from "./sandbox.mjs";

const real = (p) => fs.realpathSync(p);
const hostCalls = (clis) => clis.log().filter((c) => c.args[0] === "plugin" || c.args[0] === "--version" || c.args[0] === "auth" || c.args[0] === "login");

test("setup and uninstall run from the home folder: every host command runs in an empty temp dir, a stale marketplace is repointed, other homes stay as they were", async () => {
  const server = await startFakeServer();
  const home = sandboxHome({ claude: [".claude", ".claude_other"], codex: [".codex", ".codex_other"] });
  const tmp = tmpDir("recall-tmp"); // the temp folder recall sees, so the test can tell which dir is its own
  const env = { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url, TMPDIR: tmp };
  const clis = fakeClis();
  try {
    // The default homes first: ~/.codex/config.toml now names the marketplace (a project config when the cwd is ~) and so does ~/.claude/settings.json.
    let r = await recall(["--yes", "--homes", "~/.claude,~/.codex"], { home, clis, env, cwd: home });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    await waitForCards(path.join(home, ".plugin-recall"));
    assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /^\[marketplaces\.plugin-recall\]/m);

    // ~/.codex_other still has a marketplace of an earlier copy: the install removes it first, which the real codex refuses when the cwd's
    // .codex/config.toml (here ~/.codex/config.toml) names the marketplace.
    fs.writeFileSync(path.join(home, ".codex_other", "config.toml"), `[marketplaces.plugin-recall]\nsource_type = "local"\nsource = ${JSON.stringify(path.join(home, "earlier-copy"))}\n`);
    r = await recall(["--yes", "--homes", "~/.claude_other,~/.codex_other"], { home, clis, env, cwd: home });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /~\/\.codex_other {3}Codex {8}installed/);
    assert.doesNotMatch(r.stdout + r.stderr, /configured in project/);
    assert.ok(clis.log().some((c) => c.bin === "codex" && c.args.join(" ") === "plugin marketplace remove plugin-recall --json" && c.codexHome === path.join(home, ".codex_other")), "the stale marketplace was removed");
    await waitForCards(path.join(home, ".plugin-recall"));

    const before = { claude: fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"), codex: fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8") };
    r = await recall(["uninstall", "--yes", "--homes", "~/.claude_other,~/.codex_other"], { home, clis, env, cwd: home });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"), before.claude, "uninstalling from ~/.claude_other left ~/.claude alone");
    assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), before.codex);

    const calls = hostCalls(clis);
    assert.ok(calls.length >= 12, `${calls.length} host commands ran`);
    const cwds = new Set(calls.map((c) => c.cwd));
    for (const c of cwds) {
      assert.notEqual(c, real(home), "no host command ran in the home folder");
      assert.equal(path.dirname(c), real(tmp), c);
      assert.match(path.basename(c), /^recall-host-/);
      assert.ok(!fs.existsSync(c), `${c} is removed when recall exits`);
    }
  } finally {
    await server.close();
  }
});

test("a cwd that holds a project .claude or .codex is never the cwd of a host command (doctor too)", async () => {
  const home = sandboxHome({ claude: [".claude"], codex: [".codex"] });
  const project = tmpDir("recall-project");
  fs.mkdirSync(path.join(project, ".codex"));
  fs.mkdirSync(path.join(project, ".claude"));
  const clis = fakeClis();
  const r = await recall(["doctor", "--offline"], { home, clis, cwd: project, env: { OPENAI_API_KEY: "" } });
  assert.match(r.stdout, /claude CLI 2\.1\.287, logged in[\s\S]*codex CLI 0\.160\.1, logged in/, r.stdout + r.stderr); // exit 1: no key, no install; not what this checks
  const calls = hostCalls(clis);
  assert.ok(calls.some((c) => c.args[0] === "--version") && calls.some((c) => c.args[0] === "auth" || c.args[0] === "login"), "doctor probed both CLIs");
  for (const c of calls) assert.notEqual(c.cwd, real(project), `${c.bin} ${c.args.join(" ")}`);
});

test("run() uses the neutral dir by default and honors an explicit cwd", async () => {
  const dir = neutralCwd();
  assert.equal(neutralCwd(), dir, "one per process");
  assert.deepEqual(fs.readdirSync(dir), [], "empty");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const pwd = (o) => run(process.execPath, ["-e", "process.stdout.write(process.cwd())"], o);
  assert.equal((await pwd({})).stdout, dir);
  const other = real(tmpDir("recall-explicit"));
  assert.equal((await pwd({ cwd: other })).stdout, other);
});
