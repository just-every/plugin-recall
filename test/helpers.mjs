// Test helpers: a deterministic fake of the two OpenAI endpoints (no network), temp dirs, fixture loading.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIM } from "../scripts/lib/vec.mjs";
import { createHash } from "node:crypto";
import { tokenize } from "../scripts/lib/text.mjs";
import { APPLY_TEXT } from "../scripts/lib/apply-gate.mjs";

// The real API wrapper resolves a key before invoking an injected fake post. Never consult a real ~/.env in tests.
process.env.OPENAI_API_KEY = "sk-test-no-network";
// Inside a Claude Code or Codex session these name the live agent home. Recall adds them to the homes it mines, so a test that indexes
// would read (and race against) the real, growing transcripts. A test that needs either passes its own env.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const made = [];
process.on("exit", () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
/** A fresh temp dir, removed when the test process exits. */
export const tmpDir = (name = "recall-test") => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); made.push(d); return d; };
export const readFixture = (...p) => fs.readFileSync(path.join(FIXTURES, ...p), "utf8");
export const claudeLine = (name) => Buffer.from(JSON.parse(readFixture("claude-lines.json"))[name]);

/** Bag-of-hashed-tokens unit vector: texts sharing words are close, so retrieval tests behave plausibly. */
export function fakeEmbedding(text) {
  const v = new Array(DIM).fill(0);
  const toks = tokenize(text);
  if (!toks.length) v[0] = 1;
  for (const t of toks) v[createHash("md5").update(t).digest().readUInt16BE(0) % DIM] += 1;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

const quoteOf = (instructions) => /Past owner statement(?: \(said while [^)]*\))?: "([\s\S]*?)"\n/.exec(instructions)?.[1] ?? "";
const overlap = (a, b) => { const B = new Set(tokenize(b)); return new Set(tokenize(a)).size && [...new Set(tokenize(a))].filter((t) => B.has(t)).length; };

/** Default fake judge: a statement is "important" (0.99) when it shares >= 2 words with the situation, else 0.04. */
export const defaultDecide = ({ input, instructions }) => (overlap(quoteOf(instructions), input) >= 2 ? 0.99 : 0.04);

/** Is this predicate the apply gate's question (apply-gate.mjs)? It is answered by `decideApply`, never by `decide`. */
export const isApplyQuestion = (instructions) => instructions.endsWith(`\n${APPLY_TEXT}`);
/** The statement text and the card gist of a question's `Past owner statement (said while <gist>): "<text>"` line. */
export const applyParts = (instructions) => { const m = /^Past owner statement \(said while ([\s\S]*?)\): "([\s\S]*)"\n/.exec(instructions); return { gist: m?.[1] ?? null, quote: m?.[2] ?? "" }; };

/**
 * The fake API behind both a fake `post` and a fake HTTP server. `calls` records every request.
 * decideApply answers the apply gate's question: a probability (default 0.9, a yes), null for a refusal, or a function
 * ({input, instructions, name, quote, gist}) -> probability | null. The answer to every other predicate comes from `decide`.
 */
export function fakeOpenAI({ decide = defaultDecide, onCall, decideChoice, decideApply = 0.9 } = {}) {
  const calls = [];
  function respond(pathname, body) {
    calls.push({ pathname, body });
    onCall?.(pathname, body);
    if (pathname === "/v1/embeddings") {
      const tokens = body.input.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
      return { object: "list", model: body.model, data: body.input.map((t, index) => ({ object: "embedding", index, embedding: fakeEmbedding(t) })), usage: { prompt_tokens: tokens, total_tokens: tokens } };
    }
    if (pathname === "/v1/decisions") {
      const chars = JSON.stringify(body).length;
      const answers = body.questions.map((q) => {
        if (q.type === "choice") {
          // listwise questions (compose pipelines): uniform over the choices unless the test says otherwise; decideChoice returns one probability per choice
          const ps = decideChoice ? decideChoice({ input: body.input, question: q }) : q.choices.map(() => 1 / q.choices.length);
          return { type: "choice", name: q.name, choice: q.choices[0].value, probabilities: q.choices.map((c, i) => ({ value: c.value, probability: ps[i] })) };
        }
        const p = isApplyQuestion(q.instructions)
          ? (typeof decideApply === "function" ? decideApply({ input: body.input, instructions: q.instructions, name: q.name, ...applyParts(q.instructions) }) : decideApply)
          : decide({ input: body.input, instructions: q.instructions, name: q.name });
        return p === null ? { type: "refusal", name: q.name } : { type: "predicate", name: q.name, probability: p };
      });
      return { model: body.model, answers, usage: { input_tokens: Math.ceil(chars / 4), output_tokens: 0, total_tokens: Math.ceil(chars / 4) } };
    }
    throw new Error(`fake OpenAI: unexpected path ${pathname}`);
  }
  const post = async (url, body) => ({ status: 200, headers: {}, json: respond(new URL(url).pathname, body), latencyMs: 1, totalMs: 1, attempts: 1, requestId: `req_${calls.length}` });
  return { calls, respond, post };
}

/** Fake OpenAI over real HTTP, for tests that run the hook scripts or the CLI as child processes. `gets` records the free GET requests (models). */
export async function startFakeServer(opts) {
  const api = fakeOpenAI(opts);
  const gets = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      gets.push({ url: req.url, authorization: req.headers.authorization });
      const ok = opts?.acceptKey ? req.headers.authorization === `Bearer ${opts.acceptKey}` : true;
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { object: "list", data: [] } : { error: { message: "bad key" } }));
      return;
    }
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      try {
        const out = api.respond(req.url, JSON.parse(data));
        res.writeHead(200, { "content-type": "application/json", "x-request-id": `req_${api.calls.length}` });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e.message));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls: api.calls, gets, close: () => new Promise((r) => server.close(r)) };
}

/** Write a statements index + embeddings into `dataDir` from [{id,text,ts,session_id,repo,host}], using the fake embedding. */
export async function seedIndex(store, rows) {
  const { textHash, embedInput } = await import("../scripts/lib/text.mjs");
  const { toF32 } = await import("../scripts/lib/vec.mjs");
  const stmts = rows.map((r) => ({ repo: null, host: "claude", session_id: "s-old", ...r, hash: textHash(r.text), src: "test" }));
  store.appendStatements(stmts);
  const seen = new Map();
  for (const s of stmts) if (!seen.has(s.hash)) seen.set(s.hash, toF32(fakeEmbedding(embedInput(s.text))));
  store.appendEmbeddings([...seen.keys()], [...seen.values()]);
  return stmts;
}
