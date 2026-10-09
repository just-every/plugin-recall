// The key step of setup, for one provider: find the key (environment, then ~/.env) or ask for it hidden, check it for free, and work out
// whether the plan saves it to ~/.env. The only question here is the paste: asked when no usable key was found, or with --new-key. Using a
// found key and saving it are plan lines the go-ahead approves. A key that is only in the environment is saved, because hooks started by a
// desktop app do not see the shell's environment; it stays out of ~/.env only under --no-save-key, now or recorded by an earlier run.
// Nothing is written here, and the key is shown only masked.
import path from "node:path";
import { findKey, maskKey } from "../lib/providers/index.mjs";
import { envFileState } from "./env-file.mjs";
import { keyKeptOut } from "./install-record.mjs";
import { ONE_LINER } from "./plugin-meta.mjs";
import { NoAnswer } from "./prompt.mjs";
import { keep } from "./ui.mjs";

const MAX_ATTEMPTS = 3;

/** What the step ends with: {exit, lines} stops setup with that code after printing the lines. */
const stop = (exit, ...lines) => ({ exit, lines });

/** Said when the key in the shell's environment is the one the provider rejected (it wins over ~/.env, so pasting another key does not help). */
export const shellRejectedLine = (provider) => `The ${provider.envName} in this shell is the key ${provider.label} rejected, and it wins over ~/.env. Remove it (unset ${provider.envName} and delete it from your shell profile).`;

/** A pasted key as it is meant: without the quotes or the `OPENAI_API_KEY=` (or `export OPENAI_API_KEY=`) it was copied with. */
export function cleanPaste(text, provider) {
  const unquote = (t) => (/^(["']).*\1$/.test(t) && t.length > 1 ? t.slice(1, -1).trim() : t);
  let t = unquote(text.trim());
  t = t.replace(new RegExp(`^(?:export\\s+)?${provider.envName}\\s*=\\s*`), "");
  return unquote(t.trim());
}

/**
 * @param {object} provider an entry of PROVIDERS
 * @param {{config: object, env: object, homeDir: string, prompter: object, ui: object,
 *   flags: {skipKey?: boolean, dryRun?: boolean, noSaveKey?: boolean, newKey?: boolean}, fetchImpl?: Function}} o
 * @returns {Promise<{skipped: true, missing?: true} | {key: string, source: string, pasted: boolean, save: boolean, replaces: boolean,
 *   keepOut: boolean, checked: boolean, shellKeyRejected?: true} | {exit: number, lines: string[]}>} keepOut: record that this key stays out of ~/.env
 */
export async function keyStep(provider, { config, env, homeDir, prompter, ui, flags, fetchImpl }) {
  ui.title(`${provider.label} key (${provider.purpose})`);
  if (flags.skipKey) {
    ui.item("skip", "Skipped (--skip-key). Recall stays silent until it has a key.");
    return { skipped: true };
  }
  let shellRejected = false; // the key in the shell's environment is the one that was rejected
  let rejected = false; // some key was rejected: only then is --new-key worth a hint
  const notAccepted = () => stop(1, ...(shellRejected ? [shellRejectedLine(provider)] : []), "Nothing was changed.",
    ...(rejected && !shellRejected ? [`To try another key: ${keep(`${ONE_LINER} --new-key`)}`] : []));
  const check = async (key, { shell = false } = {}) => {
    const r = await provider.validate({ key, config, ...(fetchImpl ? { fetchImpl } : {}) });
    if (r.ok) { ui.item("ok", `Accepted by ${provider.label} (free check, no tokens billed).`); return { ok: true }; }
    if (r.reason === "rejected") {
      rejected = true;
      shellRejected = shellRejected || shell;
      ui.item("fail", `${provider.label} rejected this key. Check it at ${provider.keyUrl}.`);
      return { ok: false };
    }
    if (r.reason === "unreachable") return { end: stop(1, `  ${ui.glyph("fail")} Could not reach ${provider.baseUrl(config)} (${r.code}).`, "Check your connection and run this again.", "Nothing was changed.") };
    return { end: stop(1, `  ${ui.glyph("fail")} ${provider.label} answered HTTP ${r.status} to the free check.`, "Try again in a minute.", "Nothing was changed.") };
  };

  const found = findKey(provider, { env, homeDir });
  if (flags.newKey) {
    ui.say(found ? `  Found a key in ${found.source} (${maskKey(found.key)}); --new-key asks for the one to use instead.` : "  No key found in the environment or in ~/.env.");
    ui.say(`  Get one at ${provider.keyUrl} (${provider.keyNeeds})`);
    if (flags.dryRun) { ui.item("skip", "Not asked (--dry-run); a real run asks for the new key here."); return { skipped: true, missing: true }; }
  } else if (found) {
    ui.say(`  Found a key in ${found.source} (${maskKey(found.key)}).`);
    if (flags.dryRun) { ui.item("skip", "Not checked (--dry-run)."); return finish(found.key, found.source, false, false); }
    const r = await check(found.key, { shell: found.source === "the environment" });
    if (r.end) return r.end;
    if (r.ok) return finish(found.key, found.source, false, true);
    if (!prompter.interactive) return notAccepted();
  } else {
    ui.say("  No key found in the environment or in ~/.env.", `  Get one at ${provider.keyUrl} (${provider.keyNeeds})`);
    if (flags.dryRun) { ui.item("skip", "Not asked (--dry-run); a real run asks for it here."); return { skipped: true, missing: true }; }
  }
  if (flags.noSaveKey) {
    return stop(1, "With --no-save-key, Recall's hooks read the key only from their app's environment.",
      `Set ${provider.envName} there, or run this again without --no-save-key.`, "Nothing was changed.");
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let typed;
    try {
      typed = cleanPaste(await prompter.secret(`  Paste your ${flags.newKey ? "new " : ""}${provider.label} API key (hidden, Enter to stop): `), provider);
    } catch (e) {
      if (!(e instanceof NoAnswer)) throw e;
      return stop(1, flags.newKey ? `No new ${provider.label} key on stdin.` : `No ${provider.label} key: none in the environment or in ~/.env, and none on stdin.`,
        `${flags.newKey ? "Pipe it in" : `Set ${provider.envName}, or pipe it in`}: printf '%s\\n' "$KEY" | ${ONE_LINER} ${flags.newKey ? "--new-key " : ""}--yes`, "Nothing was changed.");
    }
    if (!typed) return stop(0, "Stopped. Nothing was changed.");
    if (!provider.looksLikeKey(typed)) {
      ui.say(typed.startsWith(provider.keyPrefix)
        ? `  That does not look like a full ${provider.label} key (it starts with ${provider.keyPrefix} and is much longer).`
        : `  That does not look like an ${provider.label} key (${provider.shapeHint}).`);
      if (!prompter.interactive) return notAccepted();
      continue;
    }
    const r = await check(typed);
    if (r.end) return r.end;
    if (r.ok) {
      const fromEnv = env[provider.envName]?.trim();
      if (shellRejected && fromEnv && fromEnv !== typed) ui.item("warn", shellRejectedLine(provider));
      else if (fromEnv && fromEnv !== typed) ui.item("warn", `${provider.envName} is also set in this shell: where it is set, it wins over ~/.env.`);
      return finish(typed, "the paste", true, true, shellRejected && fromEnv !== typed);
    }
    if (!prompter.interactive) return notAccepted();
  }
  return notAccepted();

  /** Whether the plan saves the key to ~/.env, and whether it records keeping it out (--no-save-key, not recorded yet). */
  function finish(key, source, pasted, checked, shellKeyRejected = false) {
    const file = envFileState(path.join(homeDir, ".env"), provider.envName);
    const inFile = file.value === key;
    const replaces = file.value !== undefined && !inFile;
    const keptOut = keyKeptOut(config.dataDir, provider.id);
    const save = !inFile && !flags.noSaveKey && (pasted || !keptOut);
    if (!inFile && !save) {
      ui.item("warn", `${flags.noSaveKey ? "Not saved (--no-save-key)" : "Not in ~/.env"}: desktop apps do not pass your shell environment to hooks,`);
      ui.say(`    so Recall works only where ${provider.envName} is set.`);
      if (!flags.noSaveKey) ui.say(`    To save it there: ${keep(`${ONE_LINER} --new-key`)}`);
    }
    if (file.exists && file.loose) ui.item("warn", "~/.env can be read by other users on this machine; run: chmod 600 ~/.env");
    return { key, source, pasted, save, replaces, keepOut: Boolean(flags.noSaveKey) && !inFile && !keptOut, checked, ...(shellKeyRejected ? { shellKeyRejected: true } : {}) };
  }
}
