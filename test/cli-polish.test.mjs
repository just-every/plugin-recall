// The command line itself: the help (what `npx -y @just-every/plugin-recall --help` prints), the full list, the version, the setup aliases
// (`recall`, `recall -y`, `recall install`), and usage errors that exit 2 with one line on stderr.
import test from "node:test";
import assert from "node:assert/strict";
import { nodeOk, shortVersion } from "../scripts/onboarding/detect.mjs";
import { fakeClis } from "./fake-cli.mjs";
import { KEY, recall, sandboxHome } from "./sandbox.mjs";

const V = "0.5.1";

test("--help (alone, after setup's options, or `recall help`) prints the setup help itself, every hint in the npx form; help --all the full list", async () => {
  const home = sandboxHome();
  for (const args of [["--help"], ["-h"], ["help"], ["setup", "--help"], ["--yes", "--help"], ["--help", "--yes"]]) {
    const r = await recall(args, { home });
    assert.equal(r.code, 0, args.join(" "));
    assert.ok(r.stdout.startsWith(`Recall ${V} · memory for Claude Code and Codex\n\nnpx -y @just-every/plugin-recall [options]\n`), r.stdout);
    for (const f of ["--yes, -y", "--homes <list>", "--exclude <list>", "--new-key", "--no-index", "--skip-key", "--no-save-key", "--daily-cap <usd>", "--dry-run", "--help, -h"]) {
      assert.match(r.stdout, new RegExp(`^ {2}${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `, "m"), f);
    }
    assert.ok(r.stdout.includes("\nOther commands: npx -y @just-every/plugin-recall <command>\n  doctor              check that everything works\n"), r.stdout);
    assert.ok(!/recall setup|recall help/.test(r.stdout), "no hint needs recall on PATH");
    for (const l of r.stdout.split("\n")) assert.ok(l.length <= 100, `longer than 100: ${l}`);
  }
  const all = await recall(["help", "--all"], { home });
  assert.equal(all.code, 0);
  for (const cmd of ["setup", "uninstall", "doctor", "index", "enrich", "query", "show", "spend", "logs", "monitor"]) assert.match(all.stdout, new RegExp(`^ {2}recall ${cmd}\\b`, "m"), cmd);
  for (const l of all.stdout.split("\n")) assert.ok(l.length <= 100, `longer than 100: ${l}`);
  assert.ok(!/Developer|recall eval|recall pipelines|--durable|--corpus|--pipeline/.test(all.stdout), "the developer commands are not in the published help");
  const dev = await recall(["help", "--all"], { home, env: { RECALL_DEVELOPER: "1" } });
  const [everyday, developer] = dev.stdout.split("\nDeveloper commands (evaluation and research):\n");
  assert.equal(everyday.trimEnd(), all.stdout.trimEnd());
  for (const cmd of ["eval", "pipelines"]) assert.ok(developer.includes(`  recall ${cmd}`), cmd);
  assert.ok(developer.includes("--durable") && developer.includes("--pipeline"));
});

test("--version and -v print only the version", async () => {
  for (const flag of ["--version", "-v"]) {
    const r = await recall([flag], { home: sandboxHome() });
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, `${V}\n`, ""]);
  }
});

test("uninstall --help prints one line per flag, in the npx form", async () => {
  const un = await recall(["uninstall", "-h"], { home: sandboxHome() });
  assert.ok(un.stdout.startsWith("npx -y @just-every/plugin-recall uninstall [options]"), un.stdout);
  assert.match(un.stdout, /^ {2}--purge {10}also delete ~\/\.plugin-recall/m);
  assert.match(un.stdout, /^ {2}--homes <list> {3}remove Recall only from these homes/m);
});

test("pause --help and resume --help say what they do, in the npx form; `help` lists both", async () => {
  const pause = await recall(["pause", "--help"], { home: sandboxHome() });
  assert.ok(pause.stdout.startsWith("npx -y @just-every/plugin-recall pause") && pause.stdout.includes("npx -y @just-every/plugin-recall resume"), pause.stdout);
  const resume = await recall(["resume", "-h"], { home: sandboxHome() });
  assert.ok(resume.stdout.startsWith("npx -y @just-every/plugin-recall resume"), resume.stdout);
  const help = await recall(["--help"], { home: sandboxHome() });
  assert.match(help.stdout, /^ {2}pause {15}stop Recall at once/m);
  assert.match(help.stdout, /^ {2}resume {14}turn Recall back on/m);
});

test("`recall -y`, `recall install` and `recall --dry-run` are setup", async () => {
  const home = sandboxHome();
  const clis = fakeClis();
  for (const args of [["-y", "--dry-run"], ["install", "--dry-run"], ["--dry-run"]]) {
    const r = await recall(args, { home, clis, env: { OPENAI_API_KEY: KEY } });
    assert.equal(r.code, 0, `${args.join(" ")}\n${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.startsWith(`Recall ${V} · memory for Claude Code and Codex\n\nLooking at this machine\n`));
    assert.ok(r.stdout.endsWith("Dry run: nothing was changed.\n"));
  }
});

test("usage errors exit 2 with one line: an unknown command, an unknown option, a missing or bad value, a stray argument", async () => {
  const home = sandboxHome();
  const cases = [
    [["frobnicate"], 'recall: unknown command "frobnicate". Run: npx -y @just-every/plugin-recall --help\n'],
    [["--frobnicate"], "recall setup: unknown option --frobnicate (see: npx -y @just-every/plugin-recall --help)\n"],
    [["setup", "--source", "x"], "recall setup: unknown option --source (see: npx -y @just-every/plugin-recall --help)\n"],
    [["install", "--frobnicate"], "recall setup: unknown option --frobnicate (see: npx -y @just-every/plugin-recall --help)\n"],
    [["uninstall", "--exclude", "x"], "recall uninstall: unknown option --exclude (see: npx -y @just-every/plugin-recall uninstall --help)\n"],
    [["uninstall", "--homes", "x"], "recall uninstall: --homes: x is not a home Recall is installed in\n"],
    [["uninstall", "--homes", "~/.claude", "--purge"], "recall uninstall: --purge removes Recall everywhere; it does not go with --homes\n"],
    [["pause", "--yes"], "recall pause: unknown option --yes (see: npx -y @just-every/plugin-recall pause --help)\n"],
    [["resume", "now"], 'recall resume: unexpected argument "now"\n'],
    [["setup", "--daily-cap"], "recall setup: --daily-cap needs a value\n"],
    [["setup", "--daily-cap", "lots"], 'recall setup: --daily-cap must be a positive number of dollars, got "lots"\n'],
    [["setup", "extra"], 'recall setup: unexpected argument "extra"\n'],
    [["--new-key", "--skip-key"], "recall setup: --new-key saves the key you paste to ~/.env; it does not go with --skip-key\n"],
    [["--new-key", "--no-save-key"], "recall setup: --new-key saves the key you paste to ~/.env; it does not go with --no-save-key\n"],
    [["doctor", "--frobnicate"], "recall doctor: unknown option --frobnicate (see: npx -y @just-every/plugin-recall --help)\n"],
  ];
  for (const [args, stderr] of cases) {
    const r = await recall(args, { home });
    assert.deepEqual([r.code, r.stderr], [2, stderr], args.join(" "));
    assert.ok(!/\n\s+at /.test(r.stderr), "no stack trace");
  }
});

test("Node 22.15 or newer is required; a CLI's version is its first x.y.z", () => {
  for (const v of ["v22.15.0", "v22.20.1", "v23.0.0", "v26.0.0"]) assert.ok(nodeOk(v), v);
  for (const v of ["v22.14.9", "v20.18.0", "v18.0.0"]) assert.ok(!nodeOk(v), v);
  assert.equal(shortVersion("2.1.287 (Claude Code)"), "2.1.287");
  assert.equal(shortVersion("codex-cli 0.160.1"), "0.160.1");
  assert.equal(shortVersion("dev build"), "dev build");
});
