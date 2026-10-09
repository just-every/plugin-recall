// Help text. `--help` (with or without `setup`, and `recall help`) prints HELP: the setup command with its options, then the everyday
// commands, every one in the npx form, since `recall` may not be on PATH yet. `recall help --all` lists the everyday commands with all their
// options, wrapped at the terminal's width. The developer commands (evaluation and research) are listed only with RECALL_DEVELOPER=1.
import { ONE_LINER } from "./plugin-meta.mjs";
import { wrap } from "./ui.mjs";

export function help(V) {
  return [
    `Recall ${V} · memory for Claude Code and Codex`,
    "",
    `${ONE_LINER} [options]`,
    "  Sets up Recall in every Claude Code and Codex home on this machine, or updates it.",
    "",
    "Options:",
    "  --yes, -y           accept every question (homes left out earlier stay out)",
    "  --homes <list>      act only on these homes (comma separated, ~/x or absolute)",
    "  --exclude <list>    never install into these homes (~/.claude and ~/.codex are still read)",
    "  --new-key           paste a different OpenAI key; it replaces the one in ~/.env",
    "  --no-index          skip the first index now; Recall builds it after your next prompt",
    "  --skip-key          set up without a key (implies --no-index); Recall is silent until it has one",
    "  --no-save-key       never save the key to ~/.env (the hooks then need OPENAI_API_KEY in their app)",
    "  --daily-cap <usd>   the daily spend cap (default 1); on a later run it changes the cap",
    "  --dry-run           show what would happen, change nothing",
    "  --help, -h          this help",
    "",
    `Other commands: ${ONE_LINER} <command>`,
    "  doctor              check that everything works",
    "  monitor             watch what Recall does, live, in your browser",
    '  query "<text>"      search what you said before',
    "  logs                what Recall did today",
    "  spend               what Recall has spent",
    "  pause               stop Recall at once, in every agent home, without removing it",
    "  resume              turn Recall back on",
    "  uninstall           remove Recall from every agent home (options: uninstall --help)",
    "  help --all          every command with all its options",
    "Once ~/.local/bin is on your PATH, recall <command> does the same.",
  ].join("\n");
}

export const UNINSTALL_HELP = [
  `${ONE_LINER} uninstall [options]   (also: recall uninstall)`,
  "  --yes, -y        do not ask",
  "  --homes <list>   remove Recall only from these homes (comma separated); it stays in the others",
  "  --purge          also delete ~/.plugin-recall (index, summaries, logs, settings)",
  "  --help, -h       this help",
].join("\n");

export const PAUSE_HELP = [
  `${ONE_LINER} pause   (also: recall pause)`,
  '  Stops Recall at once in every agent home, without removing it: sets "disabled": true in ~/.plugin-recall/config.json.',
  `  Turn it back on with: ${ONE_LINER} resume`,
].join("\n");

export const RESUME_HELP = [
  `${ONE_LINER} resume   (also: recall resume)`,
  '  Turns Recall back on after pause: clears "disabled" in ~/.plugin-recall/config.json.',
].join("\n");

/** [usage, what it does] for every everyday command, as `recall help --all` lists them. */
const EVERYDAY = [
  ["recall setup [--yes] [--homes <list>] [--exclude <list>] [--new-key] [--no-index] [--skip-key] [--no-save-key] [--daily-cap <usd>] [--dry-run]",
    "set up or update Recall in every agent home (also: recall, recall install)"],
  ["recall pause", "stop Recall at once, in every agent home, without removing it"],
  ["recall resume", "turn Recall back on"],
  ["recall uninstall [--yes] [--purge] [--homes <list>]", "remove Recall from every agent home (--purge: and delete ~/.plugin-recall; --homes: only from these homes)"],
  ["recall doctor [--json] [--offline]", "check the setup: Node, the key, the CLIs, the homes, the index, the installs"],
  ["recall monitor [--port 4777] [--host 127.0.0.1]", "a live web view of what Recall does (read-only, on this machine only)"],
  ['recall query "<text>" [--repo <name>] [--any-repo] [--kind <kind[,kind]>] [--json] [--k <n>] [--session <id>] [--before <iso>] [--no-cache]',
    "search what you said before (the text may also be given as --text <t>)"],
  ["recall show <statement-id> [--before 4] [--after 3] [--json]", "the conversation around a statement Recall brought back"],
  ["recall logs [--day YYYY-MM-DD] [--days n] [--json]", "what Recall did, and why it stayed silent (default: today, UTC)"],
  ["recall spend", "what Recall has spent today and in all, and the caps"],
  ["recall index [--no-embed] [--enrich] [--quiet] [--dry-run]", "index what you typed now (--enrich: and summarise it; --dry-run: count only)"],
  ["recall enrich [--limit n] [--worker auto|claude|codex] [--model haiku]", "write the short summary of every statement that has none"],
  ["recall help [--all], recall --version", "this help, the version"],
];

const DEVELOPER = [
  ["recall query ... [--pipeline <name>] [--mode prompt|stop]", "query under another pipeline or mode"],
  ["recall index --durable [--corpus <jsonl>]", "also build the offline durable typing"],
  ["recall enrich --corpus <corpus jsonl> --out <cards jsonl>", "write cards for an evaluation corpus instead of the index"],
  ["recall eval --corpus <jsonl> --cases <jsonl> --pipeline <name> --out <jsonl> [--cards <jsonl>] [--inject-out <jsonl>] [--hub-history <jsonl>] [--v1|--v2] [--embedding-store dir] [--concurrency n] [--limit n] [--no-cache]",
    "replay an evaluation"],
  ["recall pipelines", "the named pipelines"],
];

const block = (rows, width) => rows.flatMap(([usage, what]) => [...wrap(`  ${usage}`, width), ...wrap(`      ${what}`, width)]);

/** `recall help --all`, wrapped at `width`; `developer` adds the evaluation and research commands. */
export function fullHelp({ width, developer = false }) {
  const out = [...wrap(`Commands (${ONE_LINER} <command>, or recall <command>):`, width), ...block(EVERYDAY, width)];
  if (developer) out.push("", "Developer commands (evaluation and research):", ...block(DEVELOPER, width));
  return out.join("\n");
}
