// Which statements may be injected, from their cards (config excludeKinds, scopeFilter, repoAliases and the precision rules). Applied by the
// retrieval core to the whole history BEFORE ranking, so the judge and the top-N only ever see statements that could be injected. With no
// excluded kind and the scope filter off nothing is filtered and retrieval is v1's exactly (the precision rules narrow the card filter; they are not a filter of their own).
import { sameRepo } from "../repo-identity.mjs";
import { precisionCheck } from "./precision.mjs";
import { CROSS_REPO_KINDS } from "./schema.mjs";

/** Put each statement's card on its corpus item (`item.card`, absent when there is none). Returns how many items have a card. */
export function attachCards(corpus, cards) {
  let withCard = 0;
  for (const it of corpus.items) {
    const card = cards.get(it.id);
    if (card) { it.card = card; withCard++; } else delete it.card;
  }
  return withCard;
}

/**
 * The eligibility predicate for one query, or null when no card filter is on (no excluded kind and scopeFilter off). A statement with no card has no kind and no scope: not eligible.
 *   excludeKinds  a statement whose card is one of these kinds is not eligible (default question and status); every other kind is.
 *   scopeFilter   a statement said in the current repo (the same repo under repoAliases) is eligible whatever its card scope. A statement said in
 *                 another repo, in no repo, or with no current repo is eligible only when its card scope is global AND its kind is a rule or a
 *                 preference: corrections, decisions and other kinds never cross repos.
 *   precision rules  a statement that passes both of those is still not eligible when a precision rule keeps it out (precision.mjs: a
 *                 placeholder gist, a cited URL or path, a long cross-repo statement, a long rule or preference). Each such exclusion is
 *                 reported to `onExclude(reason, item)`, once, under the first rule that applies.
 * @param {{excludeKinds?: readonly string[], scopeFilter?: boolean, repoAliases?: object, excludeNewSessionGist?: boolean, excludeCitations?: boolean, crossRepoMaxChars?: number, ruleMaxChars?: number}} cfg
 * @param {string|null} currentRepo
 * @param {((reason: string, item: object) => void)|null} [onExclude]
 */
export function cardAllow(cfg, currentRepo, onExclude = null) {
  const exclude = new Set(cfg.excludeKinds ?? []);
  if (!exclude.size && !cfg.scopeFilter) return null;
  const precision = precisionCheck(cfg, currentRepo);
  return (item) => {
    const card = item.card;
    if (!card) return false;
    if (exclude.has(card.kind)) return false;
    if (cfg.scopeFilter && !sameRepo(item.repo, currentRepo, cfg.repoAliases) && !(card.scope === "global" && CROSS_REPO_KINDS.includes(card.kind))) return false;
    const reason = precision?.(item) ?? null;
    if (reason) { onExclude?.(reason, item); return false; }
    return true;
  };
}
