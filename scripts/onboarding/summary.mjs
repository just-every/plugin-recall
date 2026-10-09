// The end of a setup run: where Recall is on, what it costs, the state of the short summaries, the one Codex step, how to watch,
// check, pause and remove it, and the exact line that puts ~/.local/bin on the PATH of the person's shell. Also the Codex reminder an
// up-to-date run prints.
import path from "node:path";
import { cardsPath, loadCards } from "../lib/cards/cards-file.mjs";
import { createStore } from "../lib/store.mjs";
import { DECISIONS_USD_PER_PROMPT, dollars, usd } from "./estimate.mjs";
import { commandName, pathLine } from "./launcher.mjs";
import { ONE_LINER } from "./plugin-meta.mjs";
import { keep, padRows, plural } from "./ui.mjs";

/** The Codex trust step for these homes (Codex runs a plugin's hook only after the person approves it once per home). */
export function codexTrustLines(rows, homeDir) {
  if (!rows.length) return [];
  const defaultHome = path.join(homeDir, ".codex");
  return [
    "  Codex: approve Recall once in each Codex home's Hooks page; Codex asks on its next start:",
    ...padRows(rows.map((r) => [keep(path.resolve(r.home) === defaultHome ? "codex" : `CODEX_HOME=${r.display} codex`), keep(`(${r.display})`)]), { indent: "    " }),
    '    Choose "Trust all and continue" on the "Hooks need review" screen, or run /hooks.',
  ];
}

/** The state of the summaries: {line, pending} (pending: some are still being written, which doctor shows). */
function cardsState(dataDir, { cardsStarted, flags }) {
  if (flags.skipKey) return { line: `  Recall stays silent until it has a key: run ${keep(ONE_LINER)} when you have one.` };
  const store = createStore(dataDir);
  if (flags.noIndex && !store.loadState().lastIndexAt) return { line: "  Index: built in the background after your next prompt." };
  const ids = store.loadStatements().map((s) => s.id);
  const cards = loadCards(cardsPath(dataDir));
  const done = ids.filter((id) => cards.has(id)).length;
  if (!ids.length) return { line: "  Summaries: none yet; Recall writes them as you use Claude Code or Codex." };
  if (done === ids.length) return { line: `  Summaries: all ${ids.length} written.` };
  const where = cardsStarted ? "being written in the background" : "written in the background after your next prompt";
  if (!done) return { line: `  Summaries: ${where} (${plural(ids.length, "statement")}).`, pending: true };
  return { line: `  Summaries: ${done} of ${ids.length} written; the rest are ${where}.`, pending: true };
}

/** @returns {number} the exit code */
export function printSummary(ui, { results, spent, cfg, V, flags, homeDir, env, cardsStarted, notes = [] }) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const R = commandName({ homeDir, env, dataDir: cfg.dataDir, V });
  ui.blank();
  if (failed.length) {
    ui.say(`Finished with problems: Recall could not be installed in ${plural(failed.length, "home")} (listed above).`,
      `  To retry ${failed.length === 1 ? "it" : "them"}: ${keep(`${ONE_LINER} --homes ${failed.map((r) => r.row.display).join(",")}`)}`);
  } else ui.say(`Done. Recall ${V} is on in ${plural(ok.length, "home")}.`);
  for (const note of notes) ui.item("warn", note);
  ui.say(`  Spent now: ${usd(spent)}. Each prompt: about ${usd(DECISIONS_USD_PER_PROMPT)}. Recall stops for the day at ${dollars(cfg.dailyCapUsd)}.`);
  const cards = cardsState(cfg.dataDir, { cardsStarted, flags });
  ui.say(cards.line);
  ui.say(...codexTrustLines(ok.filter((r) => r.row.host === "codex" && !r.trusted).map((r) => r.row), homeDir));
  if (ok.some((r) => r.row.host === "claude" && r.outcome !== "up to date")) {
    ui.say("  Claude Code: sessions already open load Recall after a restart or /reload-plugins.");
  }
  ui.raw(
    `  Watch it work:  ${R} monitor`,
    `  Check it:       ${R} doctor${cards.pending ? "   (it also shows how far the summaries are)" : ""}`,
    `  Pause it:       ${ONE_LINER} pause`,
    `  Resume it:      ${ONE_LINER} resume`,
    `  Remove it:      ${ONE_LINER} uninstall`,
  );
  if (R === "~/.local/bin/recall") {
    ui.say("  To type just recall, add ~/.local/bin to your PATH (then open a new terminal):");
    ui.raw(`    ${pathLine(env)}`);
  }
  return failed.length ? 1 : 0;
}
