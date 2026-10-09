// The precision rules (cards/precision.mjs), rule by rule: the predicates and their boundaries, the eligibility check with its reasons, the
// configuration (defaults, tuning, off, unknown keys), all four off = the filter as it was, the next statement taking a slot, and what the turn
// log and `recall logs` say. Synthetic statements only; no network (the fake OpenAI answers the judge).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendCards, cardsPath } from "../scripts/lib/cards/cards-file.mjs";
import { attachCards, cardAllow } from "../scripts/lib/cards/eligibility.mjs";
import { CITATION, citesLocation, exclusionTally, hasPlaceholderGist, isCrossRepo, PRECISION_REASONS, precisionCheck, precisionOn, precisionRules } from "../scripts/lib/cards/precision.mjs";
import { buildCard } from "../scripts/lib/cards/schema.mjs";
import { CONFIG_KEYS, ConfigError, loadConfig, PRECISION_FLAGS, V1_ENV, V2_ENV } from "../scripts/lib/config.mjs";
import { parseHookInput } from "../scripts/lib/hook-io.mjs";
import { loadIndexedCorpus } from "../scripts/lib/index-corpus.mjs";
import { formatSummary, summarizeLogs } from "../scripts/lib/log-summary.mjs";
import { handlePrompt } from "../scripts/lib/prompt-hook.mjs";
import { retrieve } from "../scripts/lib/retrieve.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { sameRepo } from "../scripts/lib/repo-identity.mjs";
import { readSettings } from "../scripts/monitor/settings.mjs";
import { fakeOpenAI, readFixture, seedIndex, startFakeServer, tmpDir } from "./helpers.mjs";

const AT = "2026-10-08T12:00:00.000Z";
const NOW = () => new Date("2026-10-07T12:00:00Z");
const PROMPT = "The sync worker keeps timing out, so I will add a retry loop with a long delay to hide the failure.";
const HERE = "billing-api";
const HOME_PATH = ["", "Users", "sam", "work", "notes"].join("/"); // built, so that no tracked file carries a home path literally

/** Text of exactly n characters that starts with `lead` (and so shares its words with the prompt when the lead does). */
const padTo = (lead, n) => (lead + " " + "retry delay loop ".repeat(Math.ceil(n / 10))).slice(0, n);
/** Text of exactly n characters made of `base` repeated: it keeps the words (and so the match to a prompt that is `base`) of the original. */
const repeatTo = (base, n) => `${base} `.repeat(Math.ceil(n / base.length) + 1).slice(0, n);
/** A directory that is a repository called `name` (what repoOfCwd finds for a cwd inside it). */
const repoDir = (name) => { const d = path.join(tmpDir("recall-prec-repo"), name); fs.mkdirSync(path.join(d, ".git"), { recursive: true }); return d; };
const hookInput = (over) => parseHookInput({ stdin: JSON.stringify({ ...JSON.parse(readFixture("hook-inputs", "claude-prompt.json")), ...over }) });
const logLines = (dataDir) => {
  const dir = path.join(dataDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("turns-")).sort().flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map(JSON.parse)) : [];
};

const item = (over = {}, card = {}) => ({ id: "s", repo: HERE, text: "Keep the retry loop out of the sync worker.", card: { kind: "rule", scope: "global", gist: "the agent was adding a retry loop", gist_source: "transcript", ...card }, ...over });
const DEFAULTS = loadConfig({});
const check = (cfg = DEFAULTS, repo = HERE) => precisionCheck(cfg, repo);

// ---- the predicates ----
test("RG: only gist_source none is the placeholder; every other source, and a card written before gist_source existed, is not", () => {
  assert.equal(hasPlaceholderGist({ gist_source: "none" }), true);
  for (const source of ["transcript", "index", "prior-statement", undefined]) assert.equal(hasPlaceholderGist({ gist_source: source }), false, String(source));
});

test("RU: a URL, a local address or port, a home path, a source or document file name; not a time, a version or a bare extension", () => {
  assert.ok(CITATION instanceof RegExp);
  for (const t of [
    "see https://docs.example.test/page", "http://nowhere.test/x", "run it on 127.0.0.1", "it listens on localhost", "the server is on :3000 now", "port :80801 is wrong", "port :8080",
    `the file is ${HOME_PATH}`, "edit ~/config please", "change worker.ts first", "see notes.md", "check run.js", "the module lib.mjs", "in settings.json", "App.tsx is broken",
  ]) assert.equal(citesLocation(t), true, t);
  for (const t of [
    "meet at 12:30 tomorrow", "version 1.2.3 is out", "use port 80", "the ts and js files", "a tsx component", "talk to the user about json", "a md note", "Users are asked first", "tilde ~ alone", "only :123 here",
    "say it plainly, no fallback",
  ]) assert.equal(citesLocation(t), false, t);
  assert.equal(citesLocation(`path ${HOME_PATH}`), true, "the same regular expression twice gives the same answer (no sticky state)");
  assert.equal(citesLocation(`path ${HOME_PATH}`), true);
});

test("R5: cross-repo is the repo not being the current one under the aliases; a missing repo is never the current one", () => {
  assert.equal(isCrossRepo("a", "b"), true);
  assert.equal(isCrossRepo("a", "a"), false);
  assert.equal(isCrossRepo(null, "a"), true);
  assert.equal(isCrossRepo("a", null), true, "no current repo: nothing is said in it");
  assert.equal(isCrossRepo(null, null), true);
  assert.equal(isCrossRepo("web-app-v2", "web-app", { "web-app-v2": "web-app" }), false, "an alias is the same repo");
  assert.equal(isCrossRepo("a", "b"), !sameRepo("a", "b"), "the scope rule's own definition");
});

// ---- the check: reasons and boundaries ----
test("each rule keeps out its own statement, under its own reason, and nothing else", () => {
  const c = check();
  assert.equal(c(item()), null, "a plain short rule said here");
  assert.equal(c(item({}, { gist_source: "none" })), "gist-placeholder");
  assert.equal(c(item({ text: "Open https://docs.example.test/retry before touching the loop." })), "cites-location");
  assert.equal(c(item({ repo: "shared-lib", text: padTo("Keep the retry loop out of the worker.", 300) })), "cross-repo-long");
  assert.equal(c(item({ text: padTo("Keep the retry loop out of the worker.", 500) })), "long-directive");
  assert.deepEqual(PRECISION_REASONS, ["gist-placeholder", "cites-location", "cross-repo-long", "long-directive"], "four rules, four distinct reasons");
});

test("the boundaries: 299 and 300 characters across repos, 499 and 500 for a rule or a preference; only rules and preferences; only across repos for R5", () => {
  const c = check();
  const other = (n, card) => item({ repo: "shared-lib", text: padTo("Keep the retry loop out of the worker.", n) }, card);
  assert.equal(c(other(299)), null);
  assert.equal(c(other(300)), "cross-repo-long");
  assert.equal(c(item({ text: padTo("Keep the retry loop out of the worker.", 300) })), null, "300 characters said in this repo: R5 is cross-repo only");
  assert.equal(c(item({ text: padTo("Keep the retry loop out of the worker.", 499) })), null);
  assert.equal(c(item({ text: padTo("Keep the retry loop out of the worker.", 500) })), "long-directive");
  assert.equal(c(item({ text: padTo("Keep the retry loop out of the worker.", 499) }, { kind: "preference" })), null);
  assert.equal(c(item({ text: padTo("Keep the retry loop out of the worker.", 500) }, { kind: "preference" })), "long-directive");
  for (const kind of ["decision", "correction", "other"]) assert.equal(c(item({ text: padTo("Keep the retry loop out of the worker.", 900) }, { kind })), null, `a long ${kind} said here is not R4v's`);
  assert.equal(c(other(900, { kind: "decision", scope: "global" })), "cross-repo-long", "R5 is for any kind (the scope filter decides which can cross)");
  assert.equal(c(item({ repo: null, text: padTo("Keep the retry loop out of the worker.", 300) })), "cross-repo-long", "said in no repo is another repo");
  assert.equal(check(DEFAULTS, null)(item({ text: padTo("Keep the retry loop out of the worker.", 300) })), "cross-repo-long", "no current repo: everything is cross-repo");
  assert.equal(check({ ...DEFAULTS, repoAliases: { "shared-lib": HERE } })(other(300)), null, "an alias makes it the same repo");
});

test("a statement several rules would keep out is counted once, under the first in the order RG, RU, R5, R4v", () => {
  const long = padTo("See notes.md about the retry loop in the worker.", 700);
  const c = check();
  assert.equal(c(item({ text: long }, { gist_source: "none" })), "gist-placeholder");
  assert.equal(c(item({ text: long })), "cites-location");
  assert.equal(c(item({ repo: "shared-lib", text: padTo("Keep the retry loop out of the worker.", 700) })), "cross-repo-long", "over R4v's limit too, but R5 comes first");
  const seen = [];
  const allow = cardAllow({ ...DEFAULTS, excludeKinds: ["question", "status"], scopeFilter: false }, HERE, (reason, it) => seen.push([reason, it.id]));
  assert.equal(allow(item({ id: "multi", text: long }, { gist_source: "none" })), false);
  assert.deepEqual(seen, [["gist-placeholder", "multi"]], "reported once");
});

test("the precision rules come after the kind and scope rules: those keep their statements out without a precision reason", () => {
  const seen = [];
  const allow = cardAllow({ ...DEFAULTS, excludeKinds: ["question", "status"], scopeFilter: true }, HERE, (reason, it) => seen.push([reason, it.id]));
  assert.equal(allow(item({ id: "q" }, { kind: "question", gist_source: "none" })), false);
  assert.equal(allow(item({ id: "far", repo: "shared-lib", text: padTo("Keep the retry loop out of the worker.", 400) }, { kind: "decision", scope: "repo" })), false, "the scope rule keeps it out first");
  assert.equal(allow({ id: "nocard", repo: HERE, text: "x" }), false);
  assert.deepEqual(seen, []);
  assert.equal(allow(item({ id: "ok" })), true);
});

test("each rule can be switched off alone, and tuned", () => {
  const cases = [
    ["excludeNewSessionGist", false, item({}, { gist_source: "none" })],
    ["excludeCitations", false, item({ text: "Open https://docs.example.test/retry before touching the loop." })],
    ["crossRepoMaxChars", 0, item({ repo: "shared-lib", text: padTo("Keep the retry loop out of the worker.", 800) }, { kind: "decision" })],
    ["ruleMaxChars", 0, item({ text: padTo("Keep the retry loop out of the worker.", 900) })],
  ];
  for (const [key, off, it] of cases) {
    assert.notEqual(check()(it), null, `${key} on: kept out`);
    assert.equal(check({ ...DEFAULTS, [key]: off })(it), null, `${key} off: eligible`);
    assert.deepEqual(precisionRules({ ...DEFAULTS, [key]: off }, HERE).length, 3, `${key} off: three rules left`);
  }
  const mid = (n) => item({ repo: "shared-lib", text: padTo("Keep the retry loop out of the worker.", n) });
  assert.equal(check({ ...DEFAULTS, crossRepoMaxChars: 100 })(mid(150)), "cross-repo-long", "tuned down");
  assert.equal(check({ ...DEFAULTS, crossRepoMaxChars: 400 })(mid(350)), null, "tuned up");
  assert.equal(check({ ...DEFAULTS, ruleMaxChars: 200 })(item({ text: padTo("Keep the retry loop out of the worker.", 250) })), "long-directive");
  assert.equal(check({ ...DEFAULTS, ruleMaxChars: 800 })(item({ text: padTo("Keep the retry loop out of the worker.", 600) })), null);
  assert.equal(precisionCheck({ ...DEFAULTS, excludeNewSessionGist: false, excludeCitations: false, crossRepoMaxChars: 0, ruleMaxChars: 0 }, HERE), null, "all four off: no check at all");
  assert.equal(precisionOn(DEFAULTS), true);
  assert.equal(precisionOn({ excludeNewSessionGist: false, excludeCitations: false, crossRepoMaxChars: 0, ruleMaxChars: 0 }), false);
  assert.equal(precisionOn({ excludeKinds: [], scopeFilter: false }), false, "a settings object that does not name the rules has them off");
});

// ---- configuration ----
test("config: on by default; environment names; config.json keys; env beats the file; unknown keys, wrong types and bad values are loud errors", () => {
  assert.deepEqual(Object.fromEntries(PRECISION_FLAGS.map((f) => [f, DEFAULTS[f]])), { excludeNewSessionGist: true, excludeCitations: true, crossRepoMaxChars: 300, ruleMaxChars: 500 });
  for (const key of PRECISION_FLAGS) assert.ok(CONFIG_KEYS.includes(key), `${key} is a config.json key`);
  assert.equal(loadConfig({ RECALL_EXCLUDE_NEW_SESSION_GIST: "0" }).excludeNewSessionGist, false);
  assert.equal(loadConfig({ RECALL_EXCLUDE_CITATIONS: "off" }).excludeCitations, false);
  assert.equal(loadConfig({ RECALL_CROSS_REPO_MAX_CHARS: "0" }).crossRepoMaxChars, 0);
  assert.equal(loadConfig({ RECALL_CROSS_REPO_MAX_CHARS: "250" }).crossRepoMaxChars, 250);
  assert.equal(loadConfig({ RECALL_RULE_MAX_CHARS: "0" }).ruleMaxChars, 0);
  assert.throws(() => loadConfig({ RECALL_RULE_MAX_CHARS: "-1" }), /RECALL_RULE_MAX_CHARS/);
  assert.throws(() => loadConfig({ RECALL_RULE_MAX_CHARS: "2.5" }), /RECALL_RULE_MAX_CHARS/);
  assert.throws(() => loadConfig({ RECALL_EXCLUDE_CITATIONS: "sometimes" }), /RECALL_EXCLUDE_CITATIONS/);

  const dataDir = tmpDir("recall-prec-cfg");
  const write = (body) => fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(body));
  write({ excludeNewSessionGist: false, excludeCitations: false, crossRepoMaxChars: 0, ruleMaxChars: 700 });
  const file = loadConfig({ RECALL_DATA: dataDir });
  assert.deepEqual(Object.fromEntries(PRECISION_FLAGS.map((f) => [f, file[f]])), { excludeNewSessionGist: false, excludeCitations: false, crossRepoMaxChars: 0, ruleMaxChars: 700 });
  assert.deepEqual(PRECISION_FLAGS.map((f) => file.sources[f]), ["file", "file", "file", "file"]);
  const env = loadConfig({ RECALL_DATA: dataDir, RECALL_EXCLUDE_CITATIONS: "1", RECALL_RULE_MAX_CHARS: "400" });
  assert.deepEqual([env.excludeCitations, env.ruleMaxChars, env.sources.excludeCitations, env.sources.ruleMaxChars, env.excludeNewSessionGist], [true, 400, "env", "env", false], "env beats file");
  for (const [body, re] of [
    [{ excludeCitations: "yes" }, /"excludeCitations" is "yes" but must be true or false/],
    [{ ruleMaxChars: "500" }, /"ruleMaxChars" is "500" but must be an integer/],
    [{ crossRepoMaxChars: -5 }, /"crossRepoMaxChars"/],
    [{ ruleMaxChars: 1.5 }, /"ruleMaxChars"/],
    [{ excludeGistSources: ["none"] }, /unknown key "excludeGistSources"/],
    [{ excludeCitation: true }, /unknown key "excludeCitation"/],
  ]) {
    write(body);
    assert.throws(() => loadConfig({ RECALL_DATA: dataDir }), (e) => e instanceof ConfigError && e.message.includes(path.join(dataDir, "config.json")) && re.test(e.message), JSON.stringify(body));
  }
});

test("V1_ENV switches the rules off with everything else; V2_ENV says their defaults explicitly over a file that says otherwise", () => {
  const v1 = loadConfig(V1_ENV);
  assert.deepEqual(Object.fromEntries(PRECISION_FLAGS.map((f) => [f, v1[f]])), { excludeNewSessionGist: false, excludeCitations: false, crossRepoMaxChars: 0, ruleMaxChars: 0 });
  const dataDir = tmpDir("recall-prec-cfg");
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ excludeCitations: false, ruleMaxChars: 0 }));
  const v2 = loadConfig({ ...V2_ENV, RECALL_DATA: dataDir });
  assert.deepEqual(Object.fromEntries(PRECISION_FLAGS.map((f) => [f, v2[f]])), { excludeNewSessionGist: true, excludeCitations: true, crossRepoMaxChars: 300, ruleMaxChars: 500 });
});

// ---- all four off is the filter as it was ----
test("with all four off the eligibility is the one before these rules, over every kind, scope, repo, length, gist source and citation", () => {
  // the predicate as it stood before the precision rules existed
  const legacy = (cfg, currentRepo) => {
    const exclude = new Set(cfg.excludeKinds ?? []);
    if (!exclude.size && !cfg.scopeFilter) return null;
    return (it) => {
      const card = it.card;
      if (!card) return false;
      if (exclude.has(card.kind)) return false;
      if (cfg.scopeFilter && !sameRepo(it.repo, currentRepo, cfg.repoAliases) && !(card.scope === "global" && ["rule", "preference"].includes(card.kind))) return false;
      return true;
    };
  };
  const off = { excludeNewSessionGist: false, excludeCitations: false, crossRepoMaxChars: 0, ruleMaxChars: 0 };
  const items = [];
  for (const kind of ["rule", "preference", "decision", "correction", "question", "status", "other"]) for (const scope of ["global", "repo", "unclear"]) for (const repo of [HERE, "shared-lib", null])
    for (const len of [40, 300, 500, 900]) for (const gist_source of ["none", "transcript", undefined]) for (const text of ["no place named", "see https://docs.example.test/x", "edit worker.ts"])
      items.push({ id: `${kind}${scope}${repo}${len}${gist_source}${text.length}`, repo, text: padTo(text, Math.max(len, text.length)), card: { kind, scope, gist: "g", gist_source } });
  items.push({ id: "nocard", repo: HERE, text: "no card" });
  let n = 0;
  for (const base of [{ excludeKinds: ["question", "status"], scopeFilter: true }, { excludeKinds: [], scopeFilter: true }, { excludeKinds: ["other"], scopeFilter: false }, { excludeKinds: [], scopeFilter: false }, { excludeKinds: ["question"], scopeFilter: true, repoAliases: { "shared-lib": HERE } }]) {
    for (const currentRepo of [HERE, null]) {
      const want = legacy(base, currentRepo);
      const got = cardAllow({ ...base, ...off }, currentRepo);
      assert.equal(got === null, want === null);
      if (want) for (const it of items) { assert.equal(got(it), want(it), JSON.stringify([base, currentRepo, it.id])); n++; }
    }
  }
  assert.ok(n > 5000, `${n} comparisons`);
  // and with the rules named but the card filter itself off (v1 values), they do nothing
  assert.equal(cardAllow({ excludeKinds: [], scopeFilter: false, ...{ excludeNewSessionGist: true, excludeCitations: true, crossRepoMaxChars: 300, ruleMaxChars: 500 } }, HERE), null);
});

// ---- a statement kept out gives its slot to the next one; the log names it ----
const T = (n) => `2026-09-0${n}T10:00:00.000Z`;
const lead = "Keep the retry loop and the long delay out of the sync worker.";
const ROWS = [
  { id: "plain", ts: T(1), repo: HERE, text: `${lead} Fix the timeout.`, card: { kind: "rule", scope: "global", gist: "the agent was adding a retry loop", gist_source: "transcript" } },
  { id: "plain2", ts: T(2), repo: HERE, text: "A retry loop with a long delay hides the sync failure, so show me the failure.", card: { kind: "decision", scope: "repo", gist: "the agent proposed a delay", gist_source: "index" } },
  { id: "rg", ts: T(3), repo: HERE, text: `${lead} Brief for a new task.`, card: { kind: "rule", scope: "global", gist: "nothing was said before", gist_source: "none" } },
  { id: "ru", ts: T(4), repo: HERE, text: `${lead} Details are at https://docs.example.test/retry.`, card: { kind: "rule", scope: "global", gist: "the agent was adding a retry loop", gist_source: "transcript" } },
  { id: "ru2", ts: T(5), repo: HERE, text: `${lead} The code is in src/worker.ts.`, card: { kind: "preference", scope: "global", gist: "the agent was adding a retry loop", gist_source: "transcript" } },
  { id: "r5", ts: T(6), repo: "shared-lib", text: padTo(lead, 300), card: { kind: "rule", scope: "global", gist: "the agent was adding a retry loop", gist_source: "transcript" } },
  { id: "r4", ts: T(7), repo: HERE, text: padTo(lead, 500), card: { kind: "preference", scope: "global", gist: "the agent was adding a retry loop", gist_source: "transcript" } },
  { id: "multi", ts: T(8), repo: "shared-lib", text: `${padTo(lead, 700)} see notes.md`, card: { kind: "rule", scope: "global", gist: "nothing was said before", gist_source: "none" } },
  { id: "short-far", ts: T(9), repo: "shared-lib", text: padTo(lead, 299), card: { kind: "rule", scope: "global", gist: "the agent was adding a retry loop", gist_source: "transcript" } },
  { id: "long-here", ts: "2026-09-10T10:00:00.000Z", repo: HERE, text: padTo(lead, 499), card: { kind: "rule", scope: "repo", gist: "the agent was adding a retry loop", gist_source: "transcript" } },
  { id: "long-decision", ts: "2026-09-11T10:00:00.000Z", repo: HERE, text: padTo(lead, 800), card: { kind: "decision", scope: "repo", gist: "the agent was adding a retry loop", gist_source: "transcript" } },
];

async function setup({ env = {}, rows = ROWS } = {}) {
  const dataDir = tmpDir("recall-prec");
  const config = loadConfig({ RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_DAILY_CAP_USD: "5", RECALL_ALLOW_HEADLESS: "1", RECALL_K: "20", ...env });
  const fake = fakeOpenAI({ decide: () => 0.99 });
  const runtime = createRuntime(config, { post: fake.post });
  await seedIndex(runtime.store, rows.map(({ card, ...r }) => r));
  const cards = rows.filter((r) => r.card).map((r) => buildCard({ statement: r, entry: { n: 1, ...r.card }, model: "haiku", at: AT, gistSource: r.card.gist_source }));
  appendCards(cardsPath(dataDir), cards);
  const { corpus } = loadIndexedCorpus(runtime.store);
  attachCards(corpus, new Map(cards.map((c) => [c.id, c])));
  return { dataDir, config, fake, runtime, corpus };
}
const rank = async (s, cfg = s.config) => retrieve({ corpus: s.corpus, query: PROMPT, mode: "prompt", decisionTs: "2026-10-07T12:00:00Z", currentRepo: HERE, pipeline: "default", deps: s.runtime.makeDeps({ stats: {} }), cfg, stats: {} });
const hook = async (s, over = {}) => {
  await handlePrompt({ input: hookInput({ prompt: PROMPT, cwd: repoDir(HERE), ...over }), config: s.config, runtime: s.runtime, now: NOW });
  return logLines(s.dataDir).at(-1);
};
const OFF_ENV = { RECALL_EXCLUDE_NEW_SESSION_GIST: "0", RECALL_EXCLUDE_CITATIONS: "0", RECALL_CROSS_REPO_MAX_CHARS: "0", RECALL_RULE_MAX_CHARS: "0" };
const KEPT = ["rg", "ru", "ru2", "r5", "r4", "multi"];

test("retrieval ranks only what the rules leave: the kept-out statements are not in the ranking, with them off they are", async () => {
  const on = await setup();
  const off = await setup({ env: OFF_ENV });
  const idsOn = (await rank(on)).ranked.map((r) => r.id);
  const idsOff = (await rank(off)).ranked.map((r) => r.id);
  for (const id of KEPT) { assert.ok(!idsOn.includes(id), `${id} is not ranked with the rules on`); assert.ok(idsOff.includes(id), `${id} is ranked with them off`); }
  assert.deepEqual([...idsOn].sort(), ["long-decision", "long-here", "plain", "plain2", "short-far"], "everything else is still ranked");
  assert.deepEqual([...idsOff].sort(), ROWS.map((r) => r.id).sort());
  assert.equal((await rank(on)).eligible, 5);
  assert.equal((await rank(off)).eligible, ROWS.length);
});

test("backfill: when a rule keeps out the best statement, the next eligible one takes its slot (k = 2)", async () => {
  // the best match for the prompt is the one that cites a URL: the prompt's own words, then the URL
  const best = { id: "best", ts: T(9), repo: HERE, text: `${PROMPT} It is explained at https://docs.example.test/sync.`, card: { kind: "rule", scope: "global", gist: "the agent was adding a retry loop", gist_source: "transcript" } };
  const rows = [best, ROWS[0], ROWS[1], ROWS[9]];
  const off = await setup({ rows, env: { ...OFF_ENV, RECALL_K: "2" } });
  const lineOff = await hook(off);
  assert.equal(lineOff.injected.length, 2);
  assert.equal(lineOff.injected[0], "best", "without the rules the URL statement is the best match and is injected");
  const on = await setup({ rows, env: { RECALL_K: "2" } });
  const lineOn = await hook(on);
  assert.ok(!lineOn.injected.includes("best"), "with the rules on it is not injected");
  assert.equal(lineOn.injected.length, 2, "and the slot is not lost: the next eligible statements fill k");
  assert.equal(lineOn.injected[0], lineOff.injected[1], "the runner-up moved up");
  assert.ok(!lineOn.candidates.some((c) => c.id === "best"), "it was never a candidate");
  assert.deepEqual(lineOn.excluded["cites-location"], { count: 1, ids: ["best"] });
  assert.ok(lineOn.context.includes(ROWS[0].text) || lineOn.context.includes(ROWS[1].text) || lineOn.context.includes(ROWS[9].text));
  assert.ok(!lineOn.context.includes("docs.example.test"), "the cited URL never reaches the agent");
});

test("backfill, one rule at a time: each rule's statement leads the ranking with the rules off, and is replaced by the next with only that rule on", async () => {
  const lead2 = `${PROMPT} Say so plainly.`;
  const lone = [
    ["excludeNewSessionGist", "RECALL_EXCLUDE_NEW_SESSION_GIST", "gist-placeholder", { repo: HERE, text: lead2, card: { kind: "rule", scope: "global", gist: "nothing was said before", gist_source: "none" } }],
    ["excludeCitations", "RECALL_EXCLUDE_CITATIONS", "cites-location", { repo: HERE, text: `${lead2} Read ~/notes/sync.txt first.`, card: { kind: "rule", scope: "global", gist: "the agent was adding a retry loop", gist_source: "transcript" } }],
    ["crossRepoMaxChars", "RECALL_CROSS_REPO_MAX_CHARS", "cross-repo-long", { repo: "shared-lib", text: repeatTo(lead2, 320), card: { kind: "rule", scope: "global", gist: "the agent was adding a retry loop", gist_source: "transcript" } }],
    ["ruleMaxChars", "RECALL_RULE_MAX_CHARS", "long-directive", { repo: HERE, text: repeatTo(lead2, 520), card: { kind: "rule", scope: "global", gist: "the agent was adding a retry loop", gist_source: "transcript" } }],
  ];
  for (const [key, envName, reason, lone1] of lone) {
    const rows = [{ id: "top", ts: T(9), ...lone1 }, ROWS[0], ROWS[1]];
    const onlyThis = Object.fromEntries(Object.entries(OFF_ENV).filter(([k]) => k !== envName));
    const withRule = await hook(await setup({ rows, env: { ...onlyThis, RECALL_K: "1" } }));
    const without = await hook(await setup({ rows, env: { ...OFF_ENV, RECALL_K: "1" } }));
    assert.deepEqual(without.injected, ["top"], `${key} off: the best match is injected`);
    assert.equal(withRule.injected.length, 1, `${key} on: the slot is filled`);
    assert.notEqual(withRule.injected[0], "top", `${key} on: by the next statement`);
    assert.deepEqual(Object.keys(withRule.excluded), [reason], `${key}: its own reason, no other`);
    assert.deepEqual(withRule.excluded[reason], { count: 1, ids: ["top"] });
  }
});

test("the turn log names the statements kept out and why: one distinct reason per rule, counted once, the settings beside them", async () => {
  const s = await setup();
  const line = await hook(s);
  assert.deepEqual(Object.keys(line.excluded).sort(), [...PRECISION_REASONS].sort(), "all four reasons, none other");
  assert.deepEqual(line.excluded["gist-placeholder"], { count: 2, ids: ["rg", "multi"] }, "multi has a placeholder gist, a path and a length: the first rule takes it");
  assert.deepEqual(line.excluded["cites-location"], { count: 2, ids: ["ru", "ru2"] });
  assert.deepEqual(line.excluded["cross-repo-long"], { count: 1, ids: ["r5"] });
  assert.deepEqual(line.excluded["long-directive"], { count: 1, ids: ["r4"] });
  assert.deepEqual(line.precision.excludeNewSessionGist, { value: true, source: "default" });
  assert.deepEqual([line.precision.crossRepoMaxChars.value, line.precision.ruleMaxChars.value], [300, 500]);
  assert.equal(line.eligible, 5);
  assert.deepEqual([...line.injected].sort(), ["long-decision", "long-here", "plain", "plain2", "short-far"], "k 20: everything left is injected");
  assert.ok(line.candidates.every((c) => !KEPT.includes(c.id)));
  // switched off: nothing is kept out and the log says nothing of it
  const off = await hook(await setup({ env: OFF_ENV }));
  assert.equal(off.excluded, undefined);
  assert.deepEqual(off.precision.excludeCitations, { value: false, source: "env" });
  assert.equal(off.eligible, ROWS.length);
  // the v1 values: no card filter, so neither the rules nor their log fields
  const v1 = await setup({ env: V1_ENV, rows: ROWS.map(({ card, ...r }) => r) });
  const v1line = await hook(v1);
  assert.equal(v1line.excluded, undefined);
  assert.equal(v1line.precision, undefined);
});

test("the log lists at most the newest 50 ids per reason and the true count", () => {
  const t = exclusionTally();
  for (let i = 0; i < 120; i++) t.add("cites-location", { id: `s${i}` });
  t.add("gist-placeholder", { id: "g" });
  const sum = t.summary();
  assert.equal(sum["cites-location"].count, 120);
  assert.equal(sum["cites-location"].ids.length, 50);
  assert.deepEqual([sum["cites-location"].ids[0], sum["cites-location"].ids.at(-1)], ["s70", "s119"]);
  assert.deepEqual(sum["gist-placeholder"], { count: 1, ids: ["g"] });
  assert.equal(exclusionTally().summary(), null);
});

test("`recall logs` counts, per reason, the turns and the statements the rules kept out", async () => {
  const s = await setup();
  await hook(s);
  await hook(s, { session_id: "another-session" });
  const sum = summarizeLogs(s.dataDir, [new Date().toISOString().slice(0, 10), "2026-10-07", "2026-10-08"].filter((d, i, a) => a.indexOf(d) === i));
  assert.deepEqual(sum.excluded["gist-placeholder"], { turns: 2, statements: 4 });
  assert.deepEqual(sum.excluded["cites-location"], { turns: 2, statements: 4 });
  assert.deepEqual(sum.excluded["cross-repo-long"], { turns: 2, statements: 2 });
  assert.deepEqual(sum.excluded["long-directive"], { turns: 2, statements: 2 });
  const text = formatSummary(sum);
  for (const reason of PRECISION_REASONS) assert.ok(text.includes(reason), reason);
  assert.ok(!formatSummary({ ...sum, excluded: {} }).includes("precision rule"), "no section when nothing was kept out");
});

test("the monitor's settings list the four rules with their sources", () => {
  const dataDir = tmpDir("recall-prec-mon");
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ ruleMaxChars: 650 }));
  const { settings } = readSettings({ RECALL_DATA: dataDir });
  for (const key of PRECISION_FLAGS) assert.ok(settings[key], key);
  assert.deepEqual(settings.ruleMaxChars, { value: 650, source: "file" });
  assert.deepEqual(settings.excludeCitations, { value: true, source: "default" });
});

// ---- recall query ----
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "recall.mjs");
const recall = (args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, OPENAI_API_KEY: "sk-test", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  c.stdout.on("data", (d) => { stdout += d; });
  c.stderr.on("data", (d) => { stderr += d; });
  c.on("close", (code) => resolve({ code, stdout, stderr }));
});

test("recall query applies the rules like the hook; --any-repo lifts the cross-repo limit with the scope rule; the switches work from the environment", async () => {
  const server = await startFakeServer();
  try {
    const dir = tmpDir("recall-prec-query");
    const dataDir = path.join(dir, "data");
    const { createStore } = await import("../scripts/lib/store.mjs");
    const rows = [
      { id: "short", repo: "r1", text: "Keep the retry loop and the long delay out of the sync worker.", gist_source: "transcript" },
      { id: "far-long", repo: "r2", text: padTo("Keep the retry loop and the long delay out of the worker.", 350), gist_source: "transcript" },
      { id: "cited", repo: "r1", text: "Keep the retry loop and the long delay out of the worker, see src/worker.ts.", gist_source: "transcript" },
      { id: "opening", repo: "r1", text: "Keep the retry loop and the long delay out of the sync job, please.", gist_source: "none" },
    ].map((r, i) => ({ ...r, ts: `2026-01-0${i + 1}T00:00:00Z`, session_id: `s${i}`, host: "claude" }));
    await seedIndex(createStore(dataDir), rows.map(({ id, repo, text, ts, session_id, host }) => ({ id, repo, text, ts, session_id, host })));
    appendCards(path.join(dataDir, "cards.jsonl"), rows.map((r) => ({ id: r.id, kind: "rule", scope: "global", scope_repo: null, gist: "the agent was adding a retry loop", model: "test", at: "2026-01-01T00:00:00Z", gist_source: r.gist_source })));
    const env = { RECALL_DATA: dataDir, RECALL_OPENAI_BASE_URL: server.url, RECALL_DAILY_CAP_USD: "5", HOME: dir };
    const ids = async (extra = {}, ...args) => {
      const r = await recall(["query", "I will add a retry loop with a long delay to the sync worker", "--json", "--k", "10", "--repo", "r1", "--before", "2026-12-01T00:00:00Z", ...args], { ...env, ...extra });
      assert.equal(r.code, 0, r.stderr);
      return JSON.parse(r.stdout).results.map((x) => x.id).sort();
    };
    assert.deepEqual(await ids(), ["short"], "a long statement from another repo, a cited path and a placeholder gist are all kept out");
    assert.deepEqual(await ids({}, "--any-repo"), ["far-long", "short"], "--any-repo lifts the cross-repo limit; the other rules stay (cited and the placeholder gist are still out)");
    assert.deepEqual(await ids({ RECALL_EXCLUDE_CITATIONS: "0" }), ["cited", "short"]);
    assert.deepEqual(await ids({ RECALL_EXCLUDE_NEW_SESSION_GIST: "0" }), ["opening", "short"]);
    assert.deepEqual(await ids({ RECALL_CROSS_REPO_MAX_CHARS: "0" }), ["far-long", "short"]);
    assert.deepEqual(await ids({ RECALL_EXCLUDE_NEW_SESSION_GIST: "0", RECALL_EXCLUDE_CITATIONS: "0", RECALL_CROSS_REPO_MAX_CHARS: "0", RECALL_RULE_MAX_CHARS: "0" }), ["cited", "far-long", "opening", "short"], "all four off: everything the kind and scope rules allow");
  } finally {
    await server.close();
  }
});
