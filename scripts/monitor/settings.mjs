// The effective settings the monitor shows next to the numbers: caps and thresholds with where each value came from. Reuses the plugin's own
// resolver (config.mjs: environment, then <data dir>/config.json, then default) and re-reads it on every call, so editing config.json shows
// up without a restart. An invalid configuration is reported, never replaced by guessed values.
import { APPLY_FLAGS, effectiveSettings, loadConfig, PRECISION_FLAGS, V2_FLAGS } from "../lib/config.mjs";
import { LEGACY_STOP_THRESHOLD } from "./legacy-stop.mjs";

export function readSettings(env) {
  let config;
  try { config = loadConfig(env); } catch (e) {
    return { ok: false, error: `${e.name}: ${e.message}`, bars: { promptThreshold: null, stopThreshold: null }, caps: null };
  }
  const eff = effectiveSettings(config);
  const pick = (name) => ({ value: config[name], source: config.sources[name] });
  return {
    ok: true,
    error: null,
    bars: { promptThreshold: config.promptThreshold, stopThreshold: LEGACY_STOP_THRESHOLD },
    caps: { dailyUsd: eff.dailyCapUsd, totalUsd: eff.totalCapUsd },
    settings: {
      pipeline: pick("pipeline"), k: pick("k"), promptThreshold: pick("promptThreshold"), dailyCapUsd: pick("dailyCapUsd"), totalCapUsd: pick("totalCapUsd"),
      ...Object.fromEntries([...V2_FLAGS, ...PRECISION_FLAGS, ...APPLY_FLAGS].map((f) => [f, pick(f)])),
    },
    configFile: config.configFile,
  };
}
