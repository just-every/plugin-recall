// v2 behaviour, flag by flag, and v1 reproduced exactly with every flag at its v1 value. No network: the fake OpenAI records every question, so
// what the judge was asked is asserted literally. Transcripts are built from synthetic lines in the real shapes (transcript-builders.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appendCards } from "../scripts/lib/cards/cards-file.mjs";
import { attachCards, cardAllow } from "../scripts/lib/cards/eligibility.mjs";
import { sameRepo } from "../scripts/lib/repo-identity.mjs";
import { buildCard } from "../scripts/lib/cards/schema.mjs";
import { cardsPath } from "../scripts/lib/cards/cards-file.mjs";
import { CARD_HEADER, CONTEXT_HEADER, formatCards, formatInjection } from "../scripts/lib/context.mjs";
import { CONFIG_KEYS, loadConfig, needsCards, V1_ENV, V2_ENV, V2_FLAGS } from "../scripts/lib/config.mjs";
import { dedupeRanked } from "../scripts/lib/dedupe.mjs";
import { parseHookInput } from "../scripts/lib/hook-io.mjs";
import { selectInjection } from "../scripts/lib/injection.mjs";
import { loadIndexedCorpus } from "../scripts/lib/index-corpus.mjs";
import { handlePrompt } from "../scripts/lib/prompt-hook.mjs";
import { itemLine, GENERIC_TEXT } from "../scripts/lib/pipelines/questions.mjs";
import { SESSION_PREDICATE } from "../scripts/lib/pipelines/sessions-nodes.mjs";
import { gated, retrieve } from "../scripts/lib/retrieve.mjs";
import { createRuntime } from "../scripts/lib/runtime.mjs";
import { contextSituation, promptSituation, STOP_HEAD } from "../scripts/lib/situations.mjs";
import { createTurnState } from "../scripts/lib/turn-log.mjs";
import { clip } from "../scripts/lib/text.mjs";
import { conversationTurns, priorContext } from "../scripts/lib/transcripts/tail.mjs";
import { fakeOpenAI, readFixture, seedIndex, tmpDir } from "./helpers.mjs";
import { claudeAssistant, claudeToolResult, claudeToolUse, claudeUser, codexAgent, codexCommand, codexUser, writeTranscript } from "./transcript-builders.mjs";

const AT = "2026-10-08T12:00:00.000Z";
const NOW = () => new Date("2026-10-07T12:00:00Z");
const recorded = (name) => JSON.parse(readFixture("hook-inputs", name));
const hookInput = (name, over = {}) => parseHookInput({ stdin: JSON.stringify({ ...recorded(name), ...over }) });
const PROMPT = "The duplicate draft runs come from a re-execution path, so I will add a fallback path with a random limit to stop them.";

// Seven statements, one per case the filters distinguish. All of them mention the same words, so the judge (the fake says yes to everything)
// and the rankers find them all: only eligibility decides which can be injected.
const T = (n) => `2026-09-0${n}T10:00:00.000Z`;
const ROWS = [
  { id: "g1", ts: T(1), repo: "shared-lib", text: "Never add a fallback path or a random limit, fix the code structure instead.", card: { kind: "rule", scope: "global", gist: "the agent had just added a fallback path to hide a failure" } },
  { id: "pf", ts: T(2), repo: "design-kit", text: "I prefer a proper fix over a fallback path: keep the code structure simple.", card: { kind: "preference", scope: "global", gist: "the agent offered two ways to fix the duplicate runs" } },
  { id: "r1", ts: T(3), repo: "billing-api", text: "In this repo a fallback path in the replay code needs my sign-off first.", card: { kind: "decision", scope: "repo", gist: "the agent was changing the replay code" } },
  { id: "r2", ts: T(4), repo: "payments", text: "Never push in this repo, a fallback path is not a reason to push.", card: { kind: "rule", scope: "repo", gist: "the agent had pushed a hotfix" } },
  { id: "u1", ts: T(5), repo: "billing-api", text: "A fallback path might be fine here but ask me about the random limit.", card: { kind: "correction", scope: "unclear", gist: "the agent had added a random limit" } },
  { id: "q1", ts: T(6), repo: "billing-api", text: "Why did the fallback path fail on this run when the previous run passed?", card: { kind: "question", scope: "repo", gist: "the agent reported a failed run that had worked before" } },
  { id: "n1", ts: T(7), repo: "billing-api", text: "A statement about the fallback path that has no card at all." },
];
const ALL = ROWS.map((r) => r.id);

async function setup({ env = {}, rows = ROWS, api = { decide: () => 0.99 } } = {}) {
  const dataDir = tmpDir("recall-v2");
  const config = loadConfig({ RECALL_DATA: dataDir, RECALL_AUTO_INDEX: "0", RECALL_DAILY_CAP_USD: "5", RECALL_ALLOW_HEADLESS: "1", RECALL_K: "10", ...env });
  const fake = fakeOpenAI(api);
  const runtime = createRuntime(config, { post: fake.post });
  await seedIndex(runtime.store, rows.map(({ card, ...r }) => r));
  appendCards(cardsPath(dataDir), rows.filter((r) => r.card).map((r) => buildCard({ statement: r, entry: { n: 1, ...r.card }, model: "haiku", at: AT, gistSource: "transcript" })));
  const { corpus } = loadIndexedCorpus(runtime.store);
  return { dataDir, config, fake, runtime, corpus, cards: (c = corpus) => attachCards(c, new Map(rows.filter((r) => r.card).map((r) => [r.id, buildCard({ statement: r, entry: { n: 1, ...r.card }, model: "haiku", at: AT, gistSource: "transcript" })]))) };
}
const ranked = async (s, over = {}) => {
  const stats = {};
  return retrieve({ corpus: s.corpus, query: PROMPT, mode: "prompt", decisionTs: "2026-10-07T12:00:00Z", pipeline: "default", deps: s.runtime.makeDeps({ stats }), cfg: s.config, stats, ...over });
};
const idsOf = (res) => res.ranked.map((r) => r.id).sort();
const logLines = (dataDir) => {
  const dir = path.join(dataDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("turns-")).sort().flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map(JSON.parse)) : [];
};
const decisionBodies = (fake) => fake.calls.filter((c) => c.pathname === "/v1/decisions").map((c) => c.body);
/** A directory that is a repository called `name` (what repoOfCwd finds for a cwd inside it). */
const repoDir = (name) => { const d = path.join(tmpDir("recall-repo"), name); fs.mkdirSync(path.join(d, ".git"), { recursive: true }); return d; };

// ---- the flags ----
test("config: the v2.1 defaults, the settings with their environment names, k 3, and the v1 values", () => {
  const v2 = loadConfig({});
  assert.deepEqual(Object.fromEntries(V2_FLAGS.map((f) => [f, v2[f]])), { excludeKinds: ["question", "status"], scopeFilter: true, queryContext: true, itemGist: false, noRepeat: true, hubMaxSessions: 3 });
  assert.deepEqual([v2.k, v2.hubWindowDays, v2.repoAliases, v2.promptThreshold], [3, 14, {}, 0.95]);
  assert.equal(needsCards(v2), true);
  const v1 = loadConfig(V1_ENV);
  assert.deepEqual(Object.fromEntries(V2_FLAGS.map((f) => [f, v1[f]])), { excludeKinds: [], scopeFilter: false, queryContext: false, itemGist: false, noRepeat: false, hubMaxSessions: 0 });
  assert.equal(v1.k, 5);
  assert.equal(needsCards(v1), false, "v1 needs no cards");
  assert.deepEqual(Object.fromEntries(V2_FLAGS.map((f) => [f, loadConfig(V2_ENV)[f]])), Object.fromEntries(V2_FLAGS.map((f) => [f, v2[f]])), "V2_ENV says the defaults explicitly");
  assert.equal(loadConfig(V2_ENV).k, 3);
  for (const [flag, env] of [["scopeFilter", "RECALL_SCOPE_FILTER"], ["queryContext", "RECALL_QUERY_CONTEXT"], ["itemGist", "RECALL_ITEM_GIST"], ["noRepeat", "RECALL_NO_REPEAT"]]) {
    assert.equal(loadConfig({ [env]: "0" })[flag], false, env);
    assert.equal(loadConfig({ [env]: "1" })[flag], true, env);
    assert.ok(CONFIG_KEYS.includes(flag), `${flag} is a config.json key`);
    assert.throws(() => loadConfig({ [env]: "sometimes" }), new RegExp(env));
  }
  for (const key of ["excludeKinds", "repoAliases", "hubMaxSessions", "hubWindowDays"]) assert.ok(CONFIG_KEYS.includes(key), `${key} is a config.json key`);
  assert.ok(!CONFIG_KEYS.includes("directiveOnly"), "directiveOnly is replaced by excludeKinds");
  assert.deepEqual(loadConfig({ RECALL_EXCLUDE_KINDS: "question, status,other" }).excludeKinds, ["question", "status", "other"]);
  assert.deepEqual(loadConfig({ RECALL_EXCLUDE_KINDS: "none" }).excludeKinds, []);
  assert.throws(() => loadConfig({ RECALL_EXCLUDE_KINDS: "question,chitchat" }), /RECALL_EXCLUDE_KINDS.*"chitchat" is not a card kind/);
  assert.throws(() => loadConfig({ RECALL_EXCLUDE_KINDS: "status,status" }), /listed twice/);
  assert.throws(() => loadConfig({ RECALL_HUB_MAX_SESSIONS: "2.5" }), /RECALL_HUB_MAX_SESSIONS/);
  assert.equal(needsCards(loadConfig({ ...V1_ENV, RECALL_ITEM_GIST: "1" })), true);
  assert.equal(needsCards(loadConfig({ ...V1_ENV, RECALL_EXCLUDE_KINDS: "status" })), true, "an excluded kind needs the cards");
  assert.equal(needsCards(loadConfig({ ...V1_ENV, RECALL_QUERY_CONTEXT: "1", RECALL_NO_REPEAT: "1", RECALL_HUB_MAX_SESSIONS: "3" })), false, "context, repeats and hubs need no cards");
});

test("repoAliases: an object of names, from the environment (JSON) or the file; chains, self aliases and non-objects are loud errors", () => {
  assert.deepEqual(loadConfig({ RECALL_REPO_ALIASES: '{"web-app-v2":"web-app","shop-api-old":"shop-api"}' }).repoAliases, { "web-app-v2": "web-app", "shop-api-old": "shop-api" });
  assert.throws(() => loadConfig({ RECALL_REPO_ALIASES: "web-app-v2=web-app" }), /RECALL_REPO_ALIASES.*not JSON/);
  assert.throws(() => loadConfig({ RECALL_REPO_ALIASES: '["a","b"]' }), /must be an object/);
  assert.throws(() => loadConfig({ RECALL_REPO_ALIASES: '{"a":"a"}' }), /maps to itself/);
  assert.throws(() => loadConfig({ RECALL_REPO_ALIASES: '{"a":"b","b":"c"}' }), /alias chain "a" -> "b" -> "c"/);
  assert.throws(() => loadConfig({ RECALL_REPO_ALIASES: '{"a":3}' }), /must map to a non-empty repo name/);
});

// ---- excludeKinds and scopeFilter ----
test("cardAllow: only the excluded kinds are out; a statement said here is eligible whatever its scope, from another repo only a global rule or preference", () => {
  const it = (card, repo = "a") => ({ id: "x", repo, card });
  const both = cardAllow({ excludeKinds: ["question", "status"], scopeFilter: true }, "a");
  assert.equal(both(it({ kind: "rule", scope: "global" }, "zzz")), true, "a global rule: anywhere");
  assert.equal(both(it({ kind: "preference", scope: "global" }, "zzz")), true, "a global preference: anywhere");
  for (const kind of ["correction", "decision", "other"]) assert.equal(both(it({ kind, scope: "global" }, "zzz")), false, `a global ${kind} never crosses repos`);
  for (const kind of ["rule", "preference"]) assert.equal(both(it({ kind, scope: "repo" }, "zzz")), false, `a repo-scoped ${kind} stays in its repo`);
  for (const kind of ["rule", "preference", "decision", "correction", "other"]) for (const scope of ["global", "repo", "unclear"]) assert.equal(both(it({ kind, scope })), true, `${scope} ${kind} said in this repo`);
  assert.equal(both(it({ kind: "other", scope: "global" })), true, "facts and task requests from this repo are eligible");
  assert.equal(both(it({ kind: "question", scope: "global" })), false, "an excluded kind, even a global one in this repo");
  assert.equal(both(it({ kind: "status", scope: "repo" })), false);
  assert.equal(both({ id: "x", repo: "a" }), false, "fail closed: no card");
  assert.equal(both(it({ kind: "rule", scope: "global" }, null)), true, "a global rule with no repo of its own");
  assert.equal(both(it({ kind: "correction", scope: "repo" }, null)), false, "no repo is not this repo");
  const nowhere = cardAllow({ excludeKinds: ["question", "status"], scopeFilter: true }, null);
  assert.equal(nowhere({ id: "x", repo: null, card: { kind: "correction", scope: "repo" } }), false, "no current repo: two nulls are not the same repo");
  assert.equal(nowhere({ id: "x", repo: null, card: { kind: "rule", scope: "global" } }), true);
  assert.equal(cardAllow({ excludeKinds: ["question", "status"], scopeFilter: false }, "a")(it({ kind: "decision", scope: "repo" }, "b")), true, "scope off: any repo");
  assert.equal(cardAllow({ excludeKinds: [], scopeFilter: true }, "a")(it({ kind: "question", scope: "global" })), true, "no excluded kind: any kind");
  assert.equal(cardAllow({ excludeKinds: [], scopeFilter: true }, "a")({ id: "x", repo: "a" }), false, "the scope of a statement with no card is unknown");
  assert.equal(cardAllow({ excludeKinds: [], scopeFilter: false }, "a"), null, "nothing excluded and scope off: no filter at all");
  assert.equal(cardAllow({ excludeKinds: ["other"], scopeFilter: false }, "a")({ id: "x", repo: "a" }), false, "an excluded kind needs the card to know the kind");
});

test("repoAliases make a renamed or sibling repo the same repo for the scope rule, both ways", () => {
  const aliases = { "web-app-v2": "web-app" };
  const allow = cardAllow({ excludeKinds: [], scopeFilter: true, repoAliases: aliases }, "web-app");
  assert.equal(allow({ id: "x", repo: "web-app-v2", card: { kind: "correction", scope: "repo" } }), true, "said in the alias, current is the canonical name");
  assert.equal(cardAllow({ excludeKinds: [], scopeFilter: true, repoAliases: aliases }, "web-app-v2")({ id: "x", repo: "web-app", card: { kind: "decision", scope: "repo" } }), true, "and the other way");
  assert.equal(cardAllow({ excludeKinds: [], scopeFilter: true, repoAliases: {} }, "web-app")({ id: "x", repo: "web-app-v2", card: { kind: "decision", scope: "repo" } }), false, "no alias, no match");
  assert.equal(allow({ id: "x", repo: "shop-api", card: { kind: "decision", scope: "repo" } }), false, "an unrelated repo");
  assert.equal(sameRepo("web-app-v2", "web-app", aliases), true);
  assert.equal(sameRepo(null, null, aliases), false);
  const block = formatCards([{ id: "i", ts: "2026-01-05T00:00:00.000Z", repo: "web-app-v2", text: "t", card: { kind: "decision", scope: "repo", gist: "g" } }], "web-app", aliases);
  assert.ok(block.includes("Decision, this repo (web-app-v2)"), "the card says this repo for an alias too");
});

test("retrieval only ever sees eligible statements: kinds that may be said, in the current repo or global rules and preferences (cards attached to the corpus)", async () => {
  const s = await setup({ env: { RECALL_ITEM_GIST: "0" } });
  assert.equal(s.cards(), 6, "six of the seven have a card");
  assert.deepEqual(idsOf(await ranked(s, { currentRepo: "billing-api" })), ["g1", "pf", "r1", "u1"], "global rules and preferences + this repo's statements; not another repo's, not a question, not a statement without a card");
  assert.deepEqual(idsOf(await ranked(s, { currentRepo: "payments" })), ["g1", "pf", "r2"]);
  assert.deepEqual(idsOf(await ranked(s, { currentRepo: null })), ["g1", "pf"], "cwd outside any repo: only what holds everywhere");
  // the flags separately
  const noScope = loadConfig({ ...V2_ENV, RECALL_DATA: s.dataDir, RECALL_SCOPE_FILTER: "0", RECALL_ITEM_GIST: "0" });
  assert.deepEqual(idsOf(await ranked(s, { currentRepo: "billing-api", cfg: noScope })), ["g1", "pf", "r1", "r2", "u1"], "scope off: every kind that may be said");
  const noExclusion = loadConfig({ ...V2_ENV, RECALL_DATA: s.dataDir, RECALL_EXCLUDE_KINDS: "none", RECALL_ITEM_GIST: "0" });
  assert.deepEqual(idsOf(await ranked(s, { currentRepo: "billing-api", cfg: noExclusion })), ["g1", "pf", "q1", "r1", "u1"], "no excluded kind: any kind, still scoped, still needs a card");
  const v1 = loadConfig({ ...V1_ENV, RECALL_DATA: s.dataDir });
  assert.deepEqual(idsOf(await ranked(s, { currentRepo: "billing-api", cfg: v1 })), [...ALL].sort(), "v1: everything, cards or not");
});

test("the injection decision is made on the eligible set too: a statement with no card or from another repo never reaches the block", async () => {
  const s = await setup();
  s.cards();
  const res = await ranked(s, { currentRepo: "billing-api" });
  const { picked, context } = selectInjection({ ranked: res.ranked, corpus: s.corpus, pipeline: "default", cfg: s.config, currentRepo: "billing-api" });
  assert.deepEqual(picked.map((e) => e.id).sort(), ["g1", "pf", "r1", "u1"]);
  assert.ok(!context.includes("Never push in this repo") && !context.includes("no card at all") && !context.includes("why did the fallback"));
});

// ---- v1 reproduced exactly ----
test("every flag at its v1 value is v1: the same ranking with or without cards, the v1 questions and situation, the v1 block", async () => {
  const s = await setup({ env: V1_ENV });
  const without = await ranked(s);
  s.fake.calls.length = 0;
  s.cards();
  const questionsWithoutCache = new Set();
  const withCards = await ranked(s, { deps: createRuntime(loadConfig({ ...V1_ENV, RECALL_DATA: tmpDir("recall-v1b"), RECALL_DAILY_CAP_USD: "5" }), { post: s.fake.post }).makeDeps({ stats: {} }) });
  assert.deepEqual(withCards.ranked, without.ranked, "attached cards change nothing under v1");
  assert.equal(withCards.eligible, ALL.length);
  // what the judge was asked: x1's line, no gist, the v1 situation
  const bodies = decisionBodies(s.fake);
  assert.ok(bodies.length >= 1);
  for (const body of bodies) {
    assert.equal(body.input, promptSituation(PROMPT));
    for (const q of body.questions) {
      assert.match(q.instructions, /^Past owner statement: ".*"\n/s);
      assert.ok(q.instructions.endsWith(GENERIC_TEXT));
      assert.ok(!q.instructions.includes("said while"));
      questionsWithoutCache.add(q.instructions);
    }
  }
  assert.equal(questionsWithoutCache.size, ALL.length);
  // the block: the gate, then one entry per text, then the top 5, in v1's format
  const expected = dedupeRanked(gated("default", withCards.ranked, s.config, Infinity), (e) => s.corpus.items[s.corpus.byId.get(e.id)].text).slice(0, 5);
  assert.equal(s.config.k, 5);
  const { picked, context, repeats } = selectInjection({ ranked: withCards.ranked, corpus: s.corpus, pipeline: "default", cfg: s.config, sessionId: "sess", prior: { ids: new Set(["g1"]), keys: new Set() } });
  assert.deepEqual(picked.map((e) => e.id), expected.map((e) => e.id), "a prior record changes nothing when noRepeat is off");
  assert.deepEqual(repeats, []);
  assert.equal(context, formatInjection(expected.map((e) => s.corpus.items[s.corpus.byId.get(e.id)]), "sess"));
  assert.ok(context.includes(CONTEXT_HEADER) && /- 2026-09-0\d \(repo: /.test(context));
});

// ---- itemGist ----
test("itemGist (opt in): every judged statement is shown with what was going on when it was said; chunk nodes are unchanged", async () => {
  const s = await setup({ env: { RECALL_ITEM_GIST: "1" } });
  s.cards();
  await ranked(s, { currentRepo: "billing-api" });
  const want = new Map(ROWS.filter((r) => r.card).map((r) => [r.id, `Past owner statement (said while ${r.card.gist}): "${r.text}"\n${GENERIC_TEXT}`]));
  const asked = decisionBodies(s.fake).flatMap((b) => b.questions.map((q) => q.instructions));
  for (const id of ["g1", "pf", "r1", "u1"]) assert.ok(asked.includes(want.get(id)), `${id}: ${want.get(id)}`);
  assert.ok(asked.every((q) => q.includes("(said while ")), "no question without a gist");
  assert.equal(itemLine({ text: "x", card: { gist: "g" } }, { itemGist: true }), 'Past owner statement (said while g): "x"');
  assert.equal(itemLine({ text: "x" }, { itemGist: false }), 'Past owner statement: "x"');
  assert.throws(() => itemLine({ id: "n1", text: "x" }, { itemGist: true }), /itemGist needs a card for statement n1/);
  // the clip is x1's 260 characters
  const long = itemLine({ text: "w".repeat(400), card: { gist: "g" } }, { itemGist: true });
  assert.equal(long, `Past owner statement (said while g): "${"w".repeat(260)} [...]"`);
});

test("itemGist covers the listwise options (compose-lean) and leaves the session-chunk nodes unchanged", async () => {
  const s = await setup({ env: { RECALL_ITEM_GIST: "1" }, api: { decide: () => 0.9 } });
  s.cards();
  const res = await retrieve({ corpus: s.corpus, query: PROMPT, mode: "prompt", decisionTs: "2026-10-07T12:00:00Z", currentRepo: "billing-api", pipeline: "compose-lean", deps: s.runtime.makeDeps({ stats: {} }), cfg: s.config, stats: {} });
  assert.deepEqual(idsOf(res), ["g1", "pf", "r1", "u1"]);
  const choices = decisionBodies(s.fake).flatMap((b) => b.questions.filter((q) => q.type === "choice").flatMap((q) => q.choices.map((c) => c.description)));
  assert.equal(choices.length, 8, "two orders of four options");
  const byGist = new Map(ROWS.filter((r) => r.card).map((r) => [r.id, `Past owner statement (said while ${r.card.gist}): "${r.text}"`]));
  for (const id of ["g1", "pf", "r1", "u1"]) assert.ok(choices.includes(byGist.get(id)), `${id} option carries its gist`);
  const nodes = decisionBodies(s.fake).flatMap((b) => b.questions.filter((q) => q.instructions?.endsWith(SESSION_PREDICATE)).map((q) => q.instructions));
  assert.ok(nodes.length >= 1);
  for (const n of nodes) assert.ok(!n.includes("said while") && n.startsWith("Past owner statements from one earlier conversation:\n"), "chunk nodes are the v1 text");
  // and v1 listwise options are the bare clipped text
  const v1 = await setup({ env: V1_ENV, api: { decide: () => 0.9 } });
  await retrieve({ corpus: v1.corpus, query: PROMPT, mode: "prompt", decisionTs: "2026-10-07T12:00:00Z", pipeline: "compose-lean", deps: v1.runtime.makeDeps({ stats: {} }), cfg: v1.config, stats: {} });
  const bare = decisionBodies(v1.fake).flatMap((b) => b.questions.filter((q) => q.type === "choice").flatMap((q) => q.choices.map((c) => c.description)));
  assert.ok(bare.includes(ROWS[0].text) && bare.every((d) => !d.includes("Past owner statement")));
});

// ---- queryContext ----
test("the v2 situation: project, the earlier owner message, the last assistant reply, then the new message; a missing part is left out", () => {
  const words = (c, n) => `${(`${c} `).repeat(n)}`.trim();
  const [o, a, m] = [words("o", 200), words("a", 450), words("m", 850)];
  const full = contextSituation({ project: "billing-api", prevOwner: o, assistant: a, ownerText: m });
  assert.equal(full, `${STOP_HEAD}\n\nPROJECT: billing-api\n\nOWNER (earlier): ${clip(o, 300)}\n\nASSISTANT: ${clip(a, 400)}\n\nOWNER (latest message, before the agent has acted): ${clip(m, 1500)}`);
  assert.ok(clip(a, 400).length <= 406 && clip(a, 400).endsWith("[...]"), "the reply is cut at 400 characters");
  assert.equal(contextSituation({ project: null, ownerText: "hello there" }), `${STOP_HEAD}\n\nOWNER (latest message, before the agent has acted): hello there`);
  assert.equal(contextSituation({ project: "p", prevOwner: "earlier", ownerText: "now" }), `${STOP_HEAD}\n\nPROJECT: p\n\nOWNER (earlier): earlier\n\nOWNER (latest message, before the agent has acted): now`);
});

test("priorContext: the last reply and the owner message before it; a trailing copy of the new prompt is not 'earlier'", () => {
  const turns = [{ role: "user", text: "first" }, { role: "assistant", text: "reply one" }, { role: "user", text: "second" }, { role: "assistant", text: "reply two" }];
  assert.deepEqual(priorContext(turns, "the new prompt"), { prevOwner: "second", assistant: "reply two" });
  assert.deepEqual(priorContext([...turns, { role: "user", text: "the  new\nprompt" }], "the new prompt"), { prevOwner: "second", assistant: "reply two" }, "the host already wrote the prompt");
  assert.deepEqual(priorContext([], "x"), { prevOwner: null, assistant: null });
});

const OWNER_EARLIER = "Please look at why the draft runs are duplicated.";
const REPLY = "The duplicates come from a re-execution path in the worker. Want me to remove it or guard it?";

test("queryContext, Claude: the situation sent to the judge is read from the transcript's tail (real records), with the project of the cwd", async () => {
  const s = await setup({ env: { RECALL_ITEM_GIST: "0" } });
  const cwd = repoDir("billing-api");
  const transcript = writeTranscript("session.jsonl", [claudeUser(OWNER_EARLIER), claudeToolUse(), claudeToolResult(), claudeAssistant("Looking."), claudeToolUse(), claudeToolResult(), claudeAssistant(REPLY)]);
  const out = await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT, transcript_path: transcript, cwd }), config: s.config, runtime: s.runtime, now: NOW });
  assert.ok(JSON.parse(out.stdout).hookSpecificOutput);
  const expected = `${STOP_HEAD}\n\nPROJECT: billing-api\n\nOWNER (earlier): ${OWNER_EARLIER}\n\nASSISTANT: ${REPLY}\n\nOWNER (latest message, before the agent has acted): ${PROMPT}`;
  const [line] = logLines(s.dataDir);
  assert.equal(line.situation, expected);
  assert.equal(line.repo, "billing-api");
  assert.ok(decisionBodies(s.fake).every((b) => b.input === expected), "the judge got exactly that situation");
  assert.equal(s.fake.calls.find((c) => c.pathname === "/v1/embeddings").body.input[0], expected, "and so did the embedding");
});

test("queryContext, Codex: the same from rollout events; the first prompt of a session (no transcript yet) has only the project and the message; the prompt already in the transcript is not 'earlier'", async () => {
  const s = await setup({ env: { RECALL_ITEM_GIST: "0" } });
  const cwd = repoDir("billing-api");
  const rollout = writeTranscript("rollout-2026-10-07T10-00-00-0000.jsonl", [codexUser(OWNER_EARLIER), codexCommand(), codexAgent(REPLY), codexUser(PROMPT)]);
  await handlePrompt({ input: hookInput("codex-prompt.json", { prompt: PROMPT, transcript_path: rollout, cwd, session_id: "codex-sess" }), config: s.config, runtime: s.runtime, now: NOW });
  const first = `${STOP_HEAD}\n\nPROJECT: billing-api\n\nOWNER (earlier): ${OWNER_EARLIER}\n\nASSISTANT: ${REPLY}\n\nOWNER (latest message, before the agent has acted): ${PROMPT}`;
  assert.equal(logLines(s.dataDir).at(-1).situation, first);
  // a Claude session's first prompt: its transcript does not exist yet
  await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT, transcript_path: path.join(tmpDir(), "not-yet.jsonl"), cwd, session_id: "fresh" }), config: s.config, runtime: s.runtime, now: NOW });
  assert.equal(logLines(s.dataDir).at(-1).situation, `${STOP_HEAD}\n\nPROJECT: billing-api\n\nOWNER (latest message, before the agent has acted): ${PROMPT}`);
  // Codex without a rollout (--ephemeral) and a cwd outside any repository: the project is the directory's name
  const plain = path.join(tmpDir("recall-plain"), "scratchdir");
  fs.mkdirSync(plain);
  await handlePrompt({ input: hookInput("codex-prompt.json", { prompt: PROMPT, transcript_path: null, cwd: plain, session_id: "eph" }), config: s.config, runtime: s.runtime, now: NOW });
  assert.equal(logLines(s.dataDir).at(-1).situation, `${STOP_HEAD}\n\nPROJECT: scratchdir\n\nOWNER (latest message, before the agent has acted): ${PROMPT}`);
});

test("queryContext: the reply's code, tool output and links stay out of the situation the judge and the embedding get", async () => {
  const s = await setup({ env: { RECALL_ITEM_GIST: "0" } });
  const noisy = `${REPLY}\n\n\`\`\`\nGET /api/runs 200 OK\n\`\`\`\n\nOpen [the lab](http://127.0.0.1:4173/dev/lab?runId=0f3c2d1e-5b7a-4c68-9e21-7d4a8b6c1f35) to see it.`;
  const transcript = writeTranscript("noisy.jsonl", [claudeUser(OWNER_EARLIER), claudeAssistant(noisy)]);
  await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT, transcript_path: transcript, cwd: repoDir("billing-api") }), config: s.config, runtime: s.runtime, now: NOW });
  const [line] = logLines(s.dataDir);
  assert.equal(line.situation, `${STOP_HEAD}\n\nPROJECT: billing-api\n\nOWNER (earlier): ${OWNER_EARLIER}\n\nASSISTANT: ${REPLY}\n\nOpen the lab to see it.\n\nOWNER (latest message, before the agent has acted): ${PROMPT}`);
  assert.ok(decisionBodies(s.fake).every((b) => b.input === line.situation && !b.input.includes("http") && !b.input.includes("GET /api")));
});

test("queryContext off: the v1 situation, whatever the transcript holds", async () => {
  const s = await setup({ env: { RECALL_QUERY_CONTEXT: "0", RECALL_ITEM_GIST: "0" } });
  const transcript = writeTranscript("session.jsonl", [claudeUser(OWNER_EARLIER), claudeAssistant(REPLY)]);
  await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT, transcript_path: transcript, cwd: repoDir("billing-api") }), config: s.config, runtime: s.runtime, now: NOW });
  assert.equal(logLines(s.dataDir)[0].situation, promptSituation(PROMPT));
  assert.deepEqual(conversationTurns({ host: "claude", file: transcript }).map((t) => t.role), ["user", "assistant"]);
});

// ---- the hook: scope, repeats, format ----
test("the hook takes the current repo from the payload's cwd: another repo's directive never reaches the agent", async () => {
  const s = await setup({ env: { RECALL_K: "10" } });
  const at = async (cwd, session) => {
    const out = JSON.parse((await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT, cwd, session_id: session }), config: s.config, runtime: s.runtime, now: NOW })).stdout);
    return logLines(s.dataDir).at(-1);
  };
  const here = await at(repoDir("billing-api"), "s-here");
  assert.deepEqual(here.injected.sort(), ["g1", "pf", "r1", "u1"]);
  assert.ok(here.context.includes("this repo (billing-api)") && !here.context.includes("Never push in this repo"));
  const charge = await at(repoDir("payments"), "s-charge");
  assert.deepEqual(charge.injected.sort(), ["g1", "pf", "r2"]);
  assert.ok(charge.context.includes("Never push in this repo"), "the same statement is injected where it was said");
  const nowhere = await at(path.join(tmpDir("recall-nowhere")), "s-none");
  assert.deepEqual(nowhere.injected.sort(), ["g1", "pf"], "outside a repository only global statements");
});

test("noRepeat: a statement injected earlier in a session is never injected again; the slot goes to the next one; a new session starts over", async () => {
  const s = await setup({ env: { RECALL_K: "2" } });
  const cwd = repoDir("billing-api");
  const turn = async (session = "sess-A") => {
    await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT, cwd, session_id: session }), config: s.config, runtime: s.runtime, now: NOW });
    return logLines(s.dataDir).at(-1);
  };
  const t1 = await turn();
  const t2 = await turn();
  const t3 = await turn();
  const t4 = await turn();
  assert.equal(t1.injected.length, 2);
  assert.equal(t2.injected.length, 2);
  assert.equal(t3.injected.length, 0, "all four eligible directives have been said (k 2, 4 eligible: the third turn has nothing new)");
  assert.deepEqual([t1.injected, t2.injected].flat().sort(), ["g1", "pf", "r1", "u1"]);
  assert.equal(new Set([...t1.injected, ...t2.injected]).size, 4, "no statement twice");
  assert.deepEqual([t2.repeats?.length, t3.repeats?.length, t4.reason], [2, 4, "nothing-above-threshold"], "the repeats the gate would have let through are logged");
  assert.deepEqual(createTurnState(s.dataDir).read("sess-A").injected.sort(), ["g1", "pf", "r1", "u1"]);
  const other = await turn("sess-B");
  assert.deepEqual(other.injected, t1.injected, "another session is told again");
  // off: the same two every time
  const off = await setup({ env: { RECALL_K: "2", RECALL_NO_REPEAT: "0" } });
  const a = [];
  for (let i = 0; i < 3; i++) {
    await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT, cwd, session_id: "sess-C" }), config: off.config, runtime: off.runtime, now: NOW });
    a.push(logLines(off.dataDir).at(-1).injected);
  }
  assert.deepEqual(a[1], a[0]);
  assert.deepEqual(a[2], a[0]);
  // a copy of an injected text (another id, same words) counts as injected too
  const dup = await setup({ rows: [...ROWS, { id: "g1copy", ts: T(8), repo: "shared-lib", text: ROWS[0].text, card: ROWS[0].card }], env: { RECALL_K: "10" } });
  await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT, cwd, session_id: "sess-D" }), config: dup.config, runtime: dup.runtime, now: NOW });
  const first = logLines(dup.dataDir).at(-1);
  assert.equal(first.injected.filter((id) => id.startsWith("g1")).length, 1, "one of the two copies");
});

test("the injected block is the card format, exactly", async () => {
  const s = await setup({ env: { RECALL_K: "2" } });
  const out = await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT, cwd: repoDir("billing-api") }), config: s.config, runtime: s.runtime, now: NOW });
  const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  const [line] = logLines(s.dataDir);
  assert.equal(line.context, ctx);
  const text = (id) => ROWS.find((r) => r.id === id);
  const bullet = (r, who) => `• ${r.card.kind[0].toUpperCase()}${r.card.kind.slice(1)}, ${who} (said ${Number(r.ts.slice(8, 10))} Sep, ${r.card.gist}):\n  "${r.text}"`;
  const scopeOf = (r) => (r.card.scope === "global" ? "all projects" : `this repo (${r.repo})`);
  const expected = ["<recall-context>", CARD_HEADER, ...line.injected.map((id) => bullet(text(id), scopeOf(text(id)))), "</recall-context>"].join("\n");
  assert.equal(ctx, expected);
  assert.equal(CARD_HEADER, "From your earlier conversations (Recall). Apply if relevant; no need to mention them.");
  assert.ok(line.candidates.every((c) => c.kind && c.scope && c.gist), "the log's candidates carry kind, scope and gist for the monitor");
  assert.equal(line.cards, 6);
});

test("the block's format follows the card filter: typed cards when every injectable statement has a card, v1's dated quotes otherwise", async () => {
  const cwd = repoDir("billing-api");
  const block = async (env) => {
    const s = await setup({ env: { RECALL_K: "2", ...env } });
    await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT, cwd }), config: s.config, runtime: s.runtime, now: NOW });
    return logLines(s.dataDir)[0].context;
  };
  assert.ok((await block({})).includes(CARD_HEADER));
  const quotes = await block({ RECALL_EXCLUDE_KINDS: "none", RECALL_SCOPE_FILTER: "0" });
  assert.ok(quotes.includes(CONTEXT_HEADER) && !quotes.includes(CARD_HEADER), "no card filter: the v1 block, whatever the other settings say");
  assert.match(quotes, /- 2026-09-0\d \(repo: /);
  // every setting at its v1 value: v1's block
  assert.ok((await block({ ...V1_ENV })).includes(CONTEXT_HEADER));
});

test("formatCards: kind and scope wording, the date as D Mon, the statement clipped to 300", () => {
  const item = (card, over = {}) => ({ id: "i", ts: "2026-01-05T23:59:59.000Z", repo: "myrepo", text: "T ".repeat(200), card, ...over });
  const block = formatCards([item({ kind: "rule", scope: "global", gist: "g1" }), item({ kind: "decision", scope: "repo", gist: "g2" }), item({ kind: "correction", scope: "unclear", gist: "g3" }, { ts: "2026-12-31T00:00:00.000Z" })], "myrepo");
  const lines = block.split("\n");
  assert.equal(lines[2], "• Rule, all projects (said 5 Jan, g1):");
  assert.equal(lines[4], "• Decision, this repo (myrepo) (said 5 Jan, g2):");
  assert.equal(lines[6], "• Correction, this repo (myrepo) (said 31 Dec, g3):");
  assert.equal(lines[3], `  "${"T ".repeat(150).trimEnd()} [...]"`, "the first 300 characters of the text, as clip() cuts them");
  const fact = formatCards([item({ kind: "other", scope: "repo", gist: "g4" }), item({ kind: "preference", scope: "global", gist: "g5" })], "myrepo").split("\n");
  assert.equal(fact[2], "• Fact/task, this repo (myrepo) (said 5 Jan, g4):", "kind other is labelled for what it is: a fact or a task request");
  assert.equal(fact[4], "• Preference, all projects (said 5 Jan, g5):");
  assert.equal(formatCards([], "x"), null);
  assert.throws(() => formatCards([{ id: "n", ts: AT, text: "t" }]), /cannot render statement n as a card/);
});

test("without cards (the first deploy, before `recall enrich` has run) v2 is silent and says so loudly, and asks for the background pass", async () => {
  const s = await setup({ rows: ROWS.map(({ card, ...r }) => r) });
  const out = await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT }), config: s.config, runtime: s.runtime, now: NOW });
  assert.deepEqual(JSON.parse(out.stdout), { continue: true });
  const [line] = logLines(s.dataDir);
  assert.deepEqual([line.level, line.outcome, line.reason], ["error", "silent", "no-cards"]);
  assert.match(line.error, /has no cards for the 7 indexed statements; run: recall enrich/);
  assert.equal(s.fake.calls.length, 0, "no embedding, no Decisions call");
  // v1 flags need none
  const v1 = await setup({ rows: ROWS.map(({ card, ...r }) => r), env: V1_ENV });
  const out1 = await handlePrompt({ input: hookInput("claude-prompt.json", { prompt: PROMPT }), config: v1.config, runtime: v1.runtime, now: NOW });
  assert.match(JSON.parse(out1.stdout).hookSpecificOutput.additionalContext, /Possibly relevant things/);
});
