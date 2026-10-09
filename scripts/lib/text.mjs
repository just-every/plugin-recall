// Small text helpers shared by the indexer and the retrieval pipelines. clip / headWords / tokenize / tsMicros are copied
// from the research prototype so recall reproduces its prompts exactly.
import { createHash } from "node:crypto";

export const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
export const sha1 = (s, n = 40) => createHash("sha1").update(s).digest("hex").slice(0, n);
export const sha256 = (s, n = 64) => createHash("sha256").update(s).digest("hex").slice(0, n);

/** Head clip with an explicit marker; never silently drops text. (`clip`) */
export function clip(s, n) {
  const t = String(s).trim();
  return t.length <= n ? t : `${t.slice(0, n).trimEnd()} [...]`;
}

/** Head+tail clip for long assistant turns where the end (the ask / summary) matters. (`clipHeadTail`) */
export function clipHeadTail(s, head, tail) {
  const t = String(s).trim();
  if (t.length <= head + tail + 20) return t;
  return `${t.slice(0, head).trimEnd()} [...] ${t.slice(t.length - tail).trimStart()}`;
}

const STOP = new Set(
  "a an and are as at be but by for from has have i if in into is it its me my no not of on or our so that the their them then there these they this to up was we were what when which will with you your can do does did how just also than too very would should could about all any been being more most some such".split(" "),
);

/** The tokenizer: lowercase, [a-z0-9_$./-]{2,} runs, edge punctuation trimmed, stop words dropped. */
export function tokenize(s) {
  return (String(s).toLowerCase().match(/[a-z0-9_$./-]{2,}/g) ?? [])
    .map((w) => w.replace(/^[./-]+|[./-]+$/g, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

const TS_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/;

/**
 * ISO-8601 timestamp as integer microseconds since the epoch. Every time comparison goes through this: "05Z" sorts after
 * "05.753000Z" as a string although it is 753 ms earlier. Throws on anything that is not a full ISO-8601 timestamp.
 */
export function tsMicros(s) {
  const m = TS_RE.exec(String(s));
  if (!m) throw new Error(`unparseable timestamp ${JSON.stringify(s)}`);
  const sec = Date.parse(m[1] + m[3]);
  if (!Number.isFinite(sec)) throw new Error(`unparseable timestamp ${JSON.stringify(s)}`);
  const frac = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
  return sec * 1000 + Number(frac);
}

/** Embedding input for a statement: the first 2000 characters (`clip(text, 2000)`). */
export const EMBED_CLIP = 2000;
export const embedInput = (text) => clip(text, EMBED_CLIP);
export const textHash = (text) => sha256(embedInput(text), 32);
