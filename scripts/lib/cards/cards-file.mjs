// The cards file: JSONL, one card per line, append-only. `recall enrich` appends; the hooks and `recall eval --cards` read. A statement has
// at most one card (the last line for an id wins, so a re-run can correct it). A bad line is an error naming the file and line, never skipped.
import fs from "node:fs";
import path from "node:path";
import { cardProblems } from "./schema.mjs";

export const cardsPath = (dataDir) => path.join(dataDir, "cards.jsonl");

/** @returns {Map<string, object>} id -> card; an empty map when the file does not exist */
export function loadCards(file) {
  const cards = new Map();
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return cards;
    throw e;
  }
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop(); // a line another process is still appending
  for (const [i, line] of lines.entries()) {
    if (!line) continue;
    let card;
    try { card = JSON.parse(line); } catch { throw new Error(`${file} line ${i + 1} is not JSON`); }
    const problems = cardProblems(card);
    if (problems.length) throw new Error(`${file} line ${i + 1} is not a valid card: ${problems.join("; ")}`);
    cards.set(card.id, card);
  }
  return cards;
}

/** Append cards, one O_APPEND write for the batch. Every card is validated first. */
export function appendCards(file, cards) {
  if (!cards.length) return;
  for (const c of cards) {
    const problems = cardProblems(c);
    if (problems.length) throw new Error(`refusing to write an invalid card ${c?.id}: ${problems.join("; ")}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, cards.map((c) => `${JSON.stringify(c)}\n`).join(""));
}
