// Every reason string a hook can write to the turn log, in plain language. The test (test/monitor-reasons.test.mjs) scans the hooks' source
// for the reasons they emit and fails if one is missing here, so a new reason cannot ship unlabelled. The Stop hook is gone (v2), but its
// lines stay in the log: the wording for the reasons only it wrote is kept so that those lines still read in the feed.
//
// kind:  what the line means for the feed
//   skip    the hook did nothing on purpose (no search, no audit); a turn made only of these is collapsed
//   empty   the prompt hook searched and nothing cleared the injection bar
//   audited the Stop hook audited candidates and none was confirmed
//   capped  the shared spend cap stopped the hook
//   error   something failed (the hook stayed silent and logged it loudly)
// group: the collapsed row's wording for a run of skips ("12 skipped turns · sub-agent notices").
// chip:  the feed chip for kinds that are not a skip (a skip's chip is "Skipped: " + label)
// label: finishes the sentence "Skipped: ...".

export const GROUPS = Object.freeze({
  subagent: "sub-agent notices",
  automated: "automated sessions",
  unclassified: "sessions Recall cannot classify",
  "not-owner": "messages that are not your own words",
  internal: "Recall's own workers",
  off: "Recall switched off",
  short: "short replies",
  followup: "follow-ups to a block",
  other: "other",
});

const skip = (group, label, detail) => ({ kind: "skip", group, label, detail });

const NOT_OWNER = {
  "agent-completion": skip("subagent", "a sub-agent reported back", "The message was a sub-agent's completion notice, not something you typed, so nothing was searched."),
  harness: skip("not-owner", "a harness message", "The message came from the host application, not from you."),
  envelope: skip("not-owner", "an empty harness envelope", "The message held only a harness envelope and no words of yours."),
  "replayed-goal": skip("not-owner", "a replayed goal", "The message replayed an earlier goal statement."),
  "harness-nudge": skip("not-owner", "a harness reminder", "The message was an automatic reminder from the harness."),
  probe: skip("not-owner", "a test probe", "The message looked like a one-word probe or test."),
  "canned-setup": skip("not-owner", "a canned setup prompt", "The message was a standard setup prompt."),
  "product-prompt": skip("not-owner", "a product's built-in prompt", "The message was a prompt built into a product, not yours."),
  "delivered-by-agent": skip("not-owner", "a message relayed by another agent", "Another agent delivered this message."),
  "lane-brief": skip("not-owner", "a task brief written for an agent", "The message was a task brief written for an agent."),
  "review-harness": skip("not-owner", "a review harness prompt", "The message was an automated review prompt."),
  "agent-brief": skip("not-owner", "an agent brief", "The message was a brief written for an agent."),
  "agent-prompt": skip("not-owner", "an agent's prompt", "The message was a prompt written for an agent."),
  "key-material": skip("not-owner", "it held key material", "The message contained secrets, so Recall left it alone."),
  "third-party": skip("not-owner", "it mentioned another person's details", "The message held another person's email address or a long number."),
  "too-short": skip("not-owner", "the message was too short to search", "The message was shorter than the minimum length."),
  empty: skip("not-owner", "the message was empty", "The message had no text."),
  "skill-invocation": skip("not-owner", "a bare skill invocation", "The message was a skill button, not a sentence."),
  "drop-pattern": skip("not-owner", "it matched one of your dropPatterns", "The message matched a regular expression in the dropPatterns setting."),
};

const AUTOMATION = { heartbeat: "a thread heartbeat", "scheduled-task": "a scheduled task", codex_delegation: "a delegation from another thread" };

// Exact reasons, then prefix families, first match wins.
const EXACT = {
  disabled: skip("off", "Recall is switched off", "The kill switch (RECALL_DISABLED) is on."),
  child: skip("internal", "this is one of Recall's own worker processes", "Recall's own worker session; hooks never run on those."),
  subagent: skip("subagent", "a sub-agent's own turn", "The hook fired inside a sub-agent, which never searches."),
  "no-prompt": skip("not-owner", "the hook payload had no prompt text", "The host sent no prompt text."),
  "short-or-missing-message": skip("short", "the final reply was too short to audit", "The agent's final message was shorter than the minimum, so there was nothing to audit."),
  "no-eligible-prompt-state": skip("not-owner", "this turn did not start with something you typed", "The prompt hook did not judge this turn to be yours, so the Stop audit stayed out."),
  "already-blocked-this-turn": skip("followup", "Recall already sent this turn back once", "Recall blocks at most once per turn."),
  "stop-hook-active": skip("followup", "this Stop follows Recall's own block", "The host marks the Stop that follows a block; Recall never blocks twice."),
  "nothing-above-threshold": { kind: "empty", group: "other", label: "nothing above the injection bar", detail: "Recall searched, but no earlier statement cleared the injection bar (and the apply gate, when it is on)." },
  "no-violation-above-threshold": { kind: "audited", group: "other", label: "no audited statement reached the block threshold", detail: "Recall audited the candidates and none scored high enough to block." },
  "nominated-hits-not-confirmed": { kind: "audited", group: "other", label: "nominated, but the worker did not confirm", detail: "A candidate reached the threshold but the confirming worker did not agree, so nothing was sent back." },
  "cap-reached": { chip: "Spend cap reached", kind: "capped", group: "other", label: "the spend cap is reached", detail: "The shared daily or total spend cap is reached; Recall stays silent until it resets or is raised." },
  "empty-index": { chip: "Index empty", kind: "error", group: "other", label: "the index is empty", detail: "There is nothing to search yet. Run: recall index." },
  "no-cards": { chip: "No cards", kind: "error", group: "other", label: "there are no statement cards yet", detail: "v2 injects only statements that have a card (kind, scope, gist). Run: recall enrich. The background pass writes them after the next index." },
  "retrieval-failed": { chip: "Search failed", kind: "error", group: "other", label: "the search failed", detail: "Retrieval threw; the turn carried on without Recall. See the error in the raw line." },
  "apply-gate-failed": { chip: "Gate failed", kind: "error", group: "other", label: "the apply gate failed", detail: "The apply gate (the second question asked of each statement that passed the injection bar) could not answer in time or failed, so nothing was injected rather than the unchecked statements. See the error in the raw line." },
  "audit-failed": { chip: "Audit failed", kind: "error", group: "other", label: "the Stop audit failed", detail: "The audit threw; the turn carried on without Recall. See the error in the raw line." },
  "verify-unavailable": { chip: "Verifier unavailable", kind: "error", group: "other", label: "the confirming worker was unavailable", detail: "A candidate was nominated but no worker could confirm it, so nothing was sent back." },
  "config-invalid": { chip: "Config invalid", kind: "error", group: "other", label: "the configuration is invalid", detail: "config.json or an environment value is invalid; the hooks stay silent until it is fixed." },
  "hook-crashed": { chip: "Hook crashed", kind: "error", group: "other", label: "the hook crashed", detail: "The hook script threw before it could do its work; the turn carried on without Recall." },
};

const RULES = [
  [/^not-owner-text:automation-(.+)$/, (m) => skip("not-owner", `${AUTOMATION[m[1]] ?? `an automation message (${m[1]})`}, not your words`, "An automation message, not something you typed.")],
  [/^not-owner-text:(.+)$/, (m) => NOT_OWNER[m[1]] ?? skip("not-owner", `not your own words (${m[1]})`, "The owner-text filter rejected the message.")],
  [/^headless:claude-session-kind-(.+)$/, (m) => skip("automated", `a background Claude session (${m[1]})`, "A background or daemon Claude session, not a person at the keyboard.")],
  [/^headless:claude-scheduled-run$/, () => skip("automated", "a scheduled Claude run", "A scheduled run, not a person at the keyboard.")],
  [/^headless:claude-unattended$/, () => skip("automated", "an unattended Claude session (claude -p or the SDK)", "Claude Code reports this session as unattended.")],
  [/^headless:claude-transcript-entrypoint-(.+)$/, (m) => skip("automated", `a program's prompt (entrypoint ${m[1]})`, "The transcript shows the prompt came from the SDK, not from a person.")],
  [/^headless:claude-transcript-turn-origin-sdk$/, () => skip("automated", "a program's prompt (SDK turn)", "The transcript marks this turn as sent by the SDK.")],
  [/^headless:rollout-subagent$/, () => skip("subagent", "a sub-agent session", "The rollout is a sub-agent's.")],
  [/^headless:rollout-exec$/, () => skip("automated", "a codex exec run", "A non-interactive exec session.")],
  [/^headless:rollout-thread-source-(.+)$/, (m) => skip("automated", `a non-user thread (${m[1]})`, "The rollout was not started by a person.")],
  [/^headless:(.+)$/, (m) => skip("automated", `an automated session (${m[1]})`, "Positive evidence that no person is typing.")],
  [/^unknown:(.+)$/, (m) => skip("unclassified", `Recall cannot tell whether a person is typing (${m[1]})`, "No evidence either way, so Recall stays silent (fail closed).")],
];

/** @returns {{known: boolean, kind: string, group: string, label: string, detail: string}} */
export function reasonInfo(reason) {
  if (typeof reason !== "string" || !reason) return { known: false, kind: "skip", group: "other", label: "no reason recorded", detail: "The log line has no reason." };
  if (Object.hasOwn(EXACT, reason)) return { known: true, ...EXACT[reason] };
  for (const [re, make] of RULES) {
    const m = re.exec(reason);
    if (m) return { known: true, ...make(m) };
  }
  return { known: false, kind: "skip", group: "other", label: reason, detail: `A reason this monitor has no wording for: ${reason}.` };
}
