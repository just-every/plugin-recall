// What a setup run would do, worked out before anything is written or paid for, and the plan as the person reads it before saying yes.
// The cost scan is the indexer's read-only dry run, made only when an index step is needed.
import { cardsPath, loadCards } from "../lib/cards/cards-file.mjs";
import { loadIndexedCorpus } from "../lib/index-corpus.mjs";
import { runIndex } from "../lib/indexer.mjs";
import { keyFingerprint, maskKey } from "../lib/providers/index.mjs";
import { createStore } from "../lib/store.mjs";
import { DECISIONS_USD_PER_PROMPT, dollars, estimateFirstIndex, usd } from "./estimate.mjs";
import { chosen } from "./home-rows.mjs";
import { needsInstall } from "./hosts/index.mjs";
import { accessConfirmedAt } from "./install-record.mjs";
import { launcherState } from "./launcher.mjs";
import { marketplaceStatus } from "./marketplace.mjs";
import { ONE_LINER } from "./plugin-meta.mjs";
import { mergeSettings, withSettings } from "./settings.mjs";
import { keep, plural } from "./ui.mjs";

const cents = (n) => (Math.ceil(n * 100) / 100).toFixed(2);
/** "about $0.42", or "less than $0.0001" (never "about less than"). */
const about = (n) => (n < 0.0001 ? usd(n) : `about ${usd(n)}`);

/** The settings this run would write for the homes chosen now, and the configuration the index and the cost scan run under. */
export function planConfig({ rows, config, current, flags, homeDir }) {
  const picked = rows.filter(chosen);
  const settings = mergeSettings({ current, capFlag: flags.dailyCap ?? null, homes: picked.map((r) => ({ home: r.home, host: r.host })), homeDir, roster: Boolean(config.homesRoster) });
  return { settings, cfg: withSettings(config, settings.next) };
}

/**
 * @returns {Promise<{stop?: string[], cfg?: object, next?: object, actions?: object}>}
 */
export async function buildPlan({ rows, keys, config, current, flags, homeDir, env, root, V, writer, scan = runIndex }) {
  const dataDir = config.dataDir;
  const picked = rows.filter(chosen);
  const { settings, cfg } = planConfig({ rows, config, current, flags, homeDir });
  const noIndex = flags.noIndex || flags.skipKey;
  const store = createStore(dataDir);
  const statements = store.loadStatements();
  const hasIndex = Boolean(store.loadState().lastIndexAt);
  const withoutEmbedding = hasIndex ? loadIndexedCorpus(store).withoutEmbedding : 0;
  const carded = loadCards(cardsPath(dataDir));
  const missingCards = statements.filter((s) => !carded.has(s.id)).length;

  const actions = {
    installRows: picked.filter((r) => needsInstall(r.status)),
    leaveOutRows: rows.filter((r) => r.newlyLeftOut),
    useKeys: keys.filter((k) => k.key && !k.pasted),
    saveKeys: keys.filter((k) => k.save),
    keepOutKeys: keys.filter((k) => k.keepOut),
    accessChecks: keys.filter((k) => (k.key && !accessConfirmedAt(dataDir, k.provider.id, keyFingerprint(k.key))) || k.missing),
    settings: { write: settings.changed, cap: settings.cap },
    index: null,
    emptyIndex: null,
    existingIndex: hasIndex ? { statements: statements.length } : null,
    noIndex: hasIndex ? null : flags.skipKey ? "skip-key" : flags.noIndex ? "no-index" : null,
    cards: null,
    marketplace: marketplaceStatus({ dataDir, root, V }),
    launcher: launcherState({ homeDir, dataDir, V }),
    writer,
    noSpend: Boolean(flags.skipKey),
    homesChosen: picked.length,
  };
  if (!noIndex && (!hasIndex || withoutEmbedding > 0)) {
    const report = await scan({ config: cfg, store, embed: false, dryRun: true, homeDir, env });
    const est = estimateFirstIndex(report);
    if (!est.statements) actions.emptyIndex = { homes: report.homes.length };
    else {
      if (est.embeddingUsd > cfg.dailyCapUsd) {
        return { stop: [`The first index (${about(est.embeddingUsd)}) costs more than the daily cap of ${dollars(cfg.dailyCapUsd)}.`, `Run this again with --daily-cap ${cents(est.embeddingUsd * 2)}.`, "Nothing was changed."] };
      }
      actions.index = { homes: report.homes.length, ...est };
      actions.existingIndex = null;
    }
  }
  if (!noIndex && writer) {
    if (actions.index) actions.cards = { withIndex: true, calls: actions.index.cardCalls };
    else if (missingCards) actions.cards = { withIndex: false, missing: missingCards };
  }
  return { cfg, next: settings.next, actions };
}

/** Nothing to do: every chosen home is current and so is everything else. */
export function isUpToDate(a) {
  return !a.installRows.length && !a.leaveOutRows.length && !a.saveKeys.length && !a.keepOutKeys.length && !a.accessChecks.length && !a.settings.write && !a.index && !a.cards
    && !a.marketplace.needsWrite && (a.launcher === "current" || a.launcher === "foreign");
}

/** "Install Recall 0.5.1 in 2 homes: ~/.claude, ~/.codex" (the homes named when there are three or fewer). */
const homesLine = (lead, rows) => `  ${lead} in ${plural(rows.length, "home")}${rows.length <= 3 ? `: ${rows.map((r) => r.display).join(", ")}` : ""}`;

export function renderPlan(ui, a, { V }) {
  ui.title("Plan");
  const updates = a.installRows.filter((r) => r.status.kind === "update");
  const installs = a.installRows.filter((r) => r.status.kind !== "update");
  if (installs.length) ui.say(homesLine(`Install Recall ${V}`, installs));
  if (updates.length) ui.say(homesLine(`Update Recall to ${V}`, updates));
  const m = a.marketplace;
  if (m.copy === "differs") ui.say(`  Copy Recall ${V} again into ${ui.path(m.M)}: the copy there has other files`);
  else if (m.needsWrite && !a.installRows.length) ui.say(`  Restore Recall ${V}'s copy in ${ui.path(m.M)}, which the homes load it from`);
  for (const k of a.useKeys) ui.say(`  Use your ${k.provider.label} key from ${k.source} (${maskKey(k.key)})`);
  for (const k of a.saveKeys) ui.say(`  Save your ${k.provider.label} key to ~/.env${k.replaces ? " (it replaces the key there)" : ""}`);
  for (const k of a.keepOutKeys) ui.say(`  Keep your ${k.provider.label} key out of ~/.env, now and on later runs (--no-save-key)`);
  for (const k of a.accessChecks) ui.say(`  Check once that your key can ${k.provider.access.ability}: one tiny request, ${usd(k.provider.access.estimateUsd())}`);
  if (a.index) ui.say(`  Index what you typed in ${plural(a.index.homes, "home")}: ${plural(a.index.statements, "statement")}, ${a.index.texts ? about(a.index.embeddingUsd) : "no charge"}`);
  if (a.emptyIndex) ui.say("  Index: nothing to read yet; it grows as you use Claude Code or Codex");
  if (a.cards?.withIndex) ui.say(`  Write short summaries with your ${a.writer} CLI, in the background: about ${plural(a.cards.calls, "call")}, no API charge`);
  else if (a.cards) ui.say(`  Write short summaries of ${plural(a.cards.missing, "statement")} with your ${a.writer} CLI, in the background: no API charge`);
  if (a.existingIndex && !a.index) ui.say(`  Index: ${plural(a.existingIndex.statements, "statement")}, kept up to date as you work`);
  if (a.noIndex === "no-index") ui.say("  Index: not now (--no-index); Recall builds it in the background after your next prompt");
  if (a.noIndex === "skip-key") ui.say(`  Index: not now (--skip-key); run ${keep(ONE_LINER)} with a key to build it`);
  if (!a.noSpend) ui.say(`  Each prompt after that: about ${usd(DECISIONS_USD_PER_PROMPT)} (about ${Math.floor(1 / DECISIONS_USD_PER_PROMPT)} prompts per dollar)`);
  const cap = a.settings.cap;
  ui.say(cap.old !== null && cap.old !== cap.now ? `  Daily spend cap: ${dollars(cap.old)} → ${dollars(cap.now)}` : `  Daily spend cap: ${dollars(cap.now)} (change it with --daily-cap)`);
  if (a.launcher === "absent") ui.say("  Add the recall command: ~/.local/bin/recall");
  if (a.launcher === "stale") ui.say("  Update the recall command: ~/.local/bin/recall");
}

/** The data flows, shown before the go-ahead the first time a key is used for sending; `writer` is the CLI that writes the summaries. */
export function renderWhatLeaves(ui, dataDir, writer) {
  ui.title("What leaves this machine");
  ui.say(
    "  To OpenAI: each statement you typed, once, to index it (its first 2,000 characters, with secret-shaped text removed);"
      + " and on each prompt, your new message with a little context and about 200 earlier statements (260 characters each).",
    `  To your ${writer} CLI: your statements, about 40 at a time, to summarise them (with its own login).`,
    `  Stays here: the index, summaries, logs and caches in ${ui.path(dataDir)}. Credentials are never read.`,
  );
}
