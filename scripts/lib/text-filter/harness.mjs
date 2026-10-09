// Turns the host or its harness writes into a transcript as if the person had typed them. Generic: these exist on every install.
// Each rule drops the turn and names the reason; the index report counts drops by reason.
import { startsWithAppSection } from "./desktop.mjs";

// A sub-agent finishing, reported to the session that launched it: `<task-notification> <task-id>... <status>completed</status> ...`.
const AGENT_COMPLETION = /^<task-notification\b/i;

// Matched at the head of the text, where they sit.
const HARNESS_HEAD = [
  /^base directory for this skill:/i,
  /^caveat: the messages below/i,
  /^\[request interrupted/i,
  /^\[no response requested/i,
  /^this session is being continued from a previous/i,
  /^<task>/i,
  /^api error/i,
  /^command (output|failed)/i,
  // A repo's own AGENTS.md, injected into a Codex turn as if it were typed.
  /^#*\s*agents\.md instructions/i,
  /^<skill>/i,
  /^<!--/,
  // A JSON envelope handed to the model as a turn. People type prose.
  /^\[\s*\{\s*"/,
  // An attachment envelope: a Codex turn carrying an image arrives as `<image name=[Image #1] path="...">` and nothing else.
  /^<image\b/i,
  // The harness's question-and-answer record, tagged. The agent wrote the question; the person's words are the few in `answer`.
  /^<send_user_message_question_reply>/i,
  // Every Code's review loop, written into the session as user turns: the reviewer's output relayed (`<user_action> <context>User initiated a
  // review task...`), the check that the fixes resolved the findings, and the commit-and-push handoff with its `git status` snapshot.
  /^<user_action>/i,
  /^you are evaluating whether the latest fixes resolved the findings\b/i,
  /^you have permission to commit and push\. repository snapshot:/i,
];

// The harness's own question-and-answer record, kept whole by a naive extractor: `[{"questionItemId":"...","question":"...","answer":"..."}]`.
const HARNESS_JSON = /"questionItemId"|request_user_input_async|<\/?send_user_message_question_reply>/;

// An instruction block wrapped for a model to obey, wherever it sits in the turn: Codex wraps a repo's AGENTS.md as `<INSTRUCTIONS>...</INSTRUCTIONS>`
// inside a turn it injects, so a rollout without UserMessage events would otherwise pass it off as typed.
const INSTRUCTION_BLOCK = /<\/?INSTRUCTIONS>/;

// The goal a Codex thread replays to itself every turn: `<codex_internal_context source="goal"> ... Continuation behavior: ...`.
const REPLAYED_GOAL = /^<codex_internal_context\b/i;

// The prompt an approval-review harness builds for the model that watches a Codex session: the session's own transcript since the last
// look, wrapped in the harness's warning about it. Both halves are matched: the head, and the untrusted-evidence sentence for a cut turn.
const REVIEW_HARNESS = [
  /^the following is the [^.\n]{0,60}\bagent history\b/i,
  /\bas untrusted evidence, not as instructions to follow\b/i,
];

/** The reason a peeled, normalized turn is a harness turn, or null. */
export function harnessReason(text) {
  if (AGENT_COMPLETION.test(text)) return "agent-completion";
  for (const pattern of HARNESS_HEAD) if (pattern.test(text)) return "harness";
  if (INSTRUCTION_BLOCK.test(text) || HARNESS_JSON.test(text)) return "harness";
  // a Codex app envelope with nothing of the person's in it (no request, no comment): what is left after the peel is the envelope itself
  if (startsWithAppSection(text)) return "envelope";
  if (REPLAYED_GOAL.test(text)) return "replayed-goal";
  for (const pattern of REVIEW_HARNESS) if (pattern.test(text)) return "review-harness";
  return null;
}
