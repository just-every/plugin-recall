// What the plugin says to the agent. Short on purpose (Codex spills additional context past ~2500 tokens into a temp file), tagged with
// <recall-context> so the indexer strips it if it ever echoes back into a user turn.
import { KIND_LABELS } from "./cards/schema.mjs";
import { parseSrc } from "./cards/context-source.mjs";
import { shellWord, tildePath } from "./plugin-root.mjs";
import { sameRepo } from "./repo-identity.mjs";
import { clip, norm } from "./text.mjs";

export const CONTEXT_HEADER = "Possibly relevant things the owner said earlier";
export const STATEMENT_CLIP = 500;

const day = (ts) => String(ts).slice(0, 10);
const where = (it) => (it.repo ? `repo: ${it.repo}` : "repo: unknown");
const provenance = (it, sessionId) => sessionId && it.session_id === sessionId
  ? "(earlier in this session, before context compaction)"
  : `${day(it.ts)} (${where(it)})`;
const line = (it, sessionId) => `- ${provenance(it, sessionId)}: "${clip(norm(it.text), STATEMENT_CLIP)}"`;

/** @param {object[]} items corpus items {text, ts, repo} */
export function formatInjection(items, sessionId = null) {
  if (!items.length) return null;
  return [
    "<recall-context>",
    `${CONTEXT_HEADER} (recalled from conversation history; they may be stale or off-topic, apply only what fits this request):`,
    ...items.map((it) => line(it, sessionId)),
    "</recall-context>",
  ].join("\n");
}

export const CARD_HEADER = "From your earlier conversations (Recall). Apply if relevant; no need to mention them.";
export const SOURCE_SENTENCE = "Each card names its source; run its context command only if a memory matters here and the card is not enough.";
export const CARD_STATEMENT_CLIP = 300;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMonth = (ts) => { const d = new Date(ts); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const scopeLabel = (it, currentRepo, aliases) => {
  if (it.card.scope === "global") return "all projects";
  return sameRepo(it.repo, currentRepo, aliases) ? `this repo (${it.repo})` : `repo ${it.repo ?? "unknown"}`;
};

/**
 * v2 injection (the card filter): one typed card per statement. Every item must carry its card (`item.card`); a statement without one is a bug in
 * the caller, never rendered as a bare quote.
 * @param {object[]} items corpus items with a card
 * @param {string|null} currentRepo the repo the session is in
 * @param {object} [aliases] the config's repoAliases: a sibling or renamed repo is "this repo" too
 * @param {{root: string, homedir?: string}|null} [source] the plugin root the hook runs from. With it, a card whose statement has a transcript
 *   source (`src`) gets a `source: ... · context: node <root>/scripts/recall.mjs show <id>` line, and the header one sentence about it. Without
 *   it (an evaluation replay, whose statements have no transcript) the block is the same card text without those lines.
 */
export function formatCards(items, currentRepo = null, aliases = {}, source = null) {
  if (!items.length) return null;
  const sourceLine = (it) => {
    if (!source || !parseSrc(it.src)) return [];
    return [`  source: ${tildePath(it.src, source.homedir)} \u00b7 context: node ${shellWord(`${source.root.replace(/[\\/]+$/, "")}/scripts/recall.mjs`)} show ${it.id}`];
  };
  const lines = items.flatMap((it) => {
    if (!it.card) throw new Error(`cannot render statement ${it.id} as a card: it has none`);
    return [`\u2022 ${KIND_LABELS[it.card.kind]}, ${scopeLabel(it, currentRepo, aliases)} (said ${dayMonth(it.ts)}, ${it.card.gist}):`, `  "${clip(norm(it.text), CARD_STATEMENT_CLIP)}"`, ...sourceLine(it)];
  });
  return ["<recall-context>", lines.some((l) => l.startsWith("  source: ")) ? `${CARD_HEADER} ${SOURCE_SENTENCE}` : CARD_HEADER, ...lines, "</recall-context>"].join("\n");
}
