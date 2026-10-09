// What the prompt hook (and `recall eval --inject-out`) injects for a ranking: the pipeline's gate, then the statements already injected
// in this session are dropped (noRepeat), then the hubs (statements already injected into hubMaxSessions other sessions recently), then
// repeats of the same text, then the top k, then the block. One function, so the evaluation
// shows exactly what the hook would say. With the apply gate on, the hook runs the gate (apply-gate.mjs) over the survivors, between the
// repeats-of-the-same-text step and the k cut; `recall eval` and `recall query` replay the pipeline without it.
import { cardFilterOn } from "./config.mjs";
import { dedupeKey, dedupeRanked } from "./dedupe.mjs";
import { formatCards, formatInjection } from "./context.mjs";
import { gated } from "./retrieve.mjs";

/** What a session has been told already, as the ids and the dedupe keys of the texts. */
export const noPrior = () => ({ ids: new Set(), keys: new Set() });

/**
 * The statements that may be injected, before the k cut: the pipeline's gate, then repeats of this session, then hubs, then repeats of the
 * same text. These are the apply gate's survivors, in the pipeline's order.
 * @param {{ranked: object[], corpus: object, pipeline: string, cfg: object, prior?: {ids: Set<string>, keys: Set<string>}, hubIds?: Set<string>}} o
 * @returns {{passing: object[], repeats: string[], hubs: string[]}} repeats: gated entries dropped because the session had them; hubs: gated entries dropped because they are hubs
 */
export function survivorsOf({ ranked, corpus, pipeline, cfg, prior = noPrior(), hubIds = new Set() }) {
  const textOf = (e) => corpus.items[corpus.byId.get(e.id)].text;
  const repeats = [];
  let passing = gated(pipeline, ranked, cfg, Infinity);
  // A repeat is dropped before the k cut, so it never costs a slot: the next statement takes it.
  if (cfg.noRepeat) {
    passing = passing.filter((e) => {
      const again = prior.ids.has(e.id) || prior.keys.has(dedupeKey(textOf(e)));
      if (again) repeats.push(e.id);
      return !again;
    });
  }
  const hubs = [];
  if (cfg.hubMaxSessions > 0) {
    passing = passing.filter((e) => {
      if (hubIds.has(e.id)) hubs.push(e.id);
      return !hubIds.has(e.id);
    });
  }
  // Gate first, then drop repeats of the same text (keeping the best-scored copy), then take k: a duplicate never costs a slot.
  return { passing: dedupeRanked(passing, textOf), repeats, hubs };
}

/** The injected block for the picked entries: typed cards when the card filter is on (every injectable statement has a card); v1's dated quotes otherwise. */
export function injectionContext({ picked, corpus, cfg, sessionId = null, currentRepo = null, source = null }) {
  const items = picked.map((e) => corpus.items[corpus.byId.get(e.id)]);
  return cardFilterOn(cfg) ? formatCards(items, currentRepo, cfg.repoAliases, source) : formatInjection(items, sessionId);
}

/**
 * @param {{ranked: object[], corpus: object, pipeline: string, cfg: object, sessionId?: string|null, currentRepo?: string|null,
 *          prior?: {ids: Set<string>, keys: Set<string>}, hubIds?: Set<string>, source?: {root: string}|null}} o
 *   hubIds  the statements that are hubs now (hubs.mjs), from the live hub index or a replay's explicit history
 *   source  the plugin root of the running hook: cards then carry their transcript source and the command that reads around it (context.mjs)
 * @returns {{picked: object[], repeats: string[], hubs: string[], context: string|null}} repeats: gated entries dropped because the session had
 *   them; hubs: gated entries dropped because they are hubs. The apply gate (apply-gate.mjs) is not part of this function: the prompt hook runs it
 *   between survivorsOf and injectionContext.
 */
export function selectInjection({ ranked, corpus, pipeline, cfg, sessionId = null, currentRepo = null, prior = noPrior(), hubIds = new Set(), source = null }) {
  const { passing, repeats, hubs } = survivorsOf({ ranked, corpus, pipeline, cfg, prior, hubIds });
  const picked = passing.slice(0, cfg.k);
  return { picked, repeats, hubs, context: injectionContext({ picked, corpus, cfg, sessionId, currentRepo, source }) };
}

/** What a session has been told, from the ids recorded in its turn state (an id no longer in the corpus still counts as told). */
export function priorOf(ids, corpus) {
  const keys = new Set();
  for (const id of ids) if (corpus.byId.has(id)) keys.add(dedupeKey(corpus.items[corpus.byId.get(id)].text));
  return { ids: new Set(ids), keys };
}
