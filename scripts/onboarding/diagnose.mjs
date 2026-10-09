// `recall doctor`: look at the machine and say what works. Returns checks {id, level: "ok"|"warn"|"fail"|"info", title, lines[]}; report.mjs prints them.
// Nothing here changes anything, and a key is only ever shown masked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cardsPath, loadCards } from "../lib/cards/cards-file.mjs";
import { cliLogin } from "../lib/cli-login.mjs";
import { CONFIG_FILE_NAME, loadConfig } from "../lib/config.mjs";
import { isConfigError } from "../lib/config-error.mjs";
import { indexOnlyHomes, minedHomes } from "../lib/homes.mjs";
import { createLedger } from "../lib/ledger.mjs";
import { findKey, keyFingerprint, maskKey, requiredProviders } from "../lib/providers/index.mjs";
import { createStore } from "../lib/store.mjs";
import { listTranscripts } from "../lib/transcripts/files.mjs";
import { hostLabel } from "./agent-homes.mjs";
import { MIN_NODE, nodeOk, shortVersion, writerHome } from "./detect.mjs";
import { dollars, usd } from "./estimate.mjs";
import { readHomeState } from "./hosts/index.mjs";
import { run as runCommand } from "./hosts/runner.mjs";
import { accessConfirmedAt, readInstalls } from "./install-record.mjs";
import { ONE_LINER, pluginMeta } from "./plugin-meta.mjs";
import { cliVersion, dirSizeBytes } from "./probes.mjs";
import { plural, tildePath } from "./ui.mjs";

const mb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** Count the files and the statements the homes hold, per home. */
export function transcriptCensus(homes) {
  return homes.map((h) => ({ ...h, files: listTranscripts(h.dir, h.kind).length }));
}

function embeddingCount(dataDir) {
  const dir = path.join(dataDir, "embeddings");
  let n = 0;
  try {
    for (const name of fs.readdirSync(dir)) if (name.endsWith(".json") && !name.includes(".tmp")) n += JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")).hashes.length;
  } catch { /* no embeddings yet */ }
  return n;
}

/** Each provider's key, the free check, and whether setup has proven access to its paid endpoint. */
async function providerChecks(add, { config, env, homeDir, dataDir, offline, fetchImpl }) {
  for (const p of requiredProviders(config ?? {})) {
    const found = findKey(p, { env, homeDir });
    add(`${p.id}-key`, found ? "ok" : "fail", found ? `${p.label} key found in ${found.source} (${maskKey(found.key)})` : `${p.label} key not found`,
      found ? [] : [`Run: ${ONE_LINER} (it asks for the key and saves it to ~/.env)`]);
    const baseUrl = config ? p.baseUrl(config) : "https://api.openai.com";
    if (!found) add(`${p.id}-api`, "info", `${p.label} API not checked (no key)`);
    else if (offline) add(`${p.id}-api`, "info", `${p.label} API not checked (--offline); only the presence of the key was verified`);
    else {
      const r = await p.validate({ key: found.key, config: config ?? { openaiBaseUrl: baseUrl }, ...(fetchImpl ? { fetchImpl } : {}) });
      const how = p.validateNote;
      if (r.ok) add(`${p.id}-api`, "ok", `${p.label} API reachable and the key is accepted (${baseUrl})`, [how]);
      else if (r.reason === "rejected") add(`${p.id}-api`, "fail", `${p.label} API rejected the key (HTTP ${r.status})`, [how]);
      else if (r.reason === "http") add(`${p.id}-api`, "warn", `${p.label} API answered HTTP ${r.status} to the free check`, [how]);
      else add(`${p.id}-api`, "warn", `${p.label} API not reachable (${r.code})`, [`${baseUrl}; ${how}`]);
    }
    if (!found) continue;
    const at = accessConfirmedAt(dataDir, p.id, keyFingerprint(found.key));
    if (at) add(`${p.id}-access`, "ok", `${p.label} key can ${p.access.ability} (checked ${at.slice(0, 10)})`);
    else add(`${p.id}-access`, "warn", `Not checked yet whether the ${p.label} key can ${p.access.ability}`, [`Run: ${ONE_LINER} (it checks with one tiny request)`]);
  }
}

/** The claude and codex CLIs: on PATH, version, logged in. */
async function cliChecks(add, { env, homeDir, run }) {
  const found = [];
  for (const kind of ["claude", "codex"]) {
    const v = cliVersion(kind, { env });
    if (!v.found) { add(`cli-${kind}`, "info", `${kind} CLI: ${v.error}`); continue; }
    const login = await cliLogin(kind, { home: writerHome(kind, { env, homeDir }), env, run });
    found.push(login);
    const ver = shortVersion(v.version) ?? "";
    if (login === "logged-in") add(`cli-${kind}`, "ok", `${kind} CLI ${ver}, logged in`);
    else if (login === "logged-out") add(`cli-${kind}`, "warn", `${kind} CLI ${ver}, not logged in`);
    else add(`cli-${kind}`, "ok", `${kind} CLI ${ver}`.trim());
  }
  if (!found.length) add("cli-any", "fail", "neither the claude nor the codex CLI is on PATH", ["One of them writes the short summaries Recall needs; without them Recall stays silent"]);
  else if (found.every((l) => l === "logged-out")) add("cli-any", "fail", "neither the claude nor the codex CLI is logged in", ["Log in (run claude and type /login, or run codex login): one of them writes the summaries"]);
}

/** Recall in each agent home: those setup recorded plus the mined Claude Code and Codex homes. */
function installChecks(add, { homes, dataDir, homeDir, V }) {
  const rows = new Map();
  for (const h of homes) if (h.kind === "claude" || h.kind === "codex") rows.set(real(h.dir), { host: h.kind, home: h.dir });
  const recorded = readInstalls(dataDir)?.homes ?? [];
  for (const h of recorded) if (!rows.has(real(h.home)) && fs.existsSync(h.home)) rows.set(real(h.home), { host: h.host, home: h.home });
  if (!rows.size) { add("installs", "info", "no Claude Code or Codex home to install Recall into"); return; }
  for (const row of rows.values()) {
    const host = hostLabel(row.host);
    const shown = tildePath(row.home, homeDir);
    const id = `install:${row.home}`;
    const state = readHomeState(row, V);
    const leftOut = recorded.some((h) => h.status === "left-out" && real(h.home) === real(row.home));
    if (state.otherCopy) add(id, "info", `${shown} has ${state.otherCopy} (another copy of Recall)`);
    else if (!state.installed && leftOut) add(id, "info", `Recall left out of ${host} (${shown}) at setup`);
    else if (!state.installed) add(id, "warn", `Recall is not installed in ${host} (${shown})`, [`Run: ${ONE_LINER}`]);
    else if (!state.enabled) add(id, "warn", `Recall is installed but turned off in ${host} (${shown})`, [`Run: ${ONE_LINER} (it turns it back on)`]);
    else if (row.host === "codex" && !state.trusted) add(id, "warn", `Recall installed in Codex (${shown}); its hook is not approved yet`, ["Codex runs a plugin's hook only after you approve it: start Codex in this home and choose \"Trust all and continue\", or run /hooks"]);
    else add(id, "ok", `Recall installed in ${host} (${shown})`);
  }
}

/**
 * @param {{env?: object, homeDir?: string, offline?: boolean, fetchImpl?: Function, nodeVersion?: string, run?: Function}} [o]
 * @returns {Promise<{checks: object[], failed: boolean}>}
 */
export async function diagnose({ env = process.env, homeDir = os.homedir(), offline = false, fetchImpl, nodeVersion = process.version, run = runCommand } = {}) {
  const checks = [];
  const add = (id, level, title, lines = []) => checks.push({ id, level, title, lines });
  const meta = pluginMeta();
  add("plugin", "info", `${meta.name} ${meta.version}`);

  add("node", nodeOk(nodeVersion) ? "ok" : "fail", `Node ${nodeVersion.replace(/^v/, "")}`, nodeOk(nodeVersion) ? [] : [`Node ${MIN_NODE.join(".")} or newer is required; the hooks run with the node on the host's PATH`]);

  let config = null;
  try {
    config = loadConfig({ ...env, HOME: homeDir });
  } catch (e) {
    if (!isConfigError(e)) throw e;
    add("config", "fail", "config is invalid", [e.message, "Fix the file (or the RECALL_* variable) and run doctor again; until then Recall stays silent"]);
  }
  const dataDir = config?.dataDir ?? path.resolve(env.RECALL_DATA || path.join(homeDir, ".plugin-recall"));

  await providerChecks(add, { config, env, homeDir, dataDir, offline, fetchImpl });
  await cliChecks(add, { env, homeDir, run });

  let homes = [];
  let indexOnly = [];
  let skipped = [];
  try {
    const mined = await minedHomes(config ?? { homes: [], homesRoster: "" }, { homeDir, env });
    homes = transcriptCensus(mined.homes);
    indexOnly = transcriptCensus(indexOnlyHomes(config ?? { homes: [] }, { homeDir }).filter((h) => !mined.homes.some((m) => m.dir === h.dir)));
    skipped = mined.skipped;
  } catch (e) {
    add("homes", "fail", "cannot work out the agent homes", [e.message]);
  }
  if (!checks.some((c) => c.id === "homes")) {
    const total = [...homes, ...indexOnly].reduce((n, h) => n + h.files, 0);
    const shown = (p) => tildePath(p, homeDir);
    const lines = [...homes, ...indexOnly].map((h) => `${shown(h.dir)}  (${h.kind}${h.indexOnly ? ", read for indexing only" : ""}, ${plural(h.files, "transcript file")})`);
    if (skipped.length) lines.push(`${plural(skipped.length, "other agent home")} found but not read (${skipped.slice(0, 4).map(shown).join(", ")}${skipped.length > 4 ? ", ..." : ""}); list the ones you want in "homes" in ${shown(path.join(dataDir, CONFIG_FILE_NAME))}`);
    if (!homes.length) add("homes", "fail", "no agent homes found", ["Looked for ~/.claude, ~/.codex, $CLAUDE_CONFIG_DIR, $CODEX_HOME and ~/.code; use \"homes\" in config.json for other places"]);
    else add("homes", total ? "ok" : "warn", `${plural(homes.length + indexOnly.length, "agent home")}, ${plural(total, "transcript file")}`, total ? lines : [...lines, "No transcripts yet: there is nothing to remember until you have used Claude Code or Codex for a while"]);
  }

  const store = createStore(dataDir);
  let statements = 0;
  let cards = 0;
  try {
    statements = store.loadStatements().length;
    cards = loadCards(cardsPath(dataDir)).size;
  } catch (e) {
    add("index", "fail", "the index cannot be read", [e.message]);
  }
  if (!checks.some((c) => c.id === "index")) {
    const exists = fs.existsSync(dataDir);
    const lines = [`${tildePath(dataDir, homeDir)}: ${exists ? mb(dirSizeBytes(dataDir)) : "does not exist yet"}`, `${plural(statements, "statement")}, ${embeddingCount(dataDir)} searchable, ${cards} with a summary`];
    if (config) {
      const ledger = createLedger({ dir: dataDir, dailyCapUsd: config.dailyCapUsd, totalCapUsd: config.totalCapUsd });
      lines.push(`spent today ${usd(ledger.spentToday())} of the ${dollars(config.dailyCapUsd)} daily cap${config.configFile ? ` (config: ${tildePath(config.configFile, homeDir)})` : " (no config.json: defaults)"}`);
      if (config.disabled) lines.push(`Recall is paused: it does nothing until you run ${ONE_LINER} resume`);
    }
    const level = !statements ? "warn" : cards < statements ? "warn" : "ok";
    const title = !statements ? "no index yet" : cards < statements ? `index: ${plural(statements, "statement")}, ${statements - cards} without a summary yet` : `index: ${plural(statements, "statement")}, all with summaries`;
    const next = statements && cards < statements ? [`Recall brings back only statements that have a summary; to write the rest now: ${ONE_LINER} enrich`] : !statements ? [`Run: ${ONE_LINER}`] : [];
    add("index", level, title, [...lines, ...next]);
  }

  installChecks(add, { homes, dataDir, homeDir, V: meta.version });
  return { checks, failed: checks.some((c) => c.level === "fail") };
}
