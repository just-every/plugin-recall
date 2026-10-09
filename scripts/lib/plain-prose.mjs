// The prose of a message, for the prompt-time situation: fenced code, tool output, file dumps, diffs and URLs taken out. One measurement found the
// Decisions API refusing 186 questions in 44 of 85 cases when the situation carried a long assistant excerpt (a reply full of links, code and
// pasted output), against 7 without; none of those parts says what the owner is working on that the prose does not. Applied BEFORE the excerpt
// is clipped, so the budget is spent on words. Heuristics, by line and by pattern; nothing is rewritten, only removed.

// Blocks a harness or a paste wraps tool output in.
const WRAPPERS = ["tool_result", "tool_use", "function_results", "function_calls", "system-reminder", "local-command-stdout", "local-command-stderr", "command-stdout", "command-stderr", "stdout", "stderr", "file_content"];
const WRAPPER = new RegExp(WRAPPERS.map((w) => `<${w}\\b[^>]*>[\\s\\S]*?(?:</${w}>|$)`).join("|"), "gi");
const FENCE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g;
const MD_LINK = /\[([^\]\n]*)\]\((?:https?|ftp|file):\/\/[^)\s]*\)/g;
const URL_TEXT = /\b(?:https?|ftp|wss?|file):\/\/\S+/gi;
const LONG_TOKEN = /\S{81,}/g; // a hash, a base64 blob, minified code
const DUMP_LINE = /^\s*\d{1,6}(?:\t|→| ?\| )/; // `cat -n` / editor line numbers
const DIFF_LINE = /^(?:diff --git |index [0-9a-f]{7,}\.\.[0-9a-f]{7,}|--- a\/|\+\+\+ b\/|@@ .* @@)/;
const SHELL_LINE = /^\s*\$ \S/;
const INDENTED_CODE = /^(?: {4,}|\t)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** @param {string|null|undefined} text @returns {string} the prose of `text`, "" when there is none */
export function plainProse(text) {
  let t = String(text ?? "").replace(WRAPPER, "\n").replace(FENCE, "\n").replace(MD_LINK, "$1").replace(URL_TEXT, "").replace(LONG_TOKEN, "");
  t = t.split("\n").filter((line) => !(DUMP_LINE.test(line) || DIFF_LINE.test(line) || SHELL_LINE.test(line) || (INDENTED_CODE.test(line) && !LIST_ITEM.test(line)))).map((l) => l.trimEnd()).join("\n");
  return t.replace(/\n{3,}/g, "\n\n").trim();
}
