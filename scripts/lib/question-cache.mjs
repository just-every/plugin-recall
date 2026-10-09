// Exact Decisions answer identity: a predicate is keyed by its input and instructions, a choice by its input, type, instructions and choices (option order kept). Names and packing are irrelevant.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "./sqlite.mjs";

export const predicateKey = (input, instructions) => createHash("sha256").update(input).update("\u0000").update(instructions).digest("hex").slice(0, 32);
export function questionKey(input, question) {
  if (question.type === "predicate") return predicateKey(input, question.instructions);
  if (question.type !== "choice") throw new Error(`Unsupported cached question type: ${question.type}`);
  const body = { input, type: question.type, instructions: question.instructions, choices: question.choices };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export const predicateAnswer = (p) => p === null ? { type: "refusal" } : { type: "predicate", probability: p };
const cleanAnswer = ({ name, ...answer }) => answer;
export function createQuestionCache({ dir, enabled = true }) {
  let db;
  let select;
  let insert;
  let enrich;
  function open() {
    if (db) return;
    mkdirSync(dir, { recursive: true });
    db = openDatabase(path.join(dir, "question-cache.sqlite"));
    db.exec("PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS answers (key TEXT PRIMARY KEY, answer TEXT NOT NULL, provenance TEXT) WITHOUT ROWID");
    select = db.prepare("SELECT answer, provenance FROM answers WHERE key = ?");
    insert = db.prepare("INSERT OR IGNORE INTO answers(key, answer, provenance) VALUES (?, ?, ?)");
    enrich = db.prepare("UPDATE answers SET provenance = ? WHERE key = ?");
  }
  return {
    enabled,
    getKey(key) {
      if (!enabled) return undefined;
      open();
      const row = select.get(key);
      return row ? { answer: JSON.parse(row.answer), provenance: row.provenance ? JSON.parse(row.provenance) : null } : undefined;
    },
    get(input, question) { return this.getKey(questionKey(input, question)); },
    putKey(key, answer, provenance = null) {
      if (!enabled) return false;
      if (!/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(key)) throw new Error(`Invalid question key: ${key}`);
      const normalized = cleanAnswer(answer);
      if (!["predicate", "choice", "refusal"].includes(normalized.type)) throw new Error(`Invalid answer type: ${normalized.type}`);
      if (normalized.type === "predicate" && (!Number.isFinite(normalized.probability) || normalized.probability < 0 || normalized.probability > 1)) throw new Error(`Invalid probability for ${key}`);
      open();
      const text = JSON.stringify(normalized);
      const result = insert.run(key, text, provenance ? JSON.stringify(provenance) : null);
      if (!result.changes) {
        const previous = select.get(key);
        if (previous.answer !== text) throw new Error(`Conflicting Decisions answer for ${key}`);
        if (provenance?.requestId && !JSON.parse(previous.provenance ?? "null")?.requestId) enrich.run(JSON.stringify(provenance), key);
      }
      return Boolean(result.changes);
    },
    put(input, question, answer, provenance) { return this.putKey(questionKey(input, question), answer, provenance); },
    transaction(fn) {
      if (!enabled) return fn();
      open(); db.exec("BEGIN IMMEDIATE");
      try { const value = fn(); db.exec("COMMIT"); return value; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    count() { open(); return db.prepare("SELECT COUNT(*) AS n FROM answers").get().n; },
    close() { db?.close(); db = undefined; },
  };
}
