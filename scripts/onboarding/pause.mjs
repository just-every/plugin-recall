// `recall pause` and `recall resume`: set or clear "disabled" in <dataDir>/config.json, which every hook reads on every turn, so the switch
// takes effect at once in every agent home. The file is merged, never replaced: every other setting stays.
import os from "node:os";
import { isConfigError } from "../lib/config-error.mjs";
import { loadConfig } from "../lib/config.mjs";
import { configProblem } from "./config-problem.mjs";
import { ONE_LINER } from "./plugin-meta.mjs";
import { readSettings, writeSettings } from "./settings.mjs";
import { keep } from "./ui.mjs";

/**
 * @param {"pause"|"resume"} kind
 * @param {{env?: object, homeDir?: string, ui: object}} o
 * @returns {number} the exit code
 */
export function runPause(kind, { env = process.env, homeDir = os.homedir(), ui }) {
  let config;
  try {
    config = loadConfig({ ...env, HOME: homeDir });
  } catch (e) {
    if (!isConfigError(e)) throw e;
    ui.say(configProblem(e, ui), "Nothing was changed.");
    return 1;
  }
  const current = readSettings(config.dataDir);
  const paused = current.disabled === true;
  const resumeCmd = keep(`${ONE_LINER} resume`);
  if (kind === "pause") {
    if (paused) ui.say(`Recall is already paused. To turn it back on: ${resumeCmd}`);
    else {
      writeSettings(config.dataDir, { ...current, disabled: true });
      ui.say("Recall is paused: it does nothing, in every agent home, until you turn it back on:", `  ${resumeCmd}`);
    }
    if (config.sources.disabled === "env" && !config.disabled) ui.item("warn", "RECALL_DISABLED=0 is set in this shell, and it wins over config.json where it is set.");
    return 0;
  }
  if (!paused) ui.say("Recall is not paused.");
  else {
    const { disabled, ...rest } = current;
    writeSettings(config.dataDir, rest);
    ui.say("Recall is on again, in every agent home.");
  }
  if (config.sources.disabled === "env" && config.disabled) ui.item("warn", "RECALL_DISABLED is set in this shell, so Recall stays off where it is set. Unset it there.");
  return 0;
}
