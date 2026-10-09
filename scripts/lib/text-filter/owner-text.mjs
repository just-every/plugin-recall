// What counts as a person's own words, and what is thrown away.
//
// The index holds one thing: things the user typed or dictated (requests, direction, answers, rejections). A transcript is mostly not that. It
// is tool output, skill bodies, system reminders, another agent's message delivered into the session, and the user's own words wrapped in
// envelopes. Every rule exists because one of those would otherwise read as something the user said.
//
// The rules are counted, not silent: the indexer tallies every drop by reason. Layers, in the order a turn meets them:
//   1. envelopes.mjs   peel (keep the words, remove the wrapper; desktop.mjs for the desktop apps' envelopes)
//   2. harness.mjs     drop turns the host or its harness writes (always on)
//   3. fleet.mjs       drop turns agent orchestration tooling writes (config filterProfiles: ["fleet"], off by default)
//   4. dropPatterns    drop turns that match a regular expression from the config
//   5. secrets.mjs     redact secret-shaped spans; drop other people's data
// ownerNames and ownerEmails (config) switch on the two rules that need to know who "you" are; both are empty by default.
import { normalize, peel } from "./envelopes.mjs";
import { harnessReason } from "./harness.mjs";
import { fleetReason, labelPattern } from "./fleet.mjs";
import { EMAIL, LONG_DIGITS, REDACTED, redactSecrets } from "./secrets.mjs";

export { forbiddenPath } from "./secrets.mjs";
export { normalize } from "./envelopes.mjs";

// A message another session delivered through a tasks CLI: `[repo] sender: ...`. Only applied when ownerNames is set: a sender that is not
// one of those names is somebody else speaking.
const DELIVERED = /^\[[a-z0-9._-]+\]\s+([a-z0-9._-]+)(?:\s+of\s+[a-z0-9._-]+)?(?:\s+about\s+[^:]+)?:\s/i;

/** Below this a line is an acknowledgement ("yes", "do it", "ok ship"), not a request. */
const MIN_TEXT = 40;
/** Above this only the head is kept: a pasted report is not the user's sentence. The cut says so (`[cut]`), unlike an ellipsis someone typed. */
const MAX_TEXT = 4000;
const CUT_MARK = " [cut]";

/** Compile the user's dropPatterns once per distinct list. */
const compiled = new WeakMap();
const patternsOf = (list) => {
  if (!list.length) return list;
  if (!compiled.has(list)) compiled.set(list, list.map((p) => new RegExp(p, "i")));
  return compiled.get(list);
};

/**
 * Peel the envelopes and say what is left. Returns `{ text }` for the user's words (with `peeled`, the desktop-app envelopes that came off,
 * when any did), or `{ reason }` naming the rule that threw it away.
 * @param {string} raw
 * @param {{minText?: number, ownerEmails?: readonly string[], ownerNames?: readonly string[], filterProfiles?: readonly string[], dropPatterns?: readonly string[]}} [o]
 */
export function ownerText(raw, { minText = MIN_TEXT, ownerEmails = [], ownerNames = [], filterProfiles = [], dropPatterns = [] } = {}) {
  const fleet = filterProfiles.includes("fleet");
  const peeledTurn = peel(raw);
  let text = peeledTurn.text;
  // The record's own label comes off before anything reads the sentence, so a labelled brief is still seen as a brief.
  if (fleet) text = text.replace(labelPattern(ownerNames), "");

  if (!text) return { reason: "empty" };
  const harness = harnessReason(text);
  if (harness) return { reason: harness };
  if (fleet) {
    const reason = fleetReason(text);
    if (reason) return { reason };
  }
  for (const pattern of patternsOf(dropPatterns)) if (pattern.test(text)) return { reason: "drop-pattern" };

  if (ownerNames.length) {
    const delivered = DELIVERED.exec(text);
    if (delivered && !ownerNames.map((n) => n.toLowerCase()).includes(delivered[1].toLowerCase())) return { reason: "delivered-by-agent" };
    if (delivered) text = normalize(text.slice(delivered[0].length));
  }

  const scrubbed = redactSecrets(text);
  text = normalize(scrubbed.text);
  // Nothing but the marker left: the turn was the key, and there is no sentence under it to keep.
  if (scrubbed.redacted && !text.replaceAll(REDACTED, "").trim()) return { reason: "key-material" };

  if (LONG_DIGITS.test(text)) return { reason: "third-party" };
  if (ownerEmails.length) {
    const mine = ownerEmails.map((a) => a.toLowerCase());
    if ((text.match(EMAIL) ?? []).some((address) => !mine.includes(address.toLowerCase()))) return { reason: "third-party" };
  }

  if (text.length < minText) return { reason: "too-short" };
  const truncated = text.length > MAX_TEXT;
  return {
    text: truncated ? `${text.slice(0, MAX_TEXT)}${CUT_MARK}` : text,
    truncated,
    ...(scrubbed.redacted ? { redacted: scrubbed.redacted } : {}),
    // the desktop-app envelopes that came off to leave these words (envelopes.mjs)
    ...(peeledTurn.peeled.length ? { peeled: peeledTurn.peeled } : {}),
  };
}
