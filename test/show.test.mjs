// `recall show`: the conversation around a recalled statement, read from the synthetic transcript windows in fixtures/show (see
// fixtures/README.md) and the synthetic lines in fixtures/claude-lines.json, tail-lines.json and fixtures/code. No network. The CLI runs as a child process with HOME and
// RECALL_DATA pointed at temp dirs, exactly as an agent runs it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../scripts/lib/config.mjs";
import { showStatement } from "../scripts/lib/show.mjs";
import { toolMarker } from "../scripts/lib/show-format.mjs";
import { FIXTURES, readFixture, tmpDir } from "./helpers.mjs";

const RECALL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "recall.mjs");
const fixtureLines = (name) => fs.readFileSync(path.join(FIXTURES, "show", name), "utf8").trimEnd().split("\n");

// The three synthetic windows, with the statement's line (1-based, in the fixture) and the text the indexer filed it under.
const CLAUDE = { file: "claude-window.jsonl", line: 15, host: "claude", text: "Looks good, go ahead and apply the same style to the pricing and docs sections.", ts: "2026-10-07T09:11:03.001Z", session: "5e1f0a3b-7c2d-4b9e-8a46-3d9c0b1e7f20", repo: "web-app" };
const CODEX = { file: "codex-window.jsonl", line: 34, host: "codex", text: 'The preview build fails with "connection refused" when I open the report page.', ts: "2026-10-07T14:06:07.600Z", session: "0190c1d2-3e4f-7a5b-8c6d-7e8f9a0b1c2d", repo: "ledger-cli" };
const CODEX_ZST = { file: "codex-zst-window.jsonl", line: 22, host: "codex", text: "Thanks. Now run the same check for the remaining currencies and tell me whether the totals still add up.", ts: "2026-09-14T22:53:03.600Z", session: "0190d2e3-4f50-7b6c-9d7e-8f9a0b1c2d3e", repo: "billing-api" };

/**
 * A fake home with the transcript where its host keeps it, and a data dir whose index holds the statement.
 * @returns {{home, dataDir, id, file, src}}
 */
function world(spec, { lines = fixtureLines(spec.file), zst = false, dir = null, id = `${spec.host}-0123456789abcdef`, text = spec.text, line = spec.line } = {}) {
  const home = tmpDir("recall-show-home");
  const where = dir ?? (spec.host === "claude" ? ".claude/projects/-home-sam-projects-web-app" : ".codex/sessions/2026/10/07");
  const name = spec.host === "claude" ? `${spec.session}.jsonl` : `rollout-2026-10-07T14-05-54-${spec.session}.jsonl${zst ? ".zst" : ""}`;
  const file = path.join(home, where, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${lines.join("\n")}\n`;
  fs.writeFileSync(file, zst ? zlib.zstdCompressSync(Buffer.from(body)) : body);
  const dataDir = tmpDir("recall-show-data");
  const src = `${file}:L${line}`;
  fs.writeFileSync(path.join(dataDir, "statements.jsonl"), `${JSON.stringify({ id, text, ts: spec.ts, session_id: spec.session, repo: spec.repo, host: spec.host, hash: "h", src })}\n`);
  return { home, dataDir, id, file, src };
}

function run(w, args = [], env = {}) {
  const e = { ...process.env, HOME: w.home, RECALL_DATA: w.dataDir, ...env };
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID"]) if (!(k in env)) delete e[k];
  const r = spawnSync(process.execPath, [RECALL, "show", ...args], { env: e, encoding: "utf8", cwd: w.home });
  return { out: r.stdout, err: r.stderr, code: r.status };
}
const logEvents = (dataDir) => {
  const dir = path.join(dataDir, "logs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("turns-")).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map(JSON.parse)) : [];
};
/** The turn heading lines of the output: [marker, label, line number]. */
const headings = (out) => [...out.matchAll(/^(>> |   )(USER|ASSISTANT)(?: \(recalled statement\))?  \d\d:\d\d:\d\d  L(\d+)$/gm)].map((m) => [m[1].trim(), m[2], Number(m[3])]);

test("Claude: header (time, host, home, repo, session, src path:line), turns in order with the recalled statement marked, tool markers between turns", () => {
  const w = world(CLAUDE);
  const r = run(w, [w.id]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split("\n");
  assert.equal(lines[0], `recall show ${w.id}`);
  assert.equal(lines[1], "2026-10-07 09:11:03 UTC | host claude | home ~/.claude | repo web-app | session 5e1f0a3b-7c2d-4b9e-8a46-3d9c0b1e7f20");
  assert.equal(lines[2], `source: ~/.claude/projects/-home-sam-projects-web-app/5e1f0a3b-7c2d-4b9e-8a46-3d9c0b1e7f20.jsonl:L15`);
  assert.deepEqual(headings(r.out), [["", "ASSISTANT", 1], [">>", "USER", 15], ["", "ASSISTANT", 20], ["", "ASSISTANT", 30]], "the earlier reply, the statement, the two replies after it");
  assert.match(r.out, /^>> USER \(recalled statement\)  09:11:03  L15\n   Looks good, go ahead and apply the same style to the pricing and docs sections\.\n/m, "the statement is marked and shows its text");
  assert.match(r.out, /L20\n[^\n]*Applying it now\.[\s\S]*?\n\n   \[ran 1 tool: Workflow\]\n\n   ASSISTANT  09:11:09  L30/, "the Workflow call between the two replies is a one-line marker");
  assert.doesNotMatch(r.out, /thinking|signature/i, "reasoning blocks are not conversation");
});

test("Claude: --before and --after bound the excerpt; --json is the same data", () => {
  const w = world(CLAUDE);
  assert.deepEqual(headings(run(w, [w.id, "--before", "0", "--after", "0"]).out), [[">>", "USER", 15]]);
  assert.deepEqual(headings(run(w, [w.id, "--before", "1", "--after", "1"]).out), [["", "ASSISTANT", 1], [">>", "USER", 15], ["", "ASSISTANT", 20]]);
  const j = JSON.parse(run(w, [w.id, "--json", "--after", "2"]).out);
  assert.equal(j.id, w.id);
  assert.deepEqual([j.host, j.home, j.repo, j.session_id, j.line, j.file], ["claude", "~/.claude", "web-app", CLAUDE.session, 15, w.file]);
  assert.deepEqual(j.items.map((it) => (it.type === "tools" ? `tools:${it.names.join(",")}` : `${it.role}${it.recalled ? "*" : ""}:${it.line}`)), ["assistant:1", "owner*:15", "assistant:20", "tools:Workflow", "assistant:30"]);
  assert.equal(j.items[1].text, CLAUDE.text);
  assert.equal(JSON.parse(run(w, [w.id, "--json", "--before", "0", "--after", "0"]).out).items.length, 1);
});

test("Claude: only the owner's typed turns and the assistant's text: sidechains, tool results, meta, task notifications and claude -p prompts are not in the excerpt", () => {
  const spliced = fixtureLines(CLAUDE.file);
  const harness = JSON.parse(readFixture("claude-lines.json"));
  // harness lines (fixtures/claude-lines.json), spliced between the statement and the replies that follow it
  spliced.splice(15, 0, harness.sidechain, harness.meta, harness.task_notification, harness.sdk_cli, harness.tool_result);
  const w = world(CLAUDE, { lines: spliced });
  const r = run(w, [w.id]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(headings(r.out).map((h) => h[1]), ["ASSISTANT", "USER", "ASSISTANT", "ASSISTANT"]);
  for (const leaked of ["You are a worker agent", "release-notes", "task-notification", "Reply with exactly", "No such file or directory"]) assert.ok(!r.out.includes(leaked), `${leaked} is not conversation`);
});

test("Codex .jsonl: the event copy of each turn only (no twin), exec calls counted as one marker, a function_call named by its tool", () => {
  const w = world(CODEX);
  const r = run(w, [w.id, "--before", "2", "--after", "5"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.split("\n")[1], /^2026-10-07 14:06:07 UTC \| host codex \| home ~\/\.codex \| repo ledger-cli \| session 0190c1d2/);
  assert.deepEqual(headings(r.out), [["", "ASSISTANT", 25], [">>", "USER", 34], ["", "ASSISTANT", 35]], "one line per turn: the response_item copies (lines 26, 33, 36) are the events' twins");
  assert.match(r.out, /\n   \[ran 3 tools: exec x2, spawn_agent\]\n$/, "calls after the last turn are shown when the file ends before --after turns; function_call and custom_tool_call are named by their tool");
  assert.match(r.out, /L34\n   The preview build fails with "connection refused" when I open the report page\.\n/);
  assert.doesNotMatch(r.out, /exec x4/, "the calls before the first turn shown are left out");
});

test("Codex .jsonl.zst: read through the decompressor, same excerpt as plain", () => {
  const w = world(CODEX_ZST, { zst: true });
  assert.ok(w.file.endsWith(".jsonl.zst"));
  const r = run(w, [w.id, "--before", "2", "--after", "2"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.split("\n")[2], /rollout-2026-10-07T14-05-54-0190d2e3-4f50-7b6c-9d7e-8f9a0b1c2d3e\.jsonl\.zst:L22$/);
  assert.deepEqual(headings(r.out), [["", "ASSISTANT", 1], ["", "ASSISTANT", 14], [">>", "USER", 22], ["", "ASSISTANT", 24], ["", "ASSISTANT", 51]]);
  assert.match(r.out, /\[ran 2 tools: exec x2\]\n\n   ASSISTANT  22:53:00  L14/);
  assert.match(r.out, /\[ran 6 tools: exec x6\]\n\n   ASSISTANT  23:18:21  L51/);
  const plain = world(CODEX_ZST, { zst: false });
  assert.equal(JSON.parse(run(plain, [plain.id, "--json"]).out).items.map((i) => i.text).join("|"), JSON.parse(run(w, [w.id, "--json"]).out).items.map((i) => i.text).join("|"), ".zst and plain give the same turns");
});

test("Every Code rollout without conversation events: the response_item messages are the turns, the harness's status message is not one", () => {
  const code = fs.readFileSync(path.join(FIXTURES, "code/sessions/2026/05/29/rollout-2026-05-29T13-57-42-0190b000-bbbb-7000-8000-00000000e001.jsonl"), "utf8").trimEnd().split("\n");
  const spec = { host: "code", session: "0190b000-bbbb-7000-8000-00000000e001", ts: "2026-05-29T13:58:00.000Z", repo: "x", text: "what's new?" };
  const w = world(spec, { lines: code, line: 9, dir: ".code/sessions/2026/05/29" });
  const r = run(w, [w.id]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(headings(r.out), [["", "USER", 2], ["", "ASSISTANT", 7], [">>", "USER", 9], ["", "ASSISTANT", 13]]);
  assert.ok(!r.out.includes("System Status"));
});

test("each turn is its prose only (fenced code, tool output and file dumps out), clipped to about 600 characters", () => {
  const long = `${"The plan is to keep the module small and move each concern behind one clear function. ".repeat(12)}`;
  const text = `Here is the result.\n\n\`\`\`bash\n$ pnpm test\nFAIL tests/a.test.mjs\n\`\`\`\n\n<tool_result>\nsecret dump line\n</tool_result>\n\n${long}`;
  // records shaped like the hosts' (fixtures/tail-lines.json) with only the text and time replaced
  const TAIL = JSON.parse(readFixture("tail-lines.json"));
  const lines = [
    JSON.stringify({ ...JSON.parse(TAIL.assistant_text), timestamp: "2026-09-01T10:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text }] } }),
    JSON.stringify({ ...JSON.parse(TAIL.user_typed), timestamp: "2026-09-01T10:01:00.000Z", message: { role: "user", content: "Please do that, and keep it small." } }),
  ];
  const w = world({ host: "claude", session: "11111111-2222-3333-4444-555555555555", ts: "2026-09-01T10:01:00.000Z", repo: "r", text: "Please do that, and keep it small." }, { lines, line: 2 });
  const r = run(w, [w.id]);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(run(w, [w.id, "--json"]).out);
  const reply = j.items[0].text;
  assert.ok(reply.startsWith("Here is the result.") && reply.endsWith(" [...]"), reply.slice(-20));
  assert.ok(!reply.includes("pnpm test") && !reply.includes("secret dump"), "code and tool output are removed");
  assert.ok(reply.length <= 600 + " [...]".length && reply.length > 500, `${reply.length} characters`);
});

test("tool markers: counts per name, in the order first used; a long list is cut", () => {
  assert.equal(toolMarker(["Bash"]), "[ran 1 tool: Bash]");
  assert.equal(toolMarker(["Bash", "Read", "Edit"]), "[ran 3 tools: Bash, Read, Edit]");
  assert.equal(toolMarker(["Bash", "Read", "Bash", "Bash"]), "[ran 4 tools: Bash x3, Read]");
  assert.equal(toolMarker(Array.from({ length: 10 }, (_, i) => `t${i}`)), "[ran 10 tools: t0, t1, t2, t3, t4, t5, t6, t7, +2 more]");
});

test("an unknown id, a missing transcript, a moved line and bad counts are clear errors with a non-zero exit, and log nothing", () => {
  const w = world(CLAUDE);
  const unknown = run(w, ["claude-ffffffffffffffff"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /recall show: no statement with id "claude-ffffffffffffffff" in .*statements\.jsonl/);
  assert.equal(unknown.out, "");
  const none = run(w, []);
  assert.equal(none.code, 1);
  assert.match(none.err, /usage: recall show <statement-id>/);

  fs.rmSync(w.file);
  const gone = run(w, [w.id]);
  assert.equal(gone.code, 1);
  assert.match(gone.err, new RegExp(`the transcript of statement ${w.id} is gone: .*${CLAUDE.session}\\.jsonl`));

  const moved = world(CLAUDE, { line: 16 }); // line 16 is an attachment, not the owner's message
  const m = run(moved, [moved.id]);
  assert.equal(m.code, 1);
  assert.match(m.err, /line 16 of .* is not the recalled statement/);
  const past = world(CLAUDE, { line: 99 });
  assert.match(run(past, [past.id]).err, /line 99 of .* is not the recalled statement/);

  const bad = run(world(CLAUDE), ["claude-0123456789abcdef", "--before", "-1"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /needs a value|--before must be an integer from 0 to 50/);
  assert.equal(logEvents(w.dataDir).length + logEvents(moved.dataDir).length + logEvents(past.dataDir).length, 0, "a lookup that failed is not logged");
});

test("a statement with no usable src (a corpus row, a test row) says so", () => {
  const w = world(CLAUDE);
  fs.writeFileSync(path.join(w.dataDir, "statements.jsonl"), `${JSON.stringify({ id: "x-1", text: "t", ts: CLAUDE.ts, session_id: "s", repo: null, host: "claude", hash: "h", src: "test" })}\n`);
  const r = run(w, ["x-1"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /statement x-1 has no transcript source \(src is "test"\)/);
});

test("each run appends one 'show' line to the turn log: the statement id, the caller's cwd and project, and the session the environment names (else null)", () => {
  const w = world(CLAUDE);
  assert.equal(run(w, [w.id], { CLAUDE_CODE_SESSION_ID: "caller-session-1" }).code, 0);
  assert.equal(run(w, [w.id, "--after", "1"]).code, 0);
  assert.equal(run(w, [w.id], { CODEX_THREAD_ID: "codex-thread-9" }).code, 0);
  const lines = logEvents(w.dataDir);
  assert.equal(lines.length, 3);
  const [a, b, c] = lines;
  assert.equal(a.event, "show");
  assert.equal(a.level, "info");
  assert.equal(a.statement_id, w.id);
  assert.equal(a.cwd, fs.realpathSync(w.home), "the caller's working directory");
  assert.equal(a.project, path.basename(fs.realpathSync(w.home)));
  assert.equal(a.session_id, "caller-session-1");
  assert.deepEqual([a.before, a.after], [4, 3]);
  assert.equal(b.session_id, null, "no session in the environment");
  assert.equal(b.after, 1);
  assert.equal(c.session_id, "codex-thread-9");
  assert.ok(/^\d{4}-\d\d-\d\dT/.test(a.ts));
});

test("reads only: the transcript and the index are untouched, and nothing but the log directory is written to the data dir", () => {
  const w = world(CODEX_ZST, { zst: true });
  const stamp = (d) => fs.readdirSync(d, { recursive: true }).sort().map((f) => [f, fs.statSync(path.join(d, f)).isFile() ? fs.statSync(path.join(d, f)).size : 0].join(":")).join("|");
  const before = { data: fs.readdirSync(w.dataDir, { recursive: true }).sort(), file: stamp(path.dirname(w.file)) };
  assert.equal(run(w, [w.id]).code, 0);
  assert.deepEqual(fs.readdirSync(w.dataDir, { recursive: true }).sort().filter((f) => !before.data.includes(f)), ["logs", `logs/${fs.readdirSync(path.join(w.dataDir, "logs"))[0]}`]);
  assert.equal(stamp(path.dirname(w.file)), before.file);
});

test("showStatement is the same thing in-process (homedir for the ~ and the home, now for the log time)", async () => {
  const w = world(CLAUDE);
  const config = loadConfig({ RECALL_DATA: w.dataDir });
  const { view, text } = await showStatement({ id: w.id, config, env: {}, cwd: "/work/proj/", homedir: w.home, now: () => new Date("2026-10-08T09:00:00.000Z") });
  assert.equal(view.home, "~/.claude");
  assert.ok(text.includes("source: ~/.claude/projects/"));
  const [line] = logEvents(w.dataDir);
  assert.deepEqual([line.ts, line.cwd, line.project, line.session_id], ["2026-10-08T09:00:00.000Z", "/work/proj/", "proj", null]);
  await assert.rejects(showStatement({ id: "nope", config, env: {} }), /no statement with id "nope"/);
});
