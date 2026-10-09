// Hook input and output for the three hosts. One script pair serves them all; the host is read off the payload.
//   claude  stdin JSON {session_id, transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, hook_event_name, prompt}
//   codex   stdin JSON {session_id, turn_id, transcript_path|null, cwd, model, permission_mode, hook_event_name, prompt,
//                       agent_id/agent_type for sub-agents}
//   code    (Every Code) env CODE_HOOK_PAYLOAD JSON {event: "user.prompt_submit", session_id, turn_id, cwd, model, prompt, ...}; output is
//           plain stdout (injected raw as context)
// Output is JSON on stdout for claude and codex and NOTHING else is ever printed there. Every failure path prints {"continue":true}
// (fail open) after the failure has been logged loudly to the turn log and stderr.
import fs from "node:fs";

export const EVENTS = { "UserPromptSubmit": "prompt", "user.prompt_submit": "prompt" };

export async function readStdin(stream = process.stdin) {
  if (stream.isTTY) return "";
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const str = (v) => (typeof v === "string" && v ? v : null);

/** Parse a hook invocation. Throws (loudly) on anything that is not a recognisable hook payload. */
export function parseHookInput({ stdin = "", env = process.env }) {
  let o;
  let host;
  if (env.CODE_HOOK_PAYLOAD) {
    host = "code";
    o = JSON.parse(env.CODE_HOOK_PAYLOAD);
    o.hook_event_name = o.hook_event_name ?? o.event ?? env.CODE_HOOK_EVENT;
  } else {
    if (!stdin.trim()) throw new Error("hook got an empty stdin");
    o = JSON.parse(stdin);
    if ("turn_id" in o || "model" in o) host = "codex";
    else if ("prompt_id" in o || "scratchpad_dir" in o) host = "claude";
    else if (/[\\/]projects[\\/][^\\/]+[\\/][^\\/]+\.jsonl$/.test(String(o.transcript_path ?? ""))) host = "claude"; // <home>/projects/<slug>/<session>.jsonl
    else if (/[\\/]sessions[\\/]\d{4}[\\/]\d\d[\\/]\d\d[\\/]rollout-[^\\/]*\.jsonl$/.test(String(o.transcript_path ?? ""))) host = "codex"; // <home>/sessions/Y/M/D/rollout-*.jsonl
    else if (env.CLAUDE_PROJECT_DIR) host = "claude";
    else if (env.PLUGIN_ROOT) host = "codex";
    else throw new Error(`cannot tell which host sent this hook payload (keys: ${Object.keys(o).join(",")})`);
  }
  const event = EVENTS[o.hook_event_name];
  if (!event) throw new Error(`unsupported hook event ${JSON.stringify(o.hook_event_name)}`);
  const session_id = str(o.session_id);
  if (!session_id) throw new Error("hook payload has no session_id");
  return {
    host,
    event,
    session_id,
    turn_key: str(o.turn_id) ?? str(o.prompt_id),
    transcript_path: str(o.transcript_path),
    cwd: str(o.cwd),
    model: str(o.model),
    prompt: typeof o.prompt === "string" ? o.prompt : null,
    // Codex marks sub-agent turns with agent_id; a Claude sub-agent's transcript lives under .../subagents/ (its hooks carry no marker).
    agent_id: str(o.agent_id) ?? (/[\\/]subagents[\\/]/.test(String(o.transcript_path ?? "")) ? "claude-subagent-transcript" : null),
    agent_type: str(o.agent_type),
  };
}

/** What a hook invocation prints: {stdout, stderr, exitCode}. */
export function promptOutput(host, context) {
  if (host === "code") return { stdout: context ? `${context}\n` : "", stderr: "", exitCode: 0 };
  if (!context) return { stdout: `${JSON.stringify({ continue: true })}\n`, stderr: "", exitCode: 0 };
  const out = { ...(host === "codex" ? { continue: true } : {}), hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } };
  return { stdout: `${JSON.stringify(out)}\n`, stderr: "", exitCode: 0 };
}

/** Print and exit without waiting for stray handles; the write is synchronous so nothing is lost. */
export function finish({ stdout, stderr, exitCode }) {
  if (stdout) fs.writeSync(1, stdout);
  if (stderr) fs.writeSync(2, stderr);
  process.exit(exitCode);
}
