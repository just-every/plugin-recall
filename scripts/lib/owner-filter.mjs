// What counts as the user's words = the text-filter layers (scripts/lib/text-filter, see owner-text.mjs) PLUS a few host turns that arrive
// as user messages and are decided on the raw turn:
//   - a bare skill invocation  `[$some-skill](.../skills/some-skill/SKILL.md)`  (a button, not a sentence)
//   - Every Code's automatic messages: `== System Status ==`, and the notices its typed-prompt log records as if typed (`System: access mode
//     changed to ...`, `System: Working directory changed from ...`, `Finalize branch '<b>' via ...`, `Auto-resolve status check`,
//     `[developer] Background auto-review ...`); its auto-resolve loop's canned request (`Is this a real issue introduced by our changes? If so,
//     please fix and resolve all similar issues.`, sent bare to the log and behind its preface `You are continuing an automated /review
//     resolution loop.` in a rollout; the owner's own earlier wordings of the question differ from it and are kept)
//   - host prompts a host submits on its own and writes as the person's turn: Claude Desktop's auto-resume after an interruption (`I hit my usage
//     limit while you were working, but it has reset now. Please continue from where you left off.`, and the same message after the app was
//     quit, the computer slept, the context window filled up or a remote host restarted: always the whole message, ending in its request to
//     continue), the /init prompt of Codex and Every Code (`Generate a file named AGENTS.md that serves as a contributor guide for this
//     repository.`), Every Code's notice that a slash command is not
//     implemented (`/browser command is not yet fully implemented`, logged as typed), and Every Code's `[branch created]` marker, which is taken
//     off a row so that what was typed after it stays (a row left with only a slash command, or a fragment of one, holds no words)
//   - a turn that is nothing but Every Code's image placeholder (`[image: Screenshot ... .png]`): an attachment, no words
//   - the Codex app's review command (`## Code review guidelines:` ... its canned request)
//   - the Codex plan-mode button, the unified-exec warning, review-findings envelopes, the MCP-app notice
//   - automation turns that arrive as user messages: Codex thread heartbeats (`<heartbeat>`), scheduled tasks (`<scheduled-task>`),
//     delegations from another thread (`<codex_delegation>`)
// `<pasted_content>` is the user's own paste or dictation, unwrapped, not dropped. With the "fleet" profile on, a UI element the user
// selected on a page (`<launch-selected-element>...`) is peeled so that what was typed after it stays.
import { peelRaw } from "./text-filter/fleet.mjs";
import { ownerText } from "./text-filter/owner-text.mjs";

const SKILL_INVOCATION = /^\[\$[\w:.-]+\]\([^)]*SKILL\.md\)\s*$/;
const HARNESS_PREFIX = [
  /^== System Status ==/,
  /^System: [\w ]{1,40} changed (?:from|to)\b/,
  /^Finalize branch '[^']+' via\b/,
  /^Auto-resolve status check\b/,
  /^Is this a real issue introduced by our changes\? If so, please fix and resolve all similar issues\./,
  /^You are continuing an automated \/review resolution loop\./,
  /^\[developer\]\s/,
  /^#+\s*code review guidelines:/i,
  /^PLEASE IMPLEMENT THIS PLAN:/,
  /^Warning: The maximum number of unified exec processes/,
  /^# Review findings\b/,
  /^An MCP app initiated this message\./,
  /^(?:I hit my usage limit|The app was quit|My computer went to sleep|The context window filled up|Claude Code was restarted on the remote host)\b[^\n]{0,80}\bwhile you were working\b[^\n]{0,80}\bPlease continue from where you left off\.?$/,
  /^Generate a file named AGENTS\.md that serves as a contributor guide for this repository\./,
  /^(?:\/[\w:-]+ )?command is not yet fully implemented\.?$/,
];
// Every Code's marker in front of the row typed after /branch made a worktree.
const BRANCH_CREATED = /^\s*\[branch created\]\s*/;
// What is left when a row held only a slash command, whole or cut short (`/br`, `/branc`): no words.
const COMMAND_ONLY = /^\/[\w:-]*$/;
// Every Code's attachment placeholder, which its typed-prompt log keeps for each image the person attached.
const IMAGE_ONLY = /^(?:\[image: [^\]\n]*\]\s*)+$/i;
// Checked on the raw turn: the envelope peeling would keep the text inside an unknown tag.
const AUTOMATION_TAG = /^\s*<(heartbeat|scheduled-task|codex_delegation)\b/;
const PASTED_OPEN = /<pasted_content\b[^>]*>/g;
const PASTED_CLOSE = /<\/pasted_content\b[^>]*>/g;

/**
 * The text-filter options a config carries (any subset: a bare `{minChars: 20}` is the defaults), for judgeOwnerText.
 * @param {object} config
 * @param {number} [minText] the length floor (default: config.minChars)
 */
export const filterOptions = (config, minText = config.minChars) => ({
  minText,
  ownerEmails: config.ownerEmails ?? [],
  ownerNames: config.ownerNames ?? [],
  filterProfiles: config.filterProfiles ?? [],
  dropPatterns: config.dropPatterns ?? [],
});

/** ownerText() plus the extra rules. Same result shape: {text, ...} or {reason}. `options` is filterOptions(config). */
export function judgeOwnerText(raw, options) {
  let text = String(raw);
  const tag = AUTOMATION_TAG.exec(text);
  if (tag) return { reason: `automation-${tag[1]}` };
  if (options.filterProfiles?.includes("fleet")) text = peelRaw(text);
  if (BRANCH_CREATED.test(text)) {
    text = text.replace(BRANCH_CREATED, "");
    if (COMMAND_ONLY.test(text.trim())) return { reason: "harness" };
  }
  const judged = ownerText(text.replace(PASTED_OPEN, " ").replace(PASTED_CLOSE, " "), options);
  if (!judged.text) return judged;
  if (SKILL_INVOCATION.test(judged.text)) return { reason: "skill-invocation" };
  if (HARNESS_PREFIX.some((re) => re.test(judged.text))) return { reason: "harness" };
  if (IMAGE_ONLY.test(judged.text)) return { reason: "image-only" };
  return judged;
}
