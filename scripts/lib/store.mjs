// On-disk index: <dataDir>/statements.jsonl (append-only, one owner statement per line), <dataDir>/embeddings/ (immutable chunk files:
// c-<time>-<rand>.f32 raw float32 rows + c-<...>.json {hashes}; keyed by textHash so a sentence is embedded once however often it was
// said), <dataDir>/state/files.json (incremental scan state per transcript file), <dataDir>/retired.jsonl (statements the current owner-text
// rules no longer make of their line, taken out of statements.jsonl by the backfill: transcripts/rejudge.mjs). Chunk files are written to a temp name and renamed,
// so concurrent readers and writers never see a partial file and no lock is needed. The shared statements file is append-only; the append
// itself runs under <dataDir>/locks/store.lock so two writers cannot interleave a large batch, and a reader that meets a line still being
// written (no trailing newline yet) skips it until the next read instead of calling it corrupt.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withLockSync } from "./lock.mjs";
import { DIM } from "./vec.mjs";

export function createStore(dir) {
  const statementsFile = path.join(dir, "statements.jsonl");
  const embDir = path.join(dir, "embeddings");
  const stateFile = path.join(dir, "state", "files.json");
  const retiredFile = path.join(dir, "retired.jsonl");

  function loadStatements() {
    if (!existsSync(statementsFile)) return [];
    const out = [];
    const text = readFileSync(statementsFile, "utf8");
    const lines = text.split("\n");
    if (!text.endsWith("\n")) lines.pop(); // a line another process is still appending
    for (const [i, line] of lines.entries()) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { throw new Error(`corrupt line ${i + 1} in ${statementsFile}`); }
    }
    return out;
  }

  function appendStatements(rows) {
    if (!rows.length) return;
    mkdirSync(dir, { recursive: true });
    const data = rows.map((r) => `${JSON.stringify(r)}\n`).join("");
    withLockSync(path.join(dir, "locks", "store.lock"), () => appendFileSync(statementsFile, data), { staleMs: 60_000, timeoutMs: 30_000 });
  }

  /**
   * Rewrite the statements under the store lock (an append by another process waits, never lost): `change` gets the current rows and returns
   * the new rows, or null for no change. Used to repair a field of rows already indexed. Returns whether the file was rewritten.
   */
  function updateStatements(change) {
    mkdirSync(dir, { recursive: true });
    return withLockSync(path.join(dir, "locks", "store.lock"), () => {
      const next = change(loadStatements());
      if (!next) return false;
      const tmp = `${statementsFile}.${process.pid}.tmp`;
      writeFileSync(tmp, next.map((r) => `${JSON.stringify(r)}\n`).join(""));
      renameSync(tmp, statementsFile);
      return true;
    }, { staleMs: 60_000, timeoutMs: 30_000 });
  }

  /** Append statements taken out of the index, each with why (`retired`). Kept for the record; nothing retrieves from it. */
  function appendRetired(rows) {
    if (!rows.length) return;
    mkdirSync(dir, { recursive: true });
    appendFileSync(retiredFile, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  }

  /** Map textHash -> Float32Array(DIM) over every chunk. Duplicates (a compaction or a race) are harmless: same hash, same vector. */
  function loadEmbeddings() {
    const map = new Map();
    if (!existsSync(embDir)) return map;
    for (const name of readdirSync(embDir).sort()) {
      if (!name.endsWith(".json") || name.includes(".tmp")) continue;
      const meta = JSON.parse(readFileSync(path.join(embDir, name), "utf8"));
      const buf = readFileSync(path.join(embDir, name.replace(/\.json$/, ".f32")));
      if (buf.length !== meta.hashes.length * DIM * 4) throw new Error(`embedding chunk ${name} is inconsistent: ${buf.length} bytes for ${meta.hashes.length} vectors`);
      const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
      meta.hashes.forEach((h, i) => { if (!map.has(h)) map.set(h, f32.subarray(i * DIM, (i + 1) * DIM)); });
    }
    return map;
  }

  /** The text hashes that have an embedding, from the chunk indexes alone (the vectors are not read). */
  function embeddedHashes() {
    const out = new Set();
    if (!existsSync(embDir)) return out;
    for (const name of readdirSync(embDir)) {
      if (!name.endsWith(".json") || name.includes(".tmp")) continue;
      for (const h of JSON.parse(readFileSync(path.join(embDir, name), "utf8")).hashes) out.add(h);
    }
    return out;
  }

  /** Write one chunk: the .f32 first, then the .json that makes it visible (readers only list .json). */
  function appendEmbeddings(hashes, vectors) {
    if (!hashes.length) return;
    if (hashes.length !== vectors.length) throw new Error("appendEmbeddings: hashes and vectors differ in length");
    mkdirSync(embDir, { recursive: true });
    const id = `c-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const f32 = new Float32Array(vectors.length * DIM);
    vectors.forEach((v, i) => f32.set(v, i * DIM));
    const bin = path.join(embDir, `${id}.f32`);
    writeFileSync(`${bin}.tmp`, Buffer.from(f32.buffer));
    renameSync(`${bin}.tmp`, bin);
    const meta = path.join(embDir, `${id}.json`);
    writeFileSync(`${meta}.tmp`, JSON.stringify({ hashes }));
    renameSync(`${meta}.tmp`, meta);
  }

  function loadState() {
    if (!existsSync(stateFile)) return { files: {}, lastIndexAt: null };
    return JSON.parse(readFileSync(stateFile, "utf8"));
  }

  function saveState(state) {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, stateFile);
  }

  return { dir, statementsFile, retiredFile, loadStatements, appendStatements, updateStatements, appendRetired, loadEmbeddings, embeddedHashes, appendEmbeddings, loadState, saveState };
}
