// `recall setup` (also `recall`, `recall install`, `npx -y @just-every/plugin-recall`): from nothing, or from an older version, to Recall on
// in every agent home. It asks at most two things: the key, only when it finds none (or with --new-key), and "Go ahead?" once over the whole
// plan (using the key it found, and saving it to ~/.env, included). Home numbers typed there are a yes that leaves those homes out: the
// homes and the plan are shown again, and it goes on without asking again. Nothing is written and nothing is paid for before that yes; the
// only request before it is the free key check.
// A run with nothing to do asks nothing and writes nothing.
import os from "node:os";
import { isConfigError } from "../lib/config-error.mjs";
import { loadConfig } from "../lib/config.mjs";
import { requiredProviders } from "../lib/providers/index.mjs";
import { applyPlan } from "./apply.mjs";
import { configProblem } from "./config-problem.mjs";
import { detectTools, nodeOk, MIN_NODE } from "./detect.mjs";
import { chosen, homeRows, leaveOut, markRead, printHomes } from "./home-rows.mjs";
import { run as runCommand } from "./hosts/runner.mjs";
import { hasProviderCheck } from "./install-record.mjs";
import { keyStep, shellRejectedLine } from "./key-step.mjs";
import { marketplaceDir } from "./marketplace.mjs";
import { buildPlan, isUpToDate, planConfig, renderPlan, renderWhatLeaves } from "./plan.mjs";
import { PLUGIN_ROOT, pluginMeta } from "./plugin-meta.mjs";
import { readSettings } from "./settings.mjs";
import { codexTrustLines, printSummary } from "./summary.mjs";
import { plural } from "./ui.mjs";

const NO_TOOL = [
  "Recall runs inside Claude Code or Codex, and one of them writes Recall's short summaries.",
  "Install one, then run this again:",
  "  Claude Code:  curl -fsSL https://claude.ai/install.sh | bash",
  "  or, with npm: npm install -g @anthropic-ai/claude-code",
  "  Codex:        npm install -g @openai/codex",
  "Nothing was changed.",
];
const NO_LOGIN = [
  "Recall needs Claude Code or Codex logged in: one of them writes Recall's short summaries.",
  "Log in (run claude and type /login, or run codex login), then run this again.",
  "Nothing was changed.",
];

function toolLine(ui, label, t) {
  if (!t.found) return ui.item("skip", `${label}: not found`);
  if (t.login === "logged-out") return ui.item("warn", `${label} ${t.version} · not logged in`);
  ui.item("ok", `${label} ${t.version}${t.login === "logged-in" ? " · logged in" : ""}`);
}

/**
 * @param {{flags: object, env?: object, homeDir?: string, prompter: object, ui: object, run?: Function, root?: string, nodeVersion?: string}} o
 * @returns {Promise<number>} the exit code
 */
export async function runSetup({ flags, env = process.env, homeDir = os.homedir(), prompter, ui, run = runCommand, root = PLUGIN_ROOT, nodeVersion = process.version }) {
  const V = pluginMeta().version;
  const stop = (code, ...lines) => { ui.say(...lines); return code; };
  ui.say(`Recall ${V} · memory for Claude Code and Codex`, "");
  if (!nodeOk(nodeVersion)) return stop(1, `Recall needs Node ${MIN_NODE.join(".")} or newer; this is Node ${nodeVersion.replace(/^v/, "")}.`, "Nothing was changed.");
  let config;
  try {
    config = loadConfig({ ...env, HOME: homeDir });
  } catch (e) {
    if (!isConfigError(e)) throw e;
    return stop(1, configProblem(e, ui), "Nothing was changed.");
  }
  const dataDir = config.dataDir;

  ui.title("Looking at this machine");
  ui.item("ok", `Node ${nodeVersion.replace(/^v/, "")}`);
  const tools = await detectTools({ env, homeDir, run });
  toolLine(ui, "Claude Code", tools.claude);
  toolLine(ui, "Codex", tools.codex);
  if (tools.everyCode) ui.item("skip", "Every Code: ~/.code is read for memory; it has no plugin system, so nothing is installed there");
  if (tools.stop) return stop(1, "", ...(tools.stop === "no-tool" ? NO_TOOL : NO_LOGIN));

  const rows = homeRows({ homeDir, env, tools, dataDir, M: marketplaceDir(dataDir), V, flags });
  const current = readSettings(dataDir);
  const showHomes = async () => {
    const readOnly = await markRead(rows, planConfig({ rows, config, current, flags, homeDir }).cfg, { homeDir, env });
    printHomes(ui, rows, V, readOnly);
  };
  ui.blank();
  await showHomes();

  const keys = [];
  for (const provider of requiredProviders(config)) {
    ui.blank();
    const k = await keyStep(provider, { config, env, homeDir, prompter, ui, flags });
    if (k.exit !== undefined) return stop(k.exit, ...k.lines);
    keys.push({ provider, ...k });
  }

  const planFor = () => buildPlan({ rows, keys, config, current, flags, homeDir, env, root, V, writer: tools.writer });
  let plan = await planFor();
  if (plan.stop) return stop(1, "", ...plan.stop);
  ui.blank();
  if (!rows.some(chosen)) return stop(0, "No homes left to install into. Nothing was changed.");
  if (isUpToDate(plan.actions)) {
    const untrusted = rows.filter((r) => chosen(r) && r.host === "codex" && !r.state.trusted);
    ui.say(`Everything is up to date: Recall ${V} in ${plural(plan.actions.homesChosen, "home")}.`);
    ui.say(...codexTrustLines(untrusted, homeDir));
    return 0;
  }
  renderPlan(ui, plan.actions, { V });
  const firstSend = keys.some((k) => (k.key || k.missing) && !hasProviderCheck(dataDir, k.provider.id));
  if (flags.skipKey) { ui.blank(); ui.say("Nothing leaves this machine until you add a key."); }
  else if (firstSend) { ui.blank(); renderWhatLeaves(ui, dataDir, tools.writer); }
  ui.blank();
  if (flags.dryRun) return stop(0, "Dry run: nothing was changed.");

  for (;;) {
    const answer = await prompter.goAhead("Go ahead?");
    if (answer.go) break;
    if (!answer.leaveOut) return stop(0, "Stopped. Nothing was changed.");
    if (!leaveOut(rows, answer.leaveOut)) { ui.say("Type y, n, or home numbers such as 2,4."); continue; }
    if (!rows.some(chosen)) return stop(0, "No homes left to install into. Nothing was changed.");
    ui.say(`Leaving out ${answer.leaveOut.map((n) => rows.find((r) => r.n === n).display).join(", ")}.`, "");
    await showHomes();
    plan = await planFor();
    if (plan.stop) return stop(1, "", ...plan.stop);
    ui.blank();
    renderPlan(ui, plan.actions, { V });
    ui.blank();
    break;
  }

  const done = await applyPlan({ ui, plan, rows, keys, V, root, homeDir, env, run });
  if (done.exit !== undefined) return stop(done.exit, ...done.stop);
  const notes = keys.filter((k) => k.shellKeyRejected).map((k) => shellRejectedLine(k.provider));
  return printSummary(ui, { ...done, cfg: plan.cfg, V, flags, homeDir, env, notes });
}
