// Who is driving this session? Automated workers (`claude -p`, the Claude Agent SDK, `codex exec`, Every Code
// exec, Codex's internal memory agents) run through the same homes as interactive sessions, and a hook payload does not say which is
// which. The hooks must be silent (no API call, nothing injected, never a block) for everything that is not a person at a keyboard, so this
// module demands POSITIVE evidence of an attended session and treats everything else, including "cannot tell", as silent (fail closed).
// Every verdict carries a reason; the hooks log it. Evidence per host (real lines in test/fixtures/headless, derivation in docs/hosts.md s.6):
//
//   claude   env CLAUDE_CODE_SESSION_ATTENDED, set by Claude Code itself for its hook processes: "1" for an interactive TUI or an IDE /
//            desktop host that is not itself a child session, "0" for `claude -p`, the Agent SDK and any session started from inside another
//            Claude session (CLAUDE_CODE_CHILD_SESSION is inherited, and so is CLAUDE_CODE_ENTRYPOINT, which is why the entrypoint env var alone
//            proves nothing). Cross-checked against the newest user record of the transcript: entrypoint sdk-*, or turnOrigin "sdk" without a
//            human origin, is a program's prompt even when the env says otherwise. Without the env var (an older Claude) the transcript must show
//            a human-origin prompt, which the first turn of a session cannot (the file does not exist yet): then the answer is "unknown".
//   codex    transcript_path (the rollout) line 1 session_meta: interactive = thread_source "user" and source "cli" | "vscode" and originator
//            not codex_exec. exec / sub-agent / security_scan / mcp rollouts are headless. A null transcript_path (`codex exec --ephemeral`,
//            Codex's internal memory-consolidation agent) leaves no evidence: unknown.
//   code     Every Code: same rollout rule (its session_meta has no thread_source). A null transcript_path: unknown.
//
// Known gaps: a rollout resumed in a different mode keeps its first session_meta; Every Code's `exec` source was read from its source
// (SessionSource::Exec), not captured from a real exec rollout.
import { lastClaudeUser, rolloutMeta } from "./session-signals.mjs";

const INTERACTIVE_SOURCES = new Set(["cli", "vscode"]);
const SDK_ENTRYPOINT = /^sdk-/;

const verdict = (interactive, reason, signals = {}) => ({ interactive, reason, signals });

/** Why a Claude transcript's newest user record is a program's prompt, or null. */
export function claudeProgrammaticReason(sig) {
  if (!sig) return null;
  if (sig.entrypoint && SDK_ENTRYPOINT.test(sig.entrypoint)) return `entrypoint-${sig.entrypoint}`;
  if (sig.turnOrigin === "sdk" && sig.originKind !== "human") return "turn-origin-sdk";
  return null;
}

function claudeVerdict(input, env, deps) {
  const signals = { attended: env.CLAUDE_CODE_SESSION_ATTENDED ?? null, entrypoint_env: env.CLAUDE_CODE_ENTRYPOINT ?? null, child_session: env.CLAUDE_CODE_CHILD_SESSION ?? null };
  const kind = env.CLAUDE_CODE_SESSION_KIND;
  if (kind === "bg" || kind === "daemon" || kind === "daemon-worker") return verdict(false, `headless:claude-session-kind-${kind}`, signals);
  const scheduled = env.CLAUDE_CODE_HOST_SCHEDULED_RUN;
  if (scheduled && scheduled !== "0") return verdict(false, "headless:claude-scheduled-run", signals);
  if (signals.attended === "0") return verdict(false, "headless:claude-unattended", signals);

  let last = null;
  if (input.transcript_path) {
    try { last = deps.lastClaudeUser(input.transcript_path); } catch (e) { return verdict(false, "unknown:claude-transcript-unreadable", { ...signals, error: e.message }); }
  }
  if (last) Object.assign(signals, { transcript_entrypoint: last.entrypoint, transcript_turn_origin: last.turnOrigin, transcript_origin_kind: last.originKind });
  const programmatic = claudeProgrammaticReason(last);
  if (programmatic) return verdict(false, `headless:claude-transcript-${programmatic}`, signals);

  if (signals.attended === "1") return verdict(true, "interactive:claude-attended", signals);
  if (signals.attended !== null) return verdict(false, "unknown:claude-attended-value", signals);
  if (last?.originKind === "human") return verdict(true, "interactive:claude-transcript-human", signals);
  return verdict(false, "unknown:claude-no-attendance-signal", signals);
}

async function rolloutVerdict(input, deps) {
  const host = input.host;
  if (!input.transcript_path) return verdict(false, `unknown:${host}-no-rollout`, { transcript_path: null });
  let meta;
  try { meta = await deps.rolloutMeta(input.transcript_path); } catch (e) { return verdict(false, `unknown:${host}-rollout-unreadable`, { error: e.message }); }
  if (!meta) return verdict(false, `unknown:${host}-no-session-meta`, {});
  const signals = { originator: meta.originator, source: typeof meta.source === "object" && meta.source ? `object:${Object.keys(meta.source).join(",")}` : meta.source, thread_source: meta.thread_source };
  if (meta.thread_source === "subagent" || (meta.source && typeof meta.source === "object")) return verdict(false, "headless:rollout-subagent", signals);
  if (meta.source === "exec" || /(^|_)exec$/.test(meta.originator ?? "")) return verdict(false, "headless:rollout-exec", signals);
  if (host === "codex" && meta.thread_source !== "user") return verdict(false, `headless:rollout-thread-source-${meta.thread_source ?? "none"}`, signals);
  if (meta.thread_source && meta.thread_source !== "user") return verdict(false, `headless:rollout-thread-source-${meta.thread_source}`, signals);
  if (INTERACTIVE_SOURCES.has(meta.source)) return verdict(true, `interactive:rollout-${meta.source}`, signals);
  return verdict(false, `unknown:rollout-source-${meta.source ?? "none"}`, signals);
}

/**
 * @param {{input: {host: string, transcript_path: string|null}, env?: object, deps?: object}} o
 * @returns {Promise<{interactive: boolean, reason: string, signals: object}>} interactive=false means: stay silent and log `reason`
 */
export async function classifySession({ input, env = process.env, deps = { lastClaudeUser, rolloutMeta } }) {
  if (input.host === "claude") return claudeVerdict(input, env, deps);
  if (input.host === "codex" || input.host === "code") return rolloutVerdict(input, deps);
  return verdict(false, `unknown:host-${input.host}`, {});
}
