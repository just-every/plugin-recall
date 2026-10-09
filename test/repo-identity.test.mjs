// Repo identity: the structural rule for a session whose directory is gone, the order of the three sources, aliases, the indexer filing new
// statements under it, and the repair of statements indexed before. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { canonicalRepo, repoOfGitUrl, repoOfSession, sameRepo, structuralRepo } from "../scripts/lib/repo-identity.mjs";
import { repairStatementRepos } from "../scripts/lib/repo-repair.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { claudeUser, codexUser } from "./transcript-builders.mjs";
import { fakeOpenAI, tmpDir } from "./helpers.mjs";

const HOME = "/home/someone";

test("structuralRepo: worktree layouts, projects under an org, projects under the home; nothing else is guessed", () => {
  const s = (cwd) => structuralRepo(cwd, HOME);
  assert.equal(s(`${HOME}/.codex/worktrees/9f5d/web-app`), "web-app", "Codex worktree: the directory after the worktree id");
  assert.equal(s(`${HOME}/.codex_alt/worktrees/b15b/web-app/src/deep`), "web-app");
  assert.equal(s(`${HOME}/www/acme/widgets`), "widgets", "~/www/<org>/<repo>");
  assert.equal(s(`${HOME}/www/acme/widgets/packages/a`), "widgets", "below the repo");
  assert.equal(s(`${HOME}/www/acme/seeds/intercom`), "seeds", "the repo, not the directory inside it");
  assert.equal(s(`${HOME}/www/solo`), "solo", "~/www/<repo>");
  assert.equal(s(`${HOME}/halloween`), "halloween", "a project directly under the home");
  assert.equal(s(`${HOME}/www/acme/widgets/.claude/worktrees/fix-1`), "widgets", "Claude worktree: the repo above .claude");
  assert.equal(s(`${HOME}/www/acme/widgets/.worktrees/fix-1`), "widgets");
  assert.equal(s(`${HOME}/www/acme/widgets-worktrees/fix-1`), "widgets", "a sibling worktrees directory: the repo it belongs to");
  for (const none of [HOME, `${HOME}/www`, `${HOME}/Documents/notes`, `${HOME}/.claude/skills/x`, `${HOME}/Library/Caches`, "/private/tmp/x/repo", "/opt/thing", "relative/path", null, undefined, 5]) assert.equal(s(none), null, String(none));
  assert.equal(structuralRepo("/home/someone/www/acme/widgets", "/home/other"), null, "another user's home is not this machine's project layout");
  assert.equal(structuralRepo("/home/someone/www/acme/widgets", "/home/someone/"), "widgets", "a trailing slash on the home does not matter");
});

test("repoOfGitUrl: the repository name of a remote, https or ssh, with or without .git", () => {
  assert.equal(repoOfGitUrl("git@github.com:Acme/payments.git"), "payments");
  assert.equal(repoOfGitUrl("https://github.com/acme/web-app"), "web-app");
  assert.equal(repoOfGitUrl("https://github.com/acme/code.git/"), "code");
  assert.equal(repoOfGitUrl(null), null);
  assert.equal(repoOfGitUrl(""), null);
});

test("repoOfSession: the checkout on disk first, then the path's own layout, then the recorded git remote; never an invented name", () => {
  const root = tmpDir("recall-identity");
  const live = path.join(root, "www", "acme", "livecheckout");
  fs.mkdirSync(path.join(live, ".git"), { recursive: true });
  fs.mkdirSync(path.join(live, "src"), { recursive: true });
  assert.equal(repoOfSession({ cwd: path.join(live, "src"), home: root }), "livecheckout", "disk");
  const gone = path.join(root, "www", "acme", "deleted-repo");
  assert.equal(repoOfSession({ cwd: gone, home: root }), "deleted-repo", "the directory is gone: its path names the repo");
  assert.equal(repoOfSession({ cwd: gone, gitUrl: "git@github.com:acme/other-name.git", home: root }), "deleted-repo", "the path beats the remote's name (the live rule names the checkout's directory too)");
  assert.equal(repoOfSession({ cwd: "/private/tmp/scratch", gitUrl: "git@github.com:acme/recorded.git", home: root }), "recorded", "a path that says nothing: the recorded remote");
  assert.equal(repoOfSession({ cwd: "/private/tmp/scratch", home: root }), null);
  assert.equal(repoOfSession({ cwd: null, home: root }), null);
});

test("aliases: a renamed or sibling repo is the same repo, both ways; a missing repo is never the same as anything", () => {
  const aliases = { "web-app-v2": "web-app" };
  assert.equal(canonicalRepo("web-app-v2", aliases), "web-app");
  assert.equal(canonicalRepo("web-app", aliases), "web-app");
  assert.equal(canonicalRepo("other", aliases), "other");
  assert.equal(canonicalRepo("web-app-v2", {}), "web-app-v2");
  assert.equal(canonicalRepo(null, aliases), null);
  assert.equal(sameRepo("web-app-v2", "web-app", aliases), true);
  assert.equal(sameRepo("web-app", "web-app-v2", aliases), true);
  assert.equal(sameRepo("web-app-v2", "web-app", {}), false);
  assert.equal(sameRepo("a", "a", {}), true);
  assert.equal(sameRepo(null, null, aliases), false);
  assert.equal(sameRepo("a", null, aliases), false);
  assert.equal(canonicalRepo("toString", {}), "toString", "a name that is an Object.prototype key is not an alias");
});

// ---- the indexer ----
const rollout = ({ id, cwd, git, text, ts = "2026-09-01T10:00:00.000Z" }) => [
  JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, timestamp: ts, cwd, originator: "codex_cli", source: "cli", thread_source: "user", ...(git ? { git } : {}) } }),
  codexUser(text, ts),
].join("\n");

function world() {
  const root = tmpDir("recall-identity-index");
  const codex = path.join(root, ".codex_test");
  const claude = path.join(root, ".claude_test");
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${text}\n`); return file; };
  const config = loadConfig({ RECALL_DATA: path.join(root, "data"), RECALL_HOMES: [claude, codex].join(path.delimiter), RECALL_MIN_CHARS: "5" });
  const runtime = createRuntime(config, { post: fakeOpenAI().post });
  return { root, codex, claude, write, config, runtime, run: () => runIndex({ config, store: runtime.store, api: runtime.api, homeDir: root, env: {} }) };
}

test("index: a Codex session whose directory is gone is filed under the repo its cwd names; one with a live checkout under the checkout; one that names nothing stays without", async () => {
  const w = world();
  const live = path.join(w.root, "www", "acme", "stillhere");
  fs.mkdirSync(path.join(live, ".git"), { recursive: true });
  w.write(path.join(w.codex, "sessions/2026/09/01/rollout-2026-09-01T10-00-00-aaaa0001.jsonl"), rollout({ id: "aaaa0001", cwd: path.join(w.root, "www", "acme", "web-app"), text: "Please keep the preview stage out of the deck flow." }));
  w.write(path.join(w.codex, "sessions/2026/09/01/rollout-2026-09-01T11-00-00-aaaa0002.jsonl"), rollout({ id: "aaaa0002", cwd: path.join(live, "src"), text: "Always run the tests in the live checkout first." }));
  w.write(path.join(w.codex, "sessions/2026/09/01/rollout-2026-09-01T12-00-00-aaaa0003.jsonl"), rollout({ id: "aaaa0003", cwd: "/private/tmp/nowhere", text: "A statement said from a scratch directory somewhere." }));
  w.write(path.join(w.codex, "sessions/2026/09/01/rollout-2026-09-01T13-00-00-aaaa0004.jsonl"), rollout({ id: "aaaa0004", cwd: "/private/tmp/elsewhere", git: { repository_url: "git@github.com:acme/recorded-name.git", branch: "main" }, text: "A statement whose session recorded its git remote." }));
  const report = await w.run();
  const repoOf = (start) => w.runtime.store.loadStatements().find((s) => s.text.startsWith(start)).repo;
  assert.equal(repoOf("Please keep the preview"), "web-app");
  assert.equal(repoOf("Always run the tests"), "stillhere");
  assert.equal(repoOf("A statement said from a scratch"), null);
  assert.equal(repoOf("A statement whose session recorded"), "recorded-name");
  assert.equal(report.reposRepaired, 0, "nothing needed repairing on a fresh index");
  // an index made before this rule: the same statements with no repo; the next index pass (no transcript changed) files them
  w.runtime.store.updateStatements((rows) => rows.map((r) => ({ ...r, repo: null })));
  const again = await w.run();
  assert.equal(again.scanned, 0, "no transcript was read again");
  assert.equal(again.reposRepaired, 3, "the three whose sessions name a repo");
  assert.equal(repoOf("Please keep the preview"), "web-app");
  assert.equal(repoOf("A statement said from a scratch"), null);
});

test("index: a Claude session whose project directory cannot be decoded takes the repo from the turn's own cwd", async () => {
  const w = world();
  const turn = JSON.parse(claudeUser("Please never touch the production branch from here."));
  turn.cwd = path.join(w.root, "www", "acme", "gone-checkout");
  w.write(path.join(w.claude, "projects", "-worktrees-gone", "5aaa0000-0000-0000-0000-0000000000aa.jsonl"), JSON.stringify(turn));
  await w.run();
  assert.equal(w.runtime.store.loadStatements().find((s) => s.text.startsWith("Please never touch")).repo, "gone-checkout");
});

test("repair: statements indexed with no repo get the one their session's cwd names; the rest are untouched; a second pass changes nothing", () => {
  const dataDir = tmpDir("recall-repair");
  const store = createStore(dataDir);
  const home = "/home/someone";
  const file = (n) => `/x/rollout-${n}.jsonl`;
  const row = (id, over) => ({ id, text: `statement ${id}`, ts: "2026-09-01T10:00:00.000Z", session_id: "s", repo: null, host: "codex", hash: id, src: `${file(1)}:L2`, ...over });
  store.appendStatements([
    row("a"),
    row("b", { src: `${file(1)}:L9` }),
    row("c", { repo: "kept", src: `${file(1)}:L3` }),
    row("d", { src: `${file(2)}:L2` }),
    row("e", { src: `${file(3)}:L2` }),
    row("f", { src: "test" }),
  ]);
  const state = { files: {
    [file(1)]: { meta: { cwd: `${home}/www/acme/web-app` } },
    [file(2)]: { meta: { cwd: "/private/tmp/nothing" } },
    [file(3)]: { meta: { cwd: "/private/tmp/nothing", git_url: "https://github.com/acme/from-remote" } },
  } };
  assert.equal(repairStatementRepos({ store, state, homeDir: home }), 3);
  const repos = Object.fromEntries(store.loadStatements().map((s) => [s.id, s.repo]));
  assert.deepEqual(repos, { a: "web-app", b: "web-app", c: "kept", d: null, e: "from-remote", f: null });
  assert.equal(repairStatementRepos({ store, state, homeDir: home }), 0);
  assert.ok(!fs.readdirSync(dataDir).some((n) => n.endsWith(".tmp")), "no temp file left behind");
});

test("store.updateStatements: nothing is written when the change says null, and the rewrite is atomic", () => {
  const store = createStore(tmpDir("recall-update"));
  const row = (id) => ({ id, text: id, ts: "2026-09-01T10:00:00.000Z", session_id: "s", repo: null, host: "claude", hash: id, src: "test" });
  store.appendStatements([row("a"), row("b")]);
  assert.equal(store.updateStatements(() => null), false);
  assert.equal(store.updateStatements((rows) => rows.filter((r) => r.id !== "a")), true);
  assert.deepEqual(store.loadStatements().map((r) => r.id), ["b"]);
});
