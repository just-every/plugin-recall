// Run a claude or codex CLI worker under a home the router chose. Every generative step uses your own `claude` / `codex` CLI (on whatever
// login it has) instead of an API this plugin would bill. Rules enforced here, for every call:
//   - the home comes from the router (router.mjs): by default the current host's own home; a pinned, roster or usage-chosen home is passed
//     explicitly as CLAUDE_CONFIG_DIR / CODEX_HOME; no usable home throws WorkerSkipped;
//   - no recursion: RECALL_CHILD=1 in the env, `--settings {"disableAllHooks":true}` (claude), `--disable hooks` (codex);
//   - credential files are never opened or copied; the CLI reads its own login from the home it runs under.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class WorkerSkipped extends Error {
  constructor(message, considered) {
    super(message);
    this.name = "WorkerSkipped";
    this.considered = considered ?? [];
  }
}

/** Env vars that make a nested Claude think it is the parent session, plus the home variables (set again below). */
const STRIP = [/^CLAUDECODE$/, /^CLAUDE_CODE_/, /^NODE_OPTIONS$/, /^CLAUDE_CONFIG_DIR$/, /^CODEX_HOME$/];
/** Credentials of THIS process, which must not follow a worker onto a home the router chose explicitly (a different account). */
const STRIP_CREDENTIALS = [/^ANTHROPIC_API_KEY$/, /^ANTHROPIC_AUTH_TOKEN$/, /^OPENAI_API_KEY$/, /^CODEX_API_KEY$/, /^CODEX_ACCESS_TOKEN$/];

/**
 * @param {object} base the environment to start from
 * @param {"claude"|"codex"} kind
 * @param {string} home the home the router chose
 * @param {object} [extra] extra variables for the worker (never the home variables)
 * @param {{explicit?: boolean}} [o] explicit: the home was chosen (pinned, roster, usage) and is set as the home variable and this process's credentials are
 *   removed; not explicit: it is the host's own home, so the host's home variable is passed on as it is and the credentials stay.
 */
export function workerEnv(base, kind, home, extra = {}, { explicit = true } = {}) {
  const homeVar = kind === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!STRIP.some((re) => re.test(k)) && !(explicit && STRIP_CREDENTIALS.some((re) => re.test(k)))) env[k] = v;
  Object.assign(env, extra);
  env.RECALL_CHILD = "1";
  if (explicit) env[homeVar] = home;
  else if (base[homeVar]) env[homeVar] = base[homeVar];
  return env;
}

export function claudeArgs({ model, schema }) {
  return [
    "-p", "--output-format", "json", "--model", model,
    "--settings", '{"disableAllHooks":true}', "--setting-sources", "user", "--strict-mcp-config",
    "--tools", "", "--permission-mode", "dontAsk", "--no-session-persistence", "--disable-slash-commands",
    ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
  ];
}

export function codexArgs({ cwd, schemaPath, outPath, model, effort }) {
  return [
    "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--disable", "hooks",
    "-c", 'approval_policy="never"', "-c", `model_reasoning_effort=${JSON.stringify(effort)}`,
    ...(schemaPath ? ["--output-schema", schemaPath] : []),
    "--output-last-message", outPath, "--cd", cwd,
    ...(model ? ["-m", model] : []),
    "-",
  ];
}

function run(bin, args, { env, cwd, input, timeoutMs, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => {
      finish(new Error(`${bin} worker timed out after ${timeoutMs}ms`));
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutMs);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (e) => finish(new Error(`${bin} failed to spawn: ${e.message}`)));
    child.on("close", (code, signal) => {
      if (code !== 0) return finish(new Error(`${bin} worker exited ${code ?? signal}: ${(stderr.trim() || stdout.trim()).slice(0, 500)}`));
      finish(null, { stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/**
 * @param {{router: object, config: object, kind: "claude"|"codex", prompt: string, schema?: object, model?: string, effort?: string,
 *          env?: object, timeoutMs?: number, cwd?: string, spawnImpl?: Function, log?: (e: object) => void}} o
 *   env  extra variables for the worker process (never the home variables, which the router decides)
 * @returns {Promise<{text: string, json: object|null, home: string, kind: string, durationMs: number}>}
 */
export async function runCliWorker({ router, config, kind, prompt, schema, model, effort = "low", env: extraEnv = {}, timeoutMs = config.workerTimeoutMs, cwd, spawnImpl, log = () => {} }) {
  const pick = await router.pick(kind);
  if (!pick.home) {
    log({ level: "error", event: "worker-skipped", kind, reason: pick.reason, considered: pick.considered });
    throw new WorkerSkipped(`no ${kind} worker run: ${pick.reason}`, pick.considered);
  }
  const t0 = performance.now();
  const workdir = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "recall-worker-"));
  try {
    const env = workerEnv(process.env, kind, pick.home, extraEnv, { explicit: pick.explicit !== false });
    let text;
    if (kind === "claude") {
      const { stdout } = await run("claude", claudeArgs({ model: model ?? "sonnet", schema }), { env, cwd: workdir, input: prompt, timeoutMs, spawnImpl });
      const parsed = JSON.parse(stdout);
      if (parsed.is_error) throw new Error(`claude worker reported an error: ${String(parsed.result ?? "").slice(0, 300)}`);
      text = schema && parsed.structured_output !== undefined ? JSON.stringify(parsed.structured_output) : String(parsed.result ?? "");
    } else {
      const outPath = path.join(workdir, "last-message.txt");
      let schemaPath = null;
      if (schema) { schemaPath = path.join(workdir, "schema.json"); fs.writeFileSync(schemaPath, JSON.stringify(schema)); }
      await run("codex", codexArgs({ cwd: workdir, schemaPath, outPath, model, effort }), { env, cwd: workdir, input: prompt, timeoutMs, spawnImpl });
      text = fs.readFileSync(outPath, "utf8");
    }
    let json = null;
    if (schema) {
      try { json = JSON.parse(text); } catch { throw new Error(`${kind} worker did not return JSON for a structured request: ${text.slice(0, 200)}`); }
    }
    log({ level: "info", event: "worker-ok", kind, home: pick.home, durationMs: performance.now() - t0 });
    return { text, json, home: pick.home, kind, durationMs: performance.now() - t0 };
  } finally {
    if (!cwd) fs.rmSync(workdir, { recursive: true, force: true });
  }
}
