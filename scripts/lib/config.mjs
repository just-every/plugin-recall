// Configuration, three layers, first one set wins: the environment (RECALL_*), then an optional JSON file <dataDir>/config.json
// (camelCase keys = the field names below), then the built-in default. The file exists because the Claude Code and Codex desktop apps do not
// pass your shell environment to hook processes, so a setting like the daily cap could not otherwise be changed for live use.
// An invalid value, in either layer, throws a ConfigError (loud): it is never replaced by a default or ignored. The hooks catch it, log it
// and stay silent. The file is read on every call (it is small); nothing is cached. See README.md for the table.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KINDS } from "./cards/schema.mjs";
import { SPEC } from "./pipelines/spec.mjs";

export const CONFIG_FILE_NAME = "config.json";

/** Every invalid configuration (environment variable or config.json) is one of these; hooks log it instead of crashing. */
export class ConfigError extends Error {
  constructor(message) { super(message); this.name = "ConfigError"; }
}

/**
 * The plugin's data directory. RECALL_DATA wins; otherwise ONE directory, ~/.plugin-recall, shared by every installed home and host
 * (Claude Code, Codex, Every Code, every CLAUDE_CONFIG_DIR / CODEX_HOME): one index, one embedding store, one ledger, one daily cap, one
 * turn log. The host's own plugin data dir (CLAUDE_PLUGIN_DATA, PLUGIN_DATA) is deliberately not used: it is per home.
 */
export function resolveDataDir(env = process.env) {
  return path.resolve(env.RECALL_DATA || path.join(env.HOME || os.homedir(), ".plugin-recall"));
}

// One row per setting: [field, environment variable, default, type, options]. Types: bool, num, str, enum, numOrNull (null = no cap),
// kinds (a list of card kinds: comma separated in the environment, "none" for the empty list; a JSON array in the file), aliasMap (a JSON
// object of repo name -> repo name), list (a list of strings: comma separated in the environment, or separated by opts.sep, or a JSON array
// when opts.json; a JSON array in the file; opts.allowed limits the values, opts.check validates each one), homeList (paths and {path, kind}
// objects: paths separated by opts.sep or a JSON array in the environment; a JSON array in the file).
// Not settable from the file: dataDir (it locates the file) and child (the plugin's own worker marker, environment only).
const FIELDS = [
  ["disabled", "RECALL_DISABLED", false, "bool"],
  // Hooks are silent in non-interactive sessions (claude -p, the Agent SDK, codex exec, Every Code exec, internal memory agents) and in
  // sessions the plugin cannot classify. This switch re-enables them for a deliberate smoke test.
  ["allowHeadless", "RECALL_ALLOW_HEADLESS", false, "bool"],
  // OpenAI endpoint root (a proxy, or a local server in the test suite); the key is still sent as a bearer token.
  ["openaiBaseUrl", "RECALL_OPENAI_BASE_URL", "https://api.openai.com", "str", { post: (v) => v.replace(/\/+$/, "") }],
  // retrieval
  // UserPromptSubmit injection and `recall query`: the tuned default pipeline stays here (compose-lean missed the synchronous cost bar).
  ["pipeline", "RECALL_PIPELINE", "default", "str"],
  // v2 injects fewer cards (3). v1 injected up to 5.
  ["k", "RECALL_K", 3, "num", { min: 1, max: 20, integer: true }],
  // A statement is injected only if its D-generic probability is at least this: the tuned prompt-time tau 0.95 (embeddings pipeline: cosine,
  // see embThreshold).
  ["promptThreshold", "RECALL_PROMPT_THRESHOLD", SPEC.injectPromptTau, "num", { min: 0, max: 1 }],
  ["embThreshold", "RECALL_EMB_THRESHOLD", 0.35, "num", { min: -1, max: 1 }],
  ["minChars", "RECALL_MIN_CHARS", 20, "num", { min: 1, integer: true }],
  // Who "you" are, for the two text rules that need to tell you from somebody else. Both empty by default, and those rules then do nothing.
  // ownerEmails: the addresses that are not "third-party data" (a statement with any other email address is not indexed).
  // ownerNames: the sender names an agent-delivered message may carry as yours (see filterProfiles "fleet"); another sender is not you.
  ["ownerEmails", "RECALL_OWNER_EMAILS", Object.freeze([]), "list", { check: (v) => /^[^\s@]+@[^\s@]+$/.test(v) || `${JSON.stringify(v)} is not an email address` }],
  ["ownerNames", "RECALL_OWNER_NAMES", Object.freeze([]), "list", { check: (v) => v.trim() !== "" || "a name is empty" }],
  // Extra text filters, off by default. filterProfiles names built-in sets ("fleet": the turns that agent orchestration tooling writes into
  // a transcript as if you had typed them: task and review briefs, relays, dispatch headers, probes). dropPatterns is a list of regular
  // expressions (case-insensitive): a typed turn that matches one is not indexed.
  ["filterProfiles", "RECALL_FILTER_PROFILES", Object.freeze([]), "list", { allowed: ["fleet"] }],
  ["dropPatterns", "RECALL_DROP_PATTERNS", Object.freeze([]), "list", { json: true, check: (v) => { try { new RegExp(v, "i"); return true; } catch (e) { return `${JSON.stringify(v)} is not a regular expression (${e.message})`; } } }],
  // v2 behaviour flags (docs/cards-prompt.md, README "v2"). Each one set to its v1 value (see V1_ENV: k 5) reproduces v1 exactly.
  // A statement whose card is one of these kinds is never injected; every other kind is eligible (rule, preference, decision, correction and
  // other: facts and task requests). A statement without a card is not eligible. With the card filter on the injection is a block of typed
  // cards (kind, scope, date, gist) instead of v1's bare dated quotes. Environment: comma separated, "none" for an empty list.
  ["excludeKinds", "RECALL_EXCLUDE_KINDS", Object.freeze(["question", "status"]), "kinds"],
  // A statement said in the current repo is eligible whatever its card scope; one said in another repo (or in no repo) only if its card scope is
  // global AND its kind is rule or preference. Corrections, decisions and other kinds never cross repos.
  ["scopeFilter", "RECALL_SCOPE_FILTER", true, "bool"],
  // Renamed or sibling repos that count as the same repo, {"old-or-sibling-name": "canonical-name"}: a statement said in either is "in this
  // repo" for the other. Applied to the scope rule only. Empty by default; chains (a value that is also a key) are an error.
  ["repoAliases", "RECALL_REPO_ALIASES", Object.freeze({}), "aliasMap"],
  // The precision rules (cards/precision.mjs): four more eligibility rules, applied beside excludeKinds and scopeFilter before ranking, so the
  // next eligible statement takes the slot of one they keep out. A live audit found 38% of injected cards misleading; offline these four cut the
  // messages carrying a misleading card by 10.2 points and left the share with a useful card unchanged. Each is switched off on its own. They
  // narrow the card filter: with excludeKinds empty and scopeFilter off there is no card filter, and so no precision rule either (v1).
  // excludeNewSessionGist: a card whose gist is the new-session placeholder (gist_source "none": a session-opening task brief) is not eligible.
  ["excludeNewSessionGist", "RECALL_EXCLUDE_NEW_SESSION_GIST", true, "bool"],
  // excludeCitations: a statement that cites a URL, a local port or a file path is not eligible.
  ["excludeCitations", "RECALL_EXCLUDE_CITATIONS", true, "bool"],
  // crossRepoMaxChars: a statement said in another repo is not eligible at this many characters or more. 0 = off.
  ["crossRepoMaxChars", "RECALL_CROSS_REPO_MAX_CHARS", 300, "num", { min: 0, integer: true }],
  // ruleMaxChars: a rule or a preference is not eligible at this many characters or more (in any repo). 0 = off.
  ["ruleMaxChars", "RECALL_RULE_MAX_CHARS", 500, "num", { min: 0, integer: true }],
  // The prompt-time situation carries the project, the previous owner message and the last assistant reply, read from the transcript.
  ["queryContext", "RECALL_QUERY_CONTEXT", true, "bool"],
  // Every judged statement is shown to the judge with the gist of what was going on when it was said. Off by default: measured, no benefit.
  // (The gist is still shown to the agent in the injected card.)
  ["itemGist", "RECALL_ITEM_GIST", false, "bool"],
  // A statement injected earlier in a session is never injected again in that session.
  ["noRepeat", "RECALL_NO_REPEAT", true, "bool"],
  // A statement already injected into at least hubMaxSessions distinct OTHER sessions within the last hubWindowDays days is not injected
  // again (a hub: a generic statement said into everything). 0 = off.
  ["hubMaxSessions", "RECALL_HUB_MAX_SESSIONS", 3, "num", { min: 0, integer: true }],
  ["hubWindowDays", "RECALL_HUB_WINDOW_DAYS", 14, "num", { min: 1 }],
  // The apply gate (apply-gate.mjs): after D-generic and every eligibility rule, one more Decisions question per surviving statement asks whether it
  // applies to the task the assistant is doing now, not just the same topic. The survivors are reranked by that probability and the first k at
  // applyThreshold or more are injected; a refused or unanswered question cannot pass. Off: the survivors in their fused order, as before the gate.
  ["applyGate", "RECALL_APPLY_GATE", true, "bool"],
  ["applyThreshold", "RECALL_APPLY_THRESHOLD", 0.2, "num", { min: 0, max: 1 }],
  // budgets
  ["timeoutMs", "RECALL_TIMEOUT_MS", 20000, "num", { min: 1000, integer: true }],
  ["dailyCapUsd", "RECALL_DAILY_CAP_USD", 1.0, "num", { min: 0 }],
  // A cap on the whole ledger total of the data dir (every request ever recorded there), not per day. null = none.
  ["totalCapUsd", "RECALL_TOTAL_CAP_USD", null, "numOrNull", { min: 0 }],
  ["noCache", "RECALL_NO_CACHE", false, "bool"],
  // indexing
  ["autoIndex", "RECALL_AUTO_INDEX", true, "bool"],
  ["autoIndexMinutes", "RECALL_AUTO_INDEX_MINUTES", 30, "num", { min: 1 }],
  // Agent homes to read, in addition to the standard ones (~/.claude, ~/.codex, $CLAUDE_CONFIG_DIR, $CODEX_HOME, ~/.code when present).
  // An entry is a path (a home like the standard ones: its kind comes from its name, and with usageCmd a worker may run in it) or
  // {path, kind} (kind claude, codex or code): a home read for indexing only, such as a backup, a copy from another machine or an account no
  // worker may use. The router never picks one. Environment: paths separated by the path delimiter (":" on macOS and Linux), or a JSON array.
  ["homes", "RECALL_HOMES", Object.freeze([]), "homeList", { sep: path.delimiter }],
  // Optional fleet roster: a .json array (or a .mjs module exporting CONTROL_USAGE_HOMES) of {id, kind, home, protected, manual}. When set it
  // replaces the standard homes for reading, and only entries with protected:false and manual:false may run a worker. Off by default.
  ["homesRoster", "RECALL_HOMES_ROSTER", "", "str"],
  // CLI worker routing. By default a worker runs under the current host's own home; claudeHome / codexHome pin another one; usageCmd turns on
  // usage-based choice among the candidate homes (a command that prints `--json` usage, see README "Home routing").
  ["claudeHome", "RECALL_CLAUDE_HOME", "", "str"],
  ["codexHome", "RECALL_CODEX_HOME", "", "str"],
  ["usageCmd", "RECALL_USAGE_CMD", "", "str"],
  ["usageTtlMs", "RECALL_USAGE_TTL_MS", 120000, "num", { min: 0, integer: true }],
  ["usageMaxPercent", "RECALL_USAGE_MAX_PERCENT", 90, "num", { min: 1, max: 100 }],
  ["workerTimeoutMs", "RECALL_WORKER_TIMEOUT_MS", 120000, "num", { min: 1000, integer: true }],
];

/** The behaviour settings of v2 that a log line records with their sources. */
export const V2_FLAGS = Object.freeze(["excludeKinds", "scopeFilter", "queryContext", "itemGist", "noRepeat", "hubMaxSessions"]);
/** The precision rules' settings (cards/precision.mjs), which a log line records with their sources beside the v2 flags. */
export const PRECISION_FLAGS = Object.freeze(["excludeNewSessionGist", "excludeCitations", "crossRepoMaxChars", "ruleMaxChars"]);
/** The apply gate's settings, which a log line records with their sources. */
export const APPLY_FLAGS = Object.freeze(["applyGate", "applyThreshold"]);
/** The environment that switches the four precision rules off. */
export const PRECISION_OFF_ENV = Object.freeze({ RECALL_EXCLUDE_NEW_SESSION_GIST: "0", RECALL_EXCLUDE_CITATIONS: "0", RECALL_CROSS_REPO_MAX_CHARS: "0", RECALL_RULE_MAX_CHARS: "0" });

/** The environment that switches every v2 setting, the precision rules and the apply gate off and k back to 5: v1 behaviour exactly. */
export const V1_ENV = Object.freeze({ RECALL_EXCLUDE_KINDS: "none", RECALL_SCOPE_FILTER: "0", RECALL_QUERY_CONTEXT: "0", RECALL_ITEM_GIST: "0", RECALL_NO_REPEAT: "0", RECALL_HUB_MAX_SESSIONS: "0", RECALL_K: "5", RECALL_APPLY_GATE: "0", ...PRECISION_OFF_ENV });

/** The environment that sets every v2.1 setting and the precision rules to their defaults explicitly (over a config.json that says otherwise). */
export const V2_ENV = Object.freeze({ RECALL_EXCLUDE_KINDS: "question,status", RECALL_SCOPE_FILTER: "1", RECALL_QUERY_CONTEXT: "1", RECALL_ITEM_GIST: "0", RECALL_NO_REPEAT: "1", RECALL_HUB_MAX_SESSIONS: "3", RECALL_HUB_WINDOW_DAYS: "14", RECALL_K: "3", RECALL_EXCLUDE_NEW_SESSION_GIST: "1", RECALL_EXCLUDE_CITATIONS: "1", RECALL_CROSS_REPO_MAX_CHARS: "300", RECALL_RULE_MAX_CHARS: "500", RECALL_APPLY_GATE: "1", RECALL_APPLY_THRESHOLD: "0.2" });

/** Does the configuration filter on the statement cards (every injectable statement then has a card, and the block is typed cards)? */
export const cardFilterOn = (config) => config.excludeKinds.length > 0 || config.scopeFilter;
/** Does the configuration need the statement cards at all? The apply gate shows each statement with its card's gist. */
export const needsCards = (config) => cardFilterOn(config) || config.itemGist || config.applyGate;

/** The config.json keys, in documentation order. */
export const CONFIG_KEYS = Object.freeze(FIELDS.map(([name]) => name));

const rangeText = ({ min = -Infinity, max = Infinity, integer = false }) => `${integer ? "an integer" : "a number"} in [${min}, ${max}]`;
const inRange = (n, { min = -Infinity, max = Infinity, integer = false }) => Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n));

/** Parse an environment value (always a string). Returns undefined when unset or empty, so the next layer decides. */
function fromEnv([, envName, , type, opts = {}], env) {
  const v = env[envName];
  if (v === undefined || v === "") return undefined;
  if (type === "bool") {
    if (/^(1|true|yes|on)$/i.test(v)) return true;
    if (/^(0|false|no|off)$/i.test(v)) return false;
    throw new ConfigError(`${envName}=${JSON.stringify(v)} is not a boolean (use 1 or 0)`);
  }
  if (type === "num" || type === "numOrNull") {
    const n = Number(v);
    if (!inRange(n, opts)) throw new ConfigError(`${envName}=${JSON.stringify(v)} must be ${rangeText(opts)}`);
    return n;
  }
  if (type === "enum" && !opts.allowed.includes(v)) throw new ConfigError(`${envName}=${JSON.stringify(v)} must be one of ${opts.allowed.join(", ")}`);
  if (type === "kinds") {
    try { return checkedKinds(v.trim() === "none" ? [] : v.split(/[\s,]+/).filter(Boolean)); } catch (e) { throw new ConfigError(`${envName}=${JSON.stringify(v)}: ${e.message}`); }
  }
  if (type === "list") {
    let list;
    if (opts.json) {
      try { list = JSON.parse(v); } catch { throw new ConfigError(`${envName}=${JSON.stringify(v)} is not a JSON array of strings`); }
    } else {
      list = v.split(opts.sep ?? ",").map((x) => x.trim()).filter(Boolean);
    }
    try { return checkedList(list, opts); } catch (e) { throw new ConfigError(`${envName}: ${e.message}`); }
  }
  if (type === "aliasMap") {
    let obj;
    try { obj = JSON.parse(v); } catch { throw new ConfigError(`${envName}=${JSON.stringify(v)} is not JSON (use {"old-name":"new-name"})`); }
    try { return checkedAliases(obj); } catch (e) { throw new ConfigError(`${envName}: ${e.message}`); }
  }
  if (type === "homeList") {
    let list;
    if (v.trim().startsWith("[")) {
      try { list = JSON.parse(v); } catch { throw new ConfigError(`${envName}=${JSON.stringify(v)} is not a JSON array of homes`); }
    } else {
      list = v.split(opts.sep).map((x) => x.trim()).filter(Boolean);
    }
    try { return checkedHomes(list); } catch (e) { throw new ConfigError(`${envName}: ${e.message}`); }
  }
  return v;
}

/** The kinds of agent home an index-only home entry can name. */
const HOME_KINDS = Object.freeze(["claude", "codex", "code"]);

/** A list of homes, validated: each a non-empty path, or {path, kind} with exactly those keys and a known kind; no path listed twice. */
function checkedHomes(list) {
  if (!Array.isArray(list)) throw new Error("must be a list of homes");
  const paths = [];
  const out = list.map((h) => {
    if (typeof h === "string") {
      if (!h.trim()) throw new Error("a home path is empty");
      paths.push(h);
      return h;
    }
    if (h === null || typeof h !== "object" || Array.isArray(h)) throw new Error(`${JSON.stringify(h)} is not a string (a path) or a {"path": ..., "kind": ...} object`);
    const extra = Object.keys(h).filter((k) => k !== "path" && k !== "kind");
    if (extra.length) throw new Error(`home ${JSON.stringify(h)} has unknown field ${JSON.stringify(extra[0])} (only "path" and "kind")`);
    if (typeof h.path !== "string" || !h.path.trim()) throw new Error(`home ${JSON.stringify(h)} needs a non-empty "path"`);
    if (!HOME_KINDS.includes(h.kind)) throw new Error(`home ${JSON.stringify(h.path)} has kind ${JSON.stringify(h.kind)}, not one of ${HOME_KINDS.join(", ")}`);
    paths.push(h.path);
    return Object.freeze({ path: h.path, kind: h.kind });
  });
  if (new Set(paths).size !== paths.length) throw new Error("a home is listed twice");
  return Object.freeze(out);
}

/** A list of card kinds, validated: each one a known kind, no duplicates. */
function checkedKinds(list) {
  if (!Array.isArray(list)) throw new Error("must be a list of card kinds");
  for (const k of list) if (!KINDS.includes(k)) throw new Error(`${JSON.stringify(k)} is not a card kind (${KINDS.join(", ")})`);
  if (new Set(list).size !== list.length) throw new Error("a kind is listed twice");
  return Object.freeze([...list]);
}

/** A list of strings, validated: each one a string, within `allowed` when that is given, and accepted by `check` (true, or the reason it is not). */
function checkedList(list, { allowed, check } = {}) {
  if (!Array.isArray(list)) throw new Error("must be a list of strings");
  for (const x of list) {
    if (typeof x !== "string") throw new Error(`${JSON.stringify(x)} is not a string`);
    if (allowed && !allowed.includes(x)) throw new Error(`${JSON.stringify(x)} is not one of ${allowed.join(", ")}`);
    const verdict = check ? check(x) : true;
    if (verdict !== true) throw new Error(String(verdict));
  }
  if (new Set(list).size !== list.length) throw new Error("a value is listed twice");
  return Object.freeze([...list]);
}

/** A repo alias map, validated: {name: name}, no empty names, no self alias, no chain (a value that is also a key). */
function checkedAliases(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new Error('must be an object {"old-name": "canonical-name"}');
  for (const [from, to] of Object.entries(obj)) {
    if (!from || typeof to !== "string" || !to) throw new Error(`alias ${JSON.stringify(from)} must map to a non-empty repo name`);
    if (from === to) throw new Error(`alias ${JSON.stringify(from)} maps to itself`);
    if (Object.hasOwn(obj, to)) throw new Error(`alias chain ${JSON.stringify(from)} -> ${JSON.stringify(to)} -> ${JSON.stringify(obj[to])}: map both to the final name`);
  }
  return Object.freeze({ ...obj });
}

/** Validate a config.json value (JSON types only: a number is a number, "5" is not). Returns undefined for an absent key or "" (string). */
function fromFile([name, , , type, opts = {}], obj, file) {
  if (!Object.hasOwn(obj, name)) return undefined;
  const v = obj[name];
  const bad = (want) => new ConfigError(`${file}: "${name}" is ${JSON.stringify(v)} but must be ${want}`);
  if (type === "bool") { if (typeof v !== "boolean") throw bad("true or false"); return v; }
  if (type === "num" || type === "numOrNull") {
    if (type === "numOrNull" && v === null) return null;
    if (typeof v !== "number" || !inRange(v, opts)) throw bad(`${rangeText(opts)}${type === "numOrNull" ? " (or null for no cap)" : ""}`);
    return v;
  }
  if (type === "kinds") {
    try { return checkedKinds(v); } catch (e) { throw bad(`a list of card kinds: ${e.message}`); }
  }
  if (type === "list") {
    try { return checkedList(v, opts); } catch (e) { throw bad(`a list of strings: ${e.message}`); }
  }
  if (type === "aliasMap") {
    try { return checkedAliases(v); } catch (e) { throw bad(`an object of repo aliases: ${e.message}`); }
  }
  if (type === "homeList") {
    try { return checkedHomes(v); } catch (e) { throw bad(`a list of homes (paths, or {"path", "kind"} objects): ${e.message}`); }
  }
  if (typeof v !== "string") throw bad(type === "enum" ? `a string, one of ${opts.allowed.join(", ")}` : "a string");
  if (v === "") return undefined; // same as an empty environment variable: unset
  if (type === "enum" && !opts.allowed.includes(v)) throw bad(`one of ${opts.allowed.join(", ")}`);
  return v;
}

/** Read and validate <dataDir>/config.json. Returns {file, values}; values is {} when the file does not exist. Throws ConfigError. */
function readConfigFile(dataDir) {
  const file = path.join(dataDir, CONFIG_FILE_NAME);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { file: null, values: {} };
    throw new ConfigError(`${file}: cannot be read (${e.code ?? e.message})`);
  }
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new ConfigError(`${file}: not valid JSON (${e.message})`); }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new ConfigError(`${file}: must be a JSON object of settings, not ${Array.isArray(obj) ? "an array" : JSON.stringify(obj)}`);
  const unknown = Object.keys(obj).filter((k) => !CONFIG_KEYS.includes(k));
  if (unknown.length) throw new ConfigError(`${file}: unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => JSON.stringify(k)).join(", ")} (known keys: ${CONFIG_KEYS.join(", ")})`);
  return { file, values: obj };
}


/**
 * The effective configuration. The file is read for the real process environment and for any synthetic environment that names a place to
 * look (RECALL_DATA or HOME); a bare `{}` (the unit tests' "all defaults") never reads the real ~/.plugin-recall/config.json.
 * Result: the fields, plus `configFile` (the path read, or null) and `sources` (field -> "env" | "file" | "default").
 */
export function loadConfig(env = process.env) {
  const dataDir = resolveDataDir(env);
  const useFile = env === process.env || Boolean(env.RECALL_DATA || env.HOME);
  const { file, values } = useFile ? readConfigFile(dataDir) : { file: null, values: {} };
  const out = { dataDir };
  const sources = {};
  for (const row of FIELDS) {
    const [name, , dflt, , opts = {}] = row;
    const fromFileValue = fromFile(row, values, file); // validated even when the environment overrides it: a bad file is always loud
    let v = fromEnv(row, env);
    let source = "env";
    if (v === undefined) { v = fromFileValue; source = "file"; }
    if (v === undefined) { v = dflt; source = "default"; }
    out[name] = opts.post ? opts.post(v) : v;
    sources[name] = source;
  }
  // `child` is the plugin's own worker marker: environment only.
  out.child = fromEnv(["child", "RECALL_CHILD", false, "bool"], env) ?? false;
  return Object.freeze({ ...out, configFile: file, sources: Object.freeze(sources) });
}

/** The settings a log line records: effective value and source for the spend caps, the pipeline, k and the v2 flags. */
export function effectiveSettings(config) {
  const pick = (name) => ({ value: config[name], source: config.sources[name] });
  return { dailyCapUsd: pick("dailyCapUsd"), totalCapUsd: pick("totalCapUsd"), pipeline: pick("pipeline"), k: pick("k"), ...Object.fromEntries(V2_FLAGS.map((f) => [f, pick(f)])) };
}

/** The precision rules' settings with their sources, as a prompt line records them beside the statements the rules kept out. */
export const precisionSettings = (config) => Object.fromEntries(PRECISION_FLAGS.map((f) => [f, { value: config[f], source: config.sources[f] }]));

/** The apply gate's settings with their sources, as a prompt line records them (beside its per-survivor record). */
export const applySettings = (config) => Object.fromEntries(APPLY_FLAGS.map((f) => [f, { value: config[f], source: config.sources[f] }]));
