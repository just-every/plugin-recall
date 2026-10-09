// How `recall show` writes an excerpt: a header, then the turns in order (USER / ASSISTANT), the recalled statement marked, tool calls
// between turns as one-line markers. Every turn is cleaned to its prose (plain-prose.mjs, the cleaning the v2.1 situation uses) and clipped.
import { plainProse } from "./plain-prose.mjs";
import { tildePath } from "./plugin-root.mjs";
import { clip } from "./text.mjs";

export const TURN_CLIP = 600;
export const RECALLED_CLIP = 1500; // the statement the card quoted is the point of the page: it keeps more room
export const NO_PROSE = "(no prose: only code, tool output or links)";
const MAX_TOOL_NAMES = 8;

/** "[ran 7 tools: Bash x4, Read x2, Edit]" */
export function toolMarker(names) {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} x${c}` : n));
  const shown = parts.slice(0, MAX_TOOL_NAMES).join(", ");
  return `[ran ${names.length} tool${names.length === 1 ? "" : "s"}: ${shown}${parts.length > MAX_TOOL_NAMES ? `, +${parts.length - MAX_TOOL_NAMES} more` : ""}]`;
}

/** A turn's text as shown: its prose, clipped. */
export function turnText(item) {
  if (item.recalled) return clip(item.text.replace(/\n{3,}/g, "\n\n"), RECALLED_CLIP);
  return clip(plainProse(item.text), TURN_CLIP) || NO_PROSE;
}

const utc = (ts) => (ts ? `${String(ts).slice(0, 10)} ${String(ts).slice(11, 19)} UTC` : "unknown time");
const clock = (ts) => (ts ? String(ts).slice(11, 19) : "--:--:--");

/** The excerpt as plain data (--json) and the text. @param {{statement: object, items: object[], home: string|null, before: number, after: number}} o */
export function viewOf({ statement, file, line, items, home, before, after }) {
  return {
    id: statement.id, ts: statement.ts, host: statement.host, home, repo: statement.repo ?? null, session_id: statement.session_id ?? null, src: statement.src, file, line, before, after,
    items: items.map((it) => (it.type === "tools"
      ? { type: "tools", count: it.names.length, names: it.names }
      : { type: "turn", role: it.role, ts: it.ts, line: it.line, recalled: it.recalled, text: turnText(it) })),
  };
}

export function formatExcerpt(view, { homedir } = {}) {
  const out = [
    `recall show ${view.id}`,
    `${utc(view.ts)} | host ${view.host ?? "unknown"} | home ${view.home ?? "unknown"} | repo ${view.repo ?? "none"} | session ${view.session_id ?? "unknown"}`,
    `source: ${tildePath(view.file, homedir)}:L${view.line}`,
    `(${view.before} turns before and ${view.after} after; text is the prose only, each turn clipped to ${TURN_CLIP} characters; ">>" marks the statement the card quoted)`,
    "",
  ];
  for (const it of view.items) {
    if (it.type === "tools") { out.push(`   ${toolMarker(it.names)}`, ""); continue; }
    const label = it.role === "owner" ? "USER" : "ASSISTANT";
    out.push(`${it.recalled ? ">> " : "   "}${label}${it.recalled ? " (recalled statement)" : ""}  ${clock(it.ts)}  L${it.line}`);
    out.push(...it.text.split("\n").map((l) => (l ? `   ${l}` : "")), "");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}
