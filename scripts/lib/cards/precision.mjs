// The precision rules: four card-eligibility rules that keep out the statements a live audit found most often misleading (38% of injected
// cards were; offline over 274 labelled messages these four cut the messages carrying a misleading card by 10.2 points, CI [-15.0, -5.5],
// and left the share with a useful card unchanged, -0.7 [-4.4, +2.6]). They are applied with the card filter (eligibility.mjs), before
// ranking, so the next eligible statement takes the slot of one they keep out.
//
//   RG   gist-placeholder   the card's gist is the new-session placeholder (gist_source "none": nothing was said before it; a session-opening
//                           message is a one-off task brief)                                               config excludeNewSessionGist
//   RU   cites-location     the statement cites a URL, a local port or a file path                         config excludeCitations
//   R5   cross-repo-long    said in another repo than the current one, and crossRepoMaxChars characters or more      config crossRepoMaxChars
//   R4v  long-directive     a rule or a preference of ruleMaxChars characters or more                       config ruleMaxChars
//
// A statement that several rules would keep out is counted under the first of them, in the order above. A setting that is absent, false or
// 0 switches its rule off (so a bare {excludeKinds, scopeFilter} object is the filter as it was before these rules).
import { sameRepo } from "../repo-identity.mjs";

/** RU: a URL, a local address or port, a home path, or a source or document file name. */
export const CITATION = /https?:\/\/|127\.0\.0\.1|localhost|:\d{4,5}\b|\/Users\/|~\/|\.(ts|js|mjs|md|json|tsx)\b/;

/** The gist_source of a card that has no context before it: its gist is the new-session placeholder. */
export const PLACEHOLDER_GIST_SOURCE = "none";

/** The kinds R4v applies to. */
const DIRECTIVE_KINDS = Object.freeze(["rule", "preference"]);

export const hasPlaceholderGist = (card) => card.gist_source === PLACEHOLDER_GIST_SOURCE;
export const citesLocation = (text) => CITATION.test(text);
export const isCrossRepo = (repo, currentRepo, aliases) => !sameRepo(repo, currentRepo, aliases);

/**
 * The rules in force under a configuration, in precedence order: [{rule, reason, hit(item, card)}], where hit says the rule keeps the
 * statement out. `item` is a corpus item ({text, repo}) and `card` its card. A rule that is off is not in the list.
 * @param {{excludeNewSessionGist?: boolean, excludeCitations?: boolean, crossRepoMaxChars?: number, ruleMaxChars?: number, repoAliases?: object}} cfg
 * @param {string|null} currentRepo the repo of the session the query is for
 */
export function precisionRules(cfg, currentRepo) {
  const rules = [];
  if (cfg.excludeNewSessionGist === true) rules.push({ rule: "RG", reason: "gist-placeholder", hit: (item, card) => hasPlaceholderGist(card) });
  if (cfg.excludeCitations === true) rules.push({ rule: "RU", reason: "cites-location", hit: (item) => citesLocation(item.text) });
  if (cfg.crossRepoMaxChars > 0) rules.push({ rule: "R5", reason: "cross-repo-long", hit: (item) => item.text.length >= cfg.crossRepoMaxChars && isCrossRepo(item.repo, currentRepo, cfg.repoAliases) });
  if (cfg.ruleMaxChars > 0) rules.push({ rule: "R4v", reason: "long-directive", hit: (item, card) => DIRECTIVE_KINDS.includes(card.kind) && item.text.length >= cfg.ruleMaxChars });
  return rules;
}

/** Every reason a precision rule can give, for the labels that name them. */
export const PRECISION_REASONS = Object.freeze(["gist-placeholder", "cites-location", "cross-repo-long", "long-directive"]);

/**
 * The precision check for one query, or null when every rule is off. The check takes a corpus item that carries its card and returns the
 * reason of the first rule that keeps it out, or null when none does.
 */
export function precisionCheck(cfg, currentRepo) {
  const rules = precisionRules(cfg, currentRepo);
  if (!rules.length) return null;
  return (item) => rules.find((r) => r.hit(item, item.card))?.reason ?? null;
}

/** Are any of the precision rules on? */
export const precisionOn = (cfg) => cfg.excludeNewSessionGist === true || cfg.excludeCitations === true || cfg.crossRepoMaxChars > 0 || cfg.ruleMaxChars > 0;

/**
 * A tally of what the precision rules kept out of one query, per reason: {reason: {count, ids}}, ids being the newest `maxIds` statements
 * (the query scans the history oldest first). The turn log records it; the whole history is scanned, so the count can be in the thousands.
 */
export function exclusionTally(maxIds = 50) {
  const by = new Map();
  return {
    add(reason, item) {
      const e = by.get(reason) ?? by.set(reason, { count: 0, ids: [] }).get(reason);
      e.count++;
      e.ids.push(item.id);
      if (e.ids.length > maxIds) e.ids.shift();
    },
    /** @returns {Object<string, {count: number, ids: string[]}>|null} null when nothing was kept out */
    summary: () => (by.size ? Object.fromEntries(by) : null),
  };
}
