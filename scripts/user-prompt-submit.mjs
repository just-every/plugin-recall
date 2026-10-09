#!/usr/bin/env node
// UserPromptSubmit hook entry (Claude Code, Codex, Every Code). Fails open: any error prints {"continue":true} after logging it.
import { loadConfig } from "./lib/config.mjs";
import { isConfigError, logConfigFailure } from "./lib/config-error.mjs";
import { finish, parseHookInput, promptOutput, readStdin } from "./lib/hook-io.mjs";
import { handlePrompt } from "./lib/prompt-hook.mjs";
import { createRuntime } from "./lib/runtime.mjs";
import { createTurnLog } from "./lib/turn-log.mjs";

let host = process.env.CODE_HOOK_PAYLOAD ? "code" : "claude";
let config;
try {
  config = loadConfig();
  const stdin = process.env.CODE_HOOK_PAYLOAD ? "" : await readStdin(); // always drain the payload, even when disabled, so the host never writes into a closed pipe
  if (config.disabled) finish(promptOutput(host, null));
  const input = parseHookInput({ stdin });
  host = input.host;
  finish(await handlePrompt({ input, config, runtime: createRuntime(config) }));
} catch (e) {
  if (isConfigError(e)) { await logConfigFailure("prompt", e); finish(promptOutput(host, null)); }
  try { if (config) createTurnLog(config.dataDir).write({ event: "prompt", level: "error", outcome: "silent", reason: "hook-crashed", error: `${e.name}: ${e.message}` }); } catch { /* the stderr line below still reports it */ }
  process.stderr.write(`[recall ERROR] user-prompt-submit: ${e.stack ?? e}\n`);
  finish(promptOutput(host, null));
}
