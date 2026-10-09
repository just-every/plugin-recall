// Opt-in check that no test file carries text or timestamps from a real history: set RECALL_PRIVACY_STATEMENTS to a statements.jsonl
// (for example your own ~/.plugin-recall/statements.jsonl) and the fixtures and tests are scanned against it. Skipped when unset.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = process.env.RECALL_PRIVACY_STATEMENTS;
const N = 6;
const words = (s) => s.toLowerCase().replace(/[^a-z0-9']+/g, " ").trim().split(" ").filter(Boolean);

test("fixtures and tests share no millisecond timestamp, session id or six-word run with a real statement history", { skip: !SOURCE && "set RECALL_PRIVACY_STATEMENTS to scan" }, () => {
  const rows = fs.readFileSync(SOURCE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const shingles = new Set(); const stamps = new Set(); const sessions = new Set();
  for (const r of rows) {
    const w = words(r.text ?? "");
    for (let i = 0; i + N <= w.length; i++) shingles.add(w.slice(i, i + N).join(" "));
    stamps.add(r.ts); sessions.add(r.session_id);
  }
  const files = execFileSync("git", ["ls-files", "-z", "test"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const m of text.matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g)) if (stamps.has(m[0])) hits.push(`${f}: timestamp ${m[0]}`);
    for (const m of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) if (sessions.has(m[0])) hits.push(`${f}: session ${m[0]}`);
    const w = words(text);
    for (let i = 0; i + N <= w.length; i++) { const k = w.slice(i, i + N).join(" "); if (shingles.has(k)) hits.push(`${f}: "${k}"`); }
  }
  // generic phrases that real histories also contain (URLs, array literals, host version strings, publisher paths)
  const generic = /127 0 0 1|1 2 3 4 5|claude code 2 1|just every|http|json/;
  const real = [...new Set(hits)].filter((h) => !generic.test(h));
  assert.deepEqual(real, []);
});
