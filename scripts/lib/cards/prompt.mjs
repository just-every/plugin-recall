// The fixed enrichment prompt lives in docs/cards-prompt.md (definitions and examples); this fills in one batch of statements.
import fs from "node:fs";
import { clip, clipHeadTail, norm } from "../text.mjs";

export const PROMPT_FILE = new URL("../../../docs/cards-prompt.md", import.meta.url);
export const OWNER_CLIP = 300;
// The assistant message is clipped to 600 characters keeping both ends: its last sentences (the question asked, the summary) say most about
// what was going on.
export const ASSISTANT_HEAD = 250;
export const ASSISTANT_TAIL = 330;
export const STATEMENT_CLIP = 1200;

export function loadPromptTemplate(file = PROMPT_FILE) {
  const text = fs.readFileSync(file, "utf8");
  for (const marker of ["{{COUNT}}", "{{STATEMENTS}}"]) {
    if (!text.includes(marker)) throw new Error(`the cards prompt ${file.pathname ?? file} has no ${marker}`);
  }
  return text;
}

/**
 * One statement as the model sees it.
 * @param {number} n 1-based number in the batch
 * @param {{statement: object, context: {owner: string|null, assistant: string|null}, note?: string|null}} item
 */
export function renderItem(n, { statement, context, note = null }) {
  const lines = [
    `### ${n}`,
    `Project: ${statement.repo ?? "(none)"}`,
    `Previous owner message: ${context.owner ? JSON.stringify(clip(norm(context.owner), OWNER_CLIP)) : "(none)"}`,
    `Previous assistant message: ${context.assistant ? JSON.stringify(clipHeadTail(norm(context.assistant), ASSISTANT_HEAD, ASSISTANT_TAIL)) : "(none)"}`,
    `Statement: ${JSON.stringify(clip(norm(statement.text), STATEMENT_CLIP))}`,
    // a statement asked again says why its last card was refused
    ...(note ? [`Your previous card for this statement was refused: ${note}. Write a new one.`] : []),
  ];
  return lines.join("\n");
}

/** The prompt for one batch. Statements are numbered 1..N in order; the model answers by number. */
export function buildPrompt(template, items) {
  // function replacers: a statement may contain "$&" or "$1", which a replacement string would expand
  return template.replace("{{COUNT}}", () => String(items.length)).replace("{{STATEMENTS}}", () => items.map((it, i) => renderItem(i + 1, it)).join("\n\n"));
}
