// The key step and the paid access check of setup, in a sandbox HOME: a key found (the plan says which, and the go-ahead approves it), pasted,
// replaced with --new-key, rejected or unreachable; saving it to ~/.env or not; no Decisions access; a daily cap the first index would pass;
// and end of input. Nothing is written before the go-ahead, and a stop at the access check leaves nothing behind.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakeClis } from "./fake-cli.mjs";
import { startFakeServer } from "./helpers.mjs";
import { closedUrl, decisionsStatusServer, KEY, recall, sandboxHome, waitForCards } from "./sandbox.mjs";

const REJECTED = "OpenAI rejected this key. Check it at https://platform.openai.com/api-keys.";
const SHELL_REJECTED = "The OPENAI_API_KEY in this shell is the key OpenAI rejected, and it wins over ~/.env. Remove it (unset OPENAI_API_KEY and delete it from your shell profile).";
/** The shell line is longer than the wrap width: put it back on one line. */
const unwrap = (s) => s.replace(/ ?\n {4,6}\(unset OPENAI_API_KEY/g, " (unset OPENAI_API_KEY");
const ANOTHER = "To try another key: npx -y @just-every/plugin-recall --new-key";
const untouched = (home) => assert.deepEqual(fs.readdirSync(home).sort(), [".claude", ".codex"], "nothing was written to HOME");

test("a key in ~/.env is reused: found, checked for free, no question about it, not saved again", async () => {
  const server = await startFakeServer({ acceptKey: KEY });
  const home = sandboxHome();
  fs.writeFileSync(path.join(home, ".env"), `export OPENAI_API_KEY="${KEY}"\n`, { mode: 0o600 });
  try {
    const r = await recall([], { home, clis: fakeClis(), stdin: "y\n", env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}Found a key in ~\/\.env \(sk-\.\.\.0001\)\.\n {2}✓ Accepted by OpenAI \(free check, no tokens billed\)\.\n\nPlan\n/);
    assert.match(r.stdout, /\nPlan\n {2}Install Recall 0\.5\.2 in 2 homes: ~\/\.claude, ~\/\.codex\n {2}Use your OpenAI key from ~\/\.env \(sk-\.\.\.0001\)\n/);
    assert.ok(!r.stdout.includes("Save your OpenAI key") && !r.stdout.includes("[Y/n] \n  "), "the go-ahead is the only question");
    assert.equal((r.stdout.match(/\[Y\/n/g) ?? []).length, 1, r.stdout);
    assert.equal(fs.readFileSync(path.join(home, ".env"), "utf8"), `export OPENAI_API_KEY="${KEY}"\n`);
    assert.ok(!r.stdout.includes(KEY));
    await waitForCards(path.join(home, ".plugin-recall"));
  } finally {
    await server.close();
  }
});

test("a pasted key (piped, as a script would) is checked, and the plan the go-ahead approves saves it; with --yes the paste is the only line", async () => {
  const server = await startFakeServer({ acceptKey: KEY });
  try {
    const home = sandboxHome();
    const r = await recall([], { home, clis: fakeClis(), stdin: `${KEY}\ny\n`, env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}No key found in the environment or in ~\/\.env\.\n {2}Get one at https:\/\/platform\.openai\.com\/api-keys \(needs a key with Decisions API access\)\n {2}Paste your OpenAI API key \(hidden, Enter to stop\): \n {2}✓ Accepted by OpenAI \(free check, no tokens billed\)\.\n\nPlan\n/);
    assert.match(r.stdout, /\n {2}Save your OpenAI key to ~\/\.env\n/);
    assert.match(r.stdout, /\n {2}✓ Saved your OpenAI key to ~\/\.env\n/);
    assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
    assert.equal(fs.readFileSync(path.join(home, ".env"), "utf8"), `OPENAI_API_KEY=${KEY}\n`);
    await waitForCards(path.join(home, ".plugin-recall"));
    const scripted = sandboxHome();
    const y = await recall(["--yes"], { home: scripted, clis: fakeClis(), stdin: `${KEY}\n`, env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(y.code, 0, y.stdout + y.stderr);
    assert.match(y.stdout, /Go ahead\? \[--yes\] yes\n/);
    assert.equal(fs.readFileSync(path.join(scripted, ".env"), "utf8"), `OPENAI_API_KEY=${KEY}\n`);
    await waitForCards(path.join(scripted, ".plugin-recall"));
  } finally {
    await server.close();
  }
});

test("a rejected, misshapen or empty key, and an unreachable API, stop before anything is written", async () => {
  const server = await startFakeServer({ acceptKey: "sk-the-only-right-key" });
  try {
    let home = sandboxHome();
    let r = await recall([], { home, clis: fakeClis(), env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 1);
    assert.ok(unwrap(r.stdout).endsWith(`  ✗ ${REJECTED}\n${SHELL_REJECTED}\nNothing was changed.\n`), r.stdout);
    assert.ok(!r.stdout.includes("HTTP") && !r.stdout.includes("--new-key"), "no code, and no hint to paste a key that the shell would override");
    untouched(home);
    fs.writeFileSync(path.join(home, ".env"), `OPENAI_API_KEY=${KEY}\n`);
    r = await recall([], { home, clis: fakeClis(), env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 1);
    assert.ok(r.stdout.endsWith(`  ✗ ${REJECTED}\nNothing was changed.\n${ANOTHER}\n`), r.stdout);
    fs.rmSync(path.join(home, ".env"));
    r = await recall([], { home, clis: fakeClis(), stdin: `${KEY}\n`, env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 1);
    assert.ok(r.stdout.endsWith(`(hidden, Enter to stop): \n  ✗ ${REJECTED}\nNothing was changed.\n${ANOTHER}\n`), r.stdout);
    r = await recall([], { home, clis: fakeClis(), stdin: "hello there\n", env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 1);
    assert.ok(r.stdout.endsWith("  That does not look like an OpenAI key (they start with sk-).\nNothing was changed.\n"), r.stdout);
    assert.ok(!r.stdout.includes("--new-key"), "a key that was never rejected gets no --new-key hint");
    r = await recall([], { home, clis: fakeClis(), stdin: "sk-abc\n", env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 1);
    assert.ok(r.stdout.endsWith("  That does not look like a full OpenAI key (it starts with sk- and is much longer).\nNothing was changed.\n"), r.stdout);
    r = await recall([], { home, clis: fakeClis(), stdin: "\n", env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.endsWith("(hidden, Enter to stop): \nStopped. Nothing was changed.\n"), r.stdout);
    const gone = await closedUrl();
    r = await recall([], { home, clis: fakeClis(), env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: gone } });
    assert.equal(r.code, 1);
    assert.ok(r.stdout.endsWith(`  ✗ Could not reach ${gone} (ECONNREFUSED).\nCheck your connection and run this again.\nNothing was changed.\n`), r.stdout);
    untouched(home);
    assert.equal(server.calls.length, 0, "nothing billable was sent");
  } finally {
    await server.close();
  }
});

test("saving the key: a key that replaces another in ~/.env is shown in the plan; --no-save-key leaves ~/.env alone", async () => {
  const server = await startFakeServer();
  try {
    let home = sandboxHome();
    fs.writeFileSync(path.join(home, ".env"), "# my tools\nOPENAI_API_KEY=sk-an-older-key-9999\n");
    fs.chmodSync(path.join(home, ".env"), 0o644);
    let r = await recall([], { home, clis: fakeClis(), stdin: "y\n", env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}! ~\/\.env can be read by other users on this machine; run: chmod 600 ~\/\.env\n/);
    assert.match(r.stdout, /\n {2}Save your OpenAI key to ~\/\.env \(it replaces the key there\)\n/);
    assert.equal(fs.readFileSync(path.join(home, ".env"), "utf8"), `# my tools\nOPENAI_API_KEY=${KEY}\n`);
    assert.equal(fs.statSync(path.join(home, ".env")).mode & 0o777, 0o644, "the file keeps its mode");
    await waitForCards(path.join(home, ".plugin-recall"));

    home = sandboxHome();
    r = await recall(["--no-save-key"], { home, clis: fakeClis(), stdin: "y\n", env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}! Not saved \(--no-save-key\): desktop apps do not pass your shell environment to hooks,\n {4}so Recall works only where OPENAI_API_KEY is set\.\n/);
    assert.ok(!r.stdout.includes("Save your OpenAI key") && !fs.existsSync(path.join(home, ".env")));
    await waitForCards(path.join(home, ".plugin-recall"));
    // a later run keeps leaving it out, and says so, without a question
    r = await recall([], { home, clis: fakeClis(), env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}! Not in ~\/\.env: desktop apps do not pass your shell environment to hooks,\n/);
    assert.match(r.stdout, /\n\nEverything is up to date: Recall 0\.5\.2 in 2 homes\.\n/);
    assert.ok(!fs.existsSync(path.join(home, ".env")));

    // with no key in the environment, --no-save-key cannot work: it stops before asking for one
    home = sandboxHome();
    r = await recall(["--no-save-key"], { home, clis: fakeClis(), stdin: `${KEY}\ny\n`, env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 1);
    assert.ok(r.stdout.endsWith("  Get one at https://platform.openai.com/api-keys (needs a key with Decisions API access)\nWith --no-save-key, Recall's hooks read the key only from their app's environment.\n"
      + "Set OPENAI_API_KEY there, or run this again without --no-save-key.\nNothing was changed.\n"), r.stdout);
    untouched(home);
  } finally {
    await server.close();
  }
});

test("no Decisions API access: one request, then stop; nothing is installed or saved", async () => {
  for (const [status, tail] of [[403, "  ✗ Decisions API: your key has no access.\nRecall needs a key with Decisions API access, to pick what to bring back.\n"
    + "Access is per OpenAI organisation: use a key from one that has it, or ask OpenAI to enable it.\nThen run this again.\nNothing was installed.\n"],
    [500, "  ✗ The check that your key can pick what to bring back failed (HTTP 500).\nRun this again in a minute.\nNothing was installed.\n"]]) {
    const server = await decisionsStatusServer(status);
    const home = sandboxHome();
    const clis = fakeClis();
    try {
      const r = await recall(["--yes"], { home, clis, env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
      assert.equal(r.code, 1, r.stdout);
      assert.ok(r.stdout.endsWith(`Go ahead? [--yes] yes\n${tail}`), r.stdout);
      assert.deepEqual(server.posts, status === 403 ? ["/v1/decisions"] : ["/v1/decisions", "/v1/decisions", "/v1/decisions"], "a 500 is retried twice, a 403 never");
      assert.ok(!fs.existsSync(path.join(home, ".env")) && !fs.existsSync(path.join(home, ".local")), "no key saved, no command added");
      assert.ok(!fs.existsSync(path.join(home, ".plugin-recall")), "the folders the check made (inflight, locks) are gone again");
      assert.equal(clis.log().filter((c) => c.args[0] === "plugin").length, 0);
      // a data dir that was there already keeps what it had, and only that
      fs.mkdirSync(path.join(home, ".plugin-recall", "logs"), { recursive: true });
      fs.writeFileSync(path.join(home, ".plugin-recall", "config.json"), "{}\n");
      const again = await recall(["--yes"], { home, clis, env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
      assert.equal(again.code, 1, again.stdout);
      assert.deepEqual(fs.readdirSync(path.join(home, ".plugin-recall")).sort(), ["config.json", "logs"]);
    } finally {
      await server.close();
    }
  }
});

test("a first index that would pass the daily cap is refused before anything is written or paid for", async () => {
  const server = await startFakeServer();
  const home = sandboxHome();
  try {
    const r = await recall(["--yes", "--daily-cap", "0.0000001"], { home, clis: fakeClis(), env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 1);
    assert.ok(r.stdout.endsWith("\n\nThe first index (less than $0.0001) costs more than the daily cap of $0.0000001.\nRun this again with --daily-cap 0.01.\nNothing was changed.\n"), r.stdout);
    untouched(home);
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});

test("end of input is never a yes: at the go-ahead it says to add --yes; with no key at all it says how to give one", async () => {
  const server = await startFakeServer();
  const home = sandboxHome();
  const EOF_KEY = "No OpenAI key: none in the environment or in ~/.env, and none on stdin.\n"
    + "Set OPENAI_API_KEY, or pipe it in: printf '%s\\n' \"$KEY\" | npx -y @just-every/plugin-recall --yes\nNothing was changed.\n";
  try {
    const r = await recall([], { home, clis: fakeClis(), stdin: "", env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 1);
    assert.ok(r.stdout.endsWith("Go ahead? [Y/n, or numbers to leave homes out] \nNo answer on stdin, so nothing was changed. To run without questions, add --yes.\n"), r.stdout);
    for (const args of [["--yes"], []]) {
      const keyless = await recall(args, { home, clis: fakeClis(), stdin: "", env: { RECALL_OPENAI_BASE_URL: server.url } });
      assert.equal(keyless.code, 1);
      assert.ok(keyless.stdout.endsWith(`  Paste your OpenAI API key (hidden, Enter to stop): \n${EOF_KEY}`), keyless.stdout);
      assert.ok(!keyless.stdout.includes("add --yes"));
    }
    untouched(home);
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});

test("a found key is part of the plan; declining it stops without a hint about another key", async () => {
  const server = await startFakeServer();
  const home = sandboxHome();
  try {
    const r = await recall([], { home, clis: fakeClis(), stdin: "n\n", env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}Use your OpenAI key from the environment \(sk-\.\.\.0001\)\n {2}Save your OpenAI key to ~\/\.env\n/);
    assert.equal((r.stdout.match(/\[Y\/n/g) ?? []).length, 1, "one question");
    assert.ok(r.stdout.endsWith("Go ahead? [Y/n, or numbers to leave homes out] \nStopped. Nothing was changed.\n"), r.stdout);
    untouched(home);
  } finally {
    await server.close();
  }
});

test("--new-key: the hidden paste replaces the key in ~/.env in place (other lines and the mode kept), checked and proven before it is saved", async () => {
  const OLD = "sk-test-sandbox-key-0001";
  const NEW = "sk-test-sandbox-key-0002";
  const server = await startFakeServer();
  try {
    const home = sandboxHome();
    fs.writeFileSync(path.join(home, ".env"), `# mine\nexport OPENAI_API_KEY=${OLD}\nOTHER=1\n`);
    fs.chmodSync(path.join(home, ".env"), 0o640);
    let r = await recall(["--yes"], { home, clis: fakeClis(), env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    await waitForCards(path.join(home, ".plugin-recall"));
    const gets = server.gets.length;
    r = await recall(["--new-key"], { home, clis: fakeClis(), stdin: `${NEW}\ny\n`, env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}Found a key in ~\/\.env \(sk-\.\.\.0001\); --new-key asks for the one to use instead\.\n {2}Get one at https:\/\/platform\.openai\.com\/api-keys \(needs a key with Decisions API access\)\n {2}Paste your new OpenAI API key \(hidden, Enter to stop\): \n {2}✓ Accepted by OpenAI/);
    assert.match(r.stdout, /\nPlan\n {2}Save your OpenAI key to ~\/\.env \(it replaces the key there\)\n {2}Check once that your key can pick what to bring back: /);
    assert.ok(!r.stdout.includes("Use your OpenAI key"), "a pasted key is not a found one");
    assert.equal((r.stdout.match(/\[Y\/n/g) ?? []).length, 1, "the paste and the go-ahead: one yes/no question");
    assert.equal(fs.readFileSync(path.join(home, ".env"), "utf8"), `# mine\nexport OPENAI_API_KEY=${NEW}\nOTHER=1\n`);
    assert.equal(fs.statSync(path.join(home, ".env")).mode & 0o777, 0o640, "the file keeps its mode");
    assert.deepEqual(server.gets.slice(gets).map((g) => g.authorization), [`Bearer ${NEW}`], "only the new key is checked");
    assert.equal(server.calls.filter((c) => c.pathname === "/v1/decisions").length, 2, "the new key's access is proven too");
    assert.ok(!r.stdout.includes(NEW) && !r.stdout.includes(OLD));

    // with the old key still exported, the paste works and setup says which one wins where
    r = await recall(["--new-key", "--dry-run"], { home, clis: fakeClis(), env: { OPENAI_API_KEY: OLD, RECALL_OPENAI_BASE_URL: server.url } });
    assert.match(r.stdout, /\n {2}· Not asked \(--dry-run\); a real run asks for the new key here\.\n/);
    r = await recall(["--new-key"], { home, clis: fakeClis(), stdin: `${NEW}\nn\n`, env: { OPENAI_API_KEY: OLD, RECALL_OPENAI_BASE_URL: server.url } });
    assert.match(r.stdout, /\n {2}! OPENAI_API_KEY is also set in this shell: where it is set, it wins over ~\/\.env\.\n/);
    r = await recall(["--new-key", "--yes"], { home, clis: fakeClis(), stdin: "", env: { RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 1);
    assert.ok(r.stdout.endsWith("No new OpenAI key on stdin.\nPipe it in: printf '%s\\n' \"$KEY\" | npx -y @just-every/plugin-recall --new-key --yes\nNothing was changed.\n"), r.stdout);
  } finally {
    await server.close();
  }
});

test("--no-save-key is recorded: only that record keeps a later run from saving an environment key; --new-key saves one and clears it", async () => {
  const server = await startFakeServer();
  try {
    const home = sandboxHome();
    let r = await recall(["--yes", "--no-save-key"], { home, clis: fakeClis(), env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}Keep your OpenAI key out of ~\/\.env, now and on later runs \(--no-save-key\)\n/);
    const choices = path.join(home, ".plugin-recall", "state", "key-choices.json");
    assert.equal(JSON.parse(fs.readFileSync(choices, "utf8")).openai.keptOutOfEnvFile, true);
    assert.ok(!fs.readFileSync(choices, "utf8").includes(KEY));
    await waitForCards(path.join(home, ".plugin-recall"));
    r = await recall([], { home, clis: fakeClis(), stdin: "", env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("\n    To save it there: npx -y @just-every/plugin-recall --new-key\n") && r.stdout.includes("Everything is up to date"), r.stdout);
    r = await recall(["--new-key", "--yes"], { home, clis: fakeClis(), stdin: `${KEY}\n`, env: { OPENAI_API_KEY: KEY, RECALL_OPENAI_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\n {2}Save your OpenAI key to ~\/\.env\n/);
    assert.equal(fs.readFileSync(path.join(home, ".env"), "utf8"), `OPENAI_API_KEY=${KEY}\n`);
    assert.deepEqual(JSON.parse(fs.readFileSync(choices, "utf8")), {}, "saving the key clears the record");
  } finally {
    await server.close();
  }
});
