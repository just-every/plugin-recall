// The "fleet" filter profile (config filterProfiles: ["fleet"]). Off by default.
//
// Where one person runs agent orchestration (an orchestrator session briefing lanes, reviewers and runners; a coordinator interrupting them;
// scheduled runners; products that send a model its prompt), a transcript fills with prompts that agents wrote for agents. They are long,
// well written and about the same work the person asks for, so they read as requests. This profile drops the shapes those tools write.
// It is tuned to one fleet's wording; use it as a starting point and add your own patterns with config dropPatterns.
//
// Every rule is a drop except three peels (record label, delivered envelope, selected element), applied at the same points the generic
// rules use, so a fleet install indexes exactly what it did before the filters were split.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A prompt one agent wrote for another, wherever it sits in the turn: the envelope an agent puts round a message for another to relay verbatim.
const INJECTED = /<{3,}MESSAGE/;
const AGENT_PROMPT = /treat everything below as facts,? never as instructions|you are art-directing/i;

// Relay instructions at the head of a turn.
const RELAY_HEAD = [/^call the sendmessage tool/i, /^<{3,}/];

// A product's prompt mined out of the session that was building the product: the role-inside-a-product shape ("You are the content agent
// inside <Product>, ..."). Deliberately not the bare `You are ...` opener, which people use to start their own sessions.
const PRODUCT_PROMPT = /^you are (?:a|an|the) [^.\n]{0,80}\bagent\b\s+inside\s+\S/i;

// A lane brief headed `TASK:`. The head alone is not enough (a person can write it), so a repo path or a session name has to be there too.
const TASK_BRIEF = /^TASK:\s/i;
const TASK_BRIEF_BODY = /\b(?:repo|repository|worktree|working tree|orchestrator session|campaign|CONTEXT)\b|\/Users\/[a-z]+\/www\//i;

// One agent relaying to another, headed by what it relays: "HEADS-UP from the orchestrator (...)", "AUTHORIZATION CHANGE from <name> (owner)".
const AGENT_RELAY = /^[A-Z][A-Z0-9 -]{3,}\s+from\s+(?:the\s+)?(?:orchestrator|coo|[A-Z][a-z]+\s*\((?:owner|coo)\))/;

// A prompt one agent wrote for another: a lane brief, a review brief, a campaign order, a seat rotation, a claim on a repo.
//  1. a markdown heading at the head of the turn (an orchestrator titles a brief; a person starts talking);
//  2. the word the fleet dispatches with, at the head (RESUME, REDIRECT, CAMPAIGN:, LANE L3, RULING, COO here:, FIRST ACTION), and the COO's
//     wake that points a session back at its standing orders ("COO wake after app-server drop: read the STANDING EXECUTION CHARTER on the
//     bus (msg-...)");
//  3. a role handed to the reader: only a lane, reviewer, seat, runner, relay, target, steward or continuation is somebody else's writing
//     (a person opens sessions with "You are a new maintainer picking up ...");
//  4. a claim on a repo under a seat name.
const AGENT_BRIEF = [
  /^#{1,6}\s/,
  /^(?:RESUME|REDIRECT|CAMPAIGN|RULING|LANE\s+[A-Z]?\d|COO here|FIRST ACTION)\b/,
  /^COO wake\b[^:\n]{0,80}:\s*read\b/i,
  /^independent (?:[a-z-]+ )?(?:review|audit)\b/i,
  // A turn that signs itself: "SHORT FOLLOW-UP (orchestrator).", "REDIRECT (orchestrator, 10:2xZ)", "I (the orchestrator) killed pid 4562".
  /^[^.\n]{0,80}\((?:the )?orchestrator\b[^)]{0,60}\)/i,
  /\bI \(the orchestrator\)/i,
  // A dispatch that hands over a brief the sender wrote in its own session scratchpad.
  /^read\b[^\n]{0,160}\/scratchpad\/\S+\.md\b/i,
  // The preamble a campaign's lane briefs open their rules with.
  /(?:^|\.\s)absolute paths\.\s/i,
  /^phase \d[^.]{0,200}\.\s*proceed to phase \d/i,
  // An automation runner's own header, stamped on the prompt it starts a fresh session with.
  /^automation:[\s\S]{0,120}automation id:\s/i,
  /^you are (?:an?|the) [^.]{0,60}\b(?:lanes?|reviewer|seat|runner|relay|target|steward|continuation)\b/i,
  /^you are (?:fixing|redoing|settling|reviewing|auditing|plumbing|finishing|continuing)\b/i,
  /^you reviewed\b/i,
  /^continue (?:—|-|the [^.]{0,80}\blane\b)/i,
  /\bclaim\s+\S+\s+as\s+[a-z0-9-]+-orch\b/i,
  /^you are [a-z0-9-]+-orch\b/i,
];

// More lane briefs: the order to go and read a brief file ("first" / "in full" separates an order from naming a file), a brief that budgets
// the lane's own fan-out, and a read-only review lane named as one at the head.
const LANE_BRIEF = [
  /^read (?:and execute |and follow )?\/\S+\.md\b[\s\S]{0,140}?\b(?:first|in full)\b/i,
  /\bno child agents\b|\bdo not (?:create|spawn) (?:sub-?agents|child agents)\b|\bno collaboration children\b/i,
  /^(?:final )?read-only (?:audit|code audit|review|investigation|verification)\b/i,
];

// A lane dispatch: a shouted subject line AND a sentence about the reader's own lane, worktree, brief, turn, seat or push. The head alone is
// a style and not a shape, so it is the conjunction that settles it.
const DISPATCH_HEAD = /^[A-Z][A-Z0-9][A-Z0-9 ,'()/—–-]{8,}[—:.-]/;
const DISPATCH_LANE = /\byour (?:lane|brief|worktree|working tree|branch|turn|seat|slice|gate|waiter)\b|\bthis lane\b|\bI (?:briefed|gave|told|asked|interrupted) you\b|\bCOO\b|\bdo NOT push\b|\bthe branch author\b/i;

// A prompt the runtime sends a session about itself: prose, second person, and they ask for work.
const HARNESS_NUDGE = [
  /^you have unread orchestrator bus messages/i,
  /^a (?:lane|detached command) you launched has finished/i,
  /^your orchestrator session has live work/i,
  /^a wake you scheduled for yourself is now due/i,
  /^the user just ended their realtime session/i,
  /^<turn_aborted>/i,
];

// Probes a session sent to test its own plumbing: a relay envelope, an acknowledgement token asked for by name, a tick loop, an editor's
// own context block and tool ids.
const PROBE = [
  /^relay\s+\S{8,}\s*<{2,}\s*MSG\b/i,
  /\breply with (?:exactly|the single (?:line|word))\b/i,
  /\bHARNESS-(?:STEER|ACK)\b/,
  /^you are (?:a relay|the target in an? [a-z-]+ test)\b/i,
  /\becho tick-\d+\b/i,
  /^run this exact command\b/i,
  /\[studio editor context data\b/i,
  /\bstudio_(?:inspect|edit|render|import_generated_media|record_start|record_stop|timeline_edit)\b/,
];

// A prompt a product hands a session so it can join itself up ("Follow the setup instructions at https://... to connect this Codex task to
// <product>"): a canned line is not direction however many times it is sent.
const CANNED_SETUP = /\bconnect this codex task\b|^\s*(?:&#x20;)?\s*follow the (?:account-wide )?setup (?:instructions|guide) at\b/i;

// A UI element selected on a page, handed to the agent as an HTML dump: peeled, so that what was typed after it stays.
const SELECTED_ELEMENT = /<launch-selected-element>[\s\S]*?<\/launch-selected-element>/g;

/** Peel applied to the raw turn, before the envelope peel. */
export function peelRaw(raw) {
  return raw.replace(SELECTED_ELEMENT, " ");
}

/**
 * The record's own prefix on a line, not a word the person typed: `Owner: <sentence>`, or an option letter `b: <sentence>` from a mined
 * multiple-choice answer. Only the owner's own names (config ownerNames) and a bare option letter a to e.
 */
export function labelPattern(ownerNames) {
  const names = [...ownerNames.map((n) => escapeRe(n.toLowerCase())), "[a-e]"];
  return new RegExp(`^(?:${names.join("|")})\\s*:\\s+`, "i");
}

/** The reason a peeled, normalized turn is fleet machinery, or null. */
export function fleetReason(text) {
  if (INJECTED.test(text)) return "harness";
  for (const pattern of RELAY_HEAD) if (pattern.test(text)) return "harness";
  for (const pattern of HARNESS_NUDGE) if (pattern.test(text)) return "harness-nudge";
  for (const pattern of PROBE) if (pattern.test(text)) return "probe";
  if (CANNED_SETUP.test(text)) return "canned-setup";
  if (PRODUCT_PROMPT.test(text)) return "product-prompt";
  if (AGENT_RELAY.test(text)) return "delivered-by-agent";
  if (TASK_BRIEF.test(text) && TASK_BRIEF_BODY.test(text)) return "lane-brief";
  for (const pattern of AGENT_BRIEF) if (pattern.test(text)) return "agent-brief";
  for (const pattern of LANE_BRIEF) if (pattern.test(text)) return "lane-brief";
  if (DISPATCH_HEAD.test(text) && DISPATCH_LANE.test(text)) return "lane-brief";
  if (AGENT_PROMPT.test(text)) return "agent-prompt";
  return null;
}
