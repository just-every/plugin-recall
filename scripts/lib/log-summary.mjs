// `recall logs`: read the per-turn JSONL logs of one or more UTC days and count what the hooks did, so "is it working, and why is it quiet"
// is one command. Counts only; no query text, no spend. The log itself (<data>/logs/turns-YYYY-MM-DD.jsonl) keeps the detail.
import fs from "node:fs";
import path from "node:path";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** UTC days (newest last) that have a turn log, optionally only the last `days`. */
export function logDays(dataDir, days = null) {
  const dir = path.join(dataDir, "logs");
  if (!fs.existsSync(dir)) return [];
  const all = fs.readdirSync(dir).map((f) => /^turns-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1]).filter(Boolean).sort();
  return days ? all.slice(-days) : all;
}

/**
 * @param {string} dataDir
 * @param {string[]} days UTC days, YYYY-MM-DD
 * @returns {{days: string[], turns: number, byEvent: object, outcomes: object, silentReasons: object, errors: object, hosts: object, silencedHeadless: number, silencedUnknown: number, first: string|null, last: string|null,
 *   excluded: Object<string, {turns: number, statements: number}>, applyGate: {turns: number, survivors: number, passed: number, injected: number, noAnswer: number}}}
 *   excluded: per precision-rule reason, the turns whose history it removed statements from and how many (summed over turns)
 *   applyGate: over the turns where the apply gate ran: how many, the statements it asked about, how many reached its bar, how many were injected, how many got no answer
 */
export function summarizeLogs(dataDir, days) {
  const out = { days, turns: 0, byEvent: {}, outcomes: {}, silentReasons: {}, errors: {}, hosts: {}, silencedHeadless: 0, silencedUnknown: 0, first: null, last: null, excluded: {}, applyGate: { turns: 0, survivors: 0, passed: 0, injected: 0, noAnswer: 0 } };
  const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
  for (const day of days) {
    if (!DAY.test(day)) throw new Error(`bad day ${JSON.stringify(day)}; use YYYY-MM-DD (UTC)`);
    const file = path.join(dataDir, "logs", `turns-${day}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { throw new Error(`corrupt log line ${i + 1} in ${file}`); }
      if (e.event !== "prompt" && e.event !== "stop") continue; // auto-index and other housekeeping lines
      out.turns++;
      bump(out.byEvent, e.event);
      bump(out.outcomes, e.outcome ?? "?");
      if (e.host) bump(out.hosts, e.host);
      if (e.outcome === "silent" && e.reason) {
        bump(out.silentReasons, e.reason);
        if (e.reason.startsWith("headless:")) out.silencedHeadless++;
        if (e.reason.startsWith("unknown:")) out.silencedUnknown++;
      }
      if (e.level === "error") bump(out.errors, e.reason ?? "error");
      for (const [reason, x] of Object.entries(e.excluded ?? {})) {
        const t = out.excluded[reason] ?? (out.excluded[reason] = { turns: 0, statements: 0 });
        t.turns++;
        t.statements += x.count;
      }
      if (e.event === "prompt" && typeof e.applyGate?.survivors === "number" && Array.isArray(e.applyGate.rows)) {
        const g = out.applyGate;
        g.turns++;
        g.survivors += e.applyGate.survivors;
        g.passed += e.applyGate.passed ?? 0;
        g.injected += e.applyGate.selected ?? 0;
        g.noAnswer += e.applyGate.refused ?? 0;
      }
      out.first ??= e.ts;
      out.last = e.ts;
    }
  }
  return out;
}

export function formatSummary(s) {
  const rows = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(6)}  ${k}`).join("\n") || "  (none)";
  return [
    `days: ${s.days.join(", ") || "(no logs)"}   hook turns: ${s.turns}   ${s.first ? `${s.first} .. ${s.last}` : ""}`.trimEnd(),
    `by event:\n${rows(s.byEvent)}`,
    `by host:\n${rows(s.hosts)}`,
    `outcomes:\n${rows(s.outcomes)}`,
    `silent, by reason (headless: = non-interactive session, unknown: = could not tell, both fail closed):\n${rows(s.silentReasons)}`,
    `loud errors, by reason:\n${rows(s.errors)}`,
    ...(Object.keys(s.excluded).length ? [`kept out of the history before ranking by a precision rule (turns, statements summed over turns):\n${Object.entries(s.excluded).sort((a, b) => b[1].statements - a[1].statements).map(([k, v]) => `  ${String(v.turns).padStart(6)}  ${String(v.statements).padStart(8)}  ${k}`).join("\n")}`] : []),
    ...(s.applyGate?.turns ? [`apply gate (turns where it ran; statements it asked about, at its bar or more, injected, without an answer):\n  ${String(s.applyGate.turns).padStart(6)}  turns\n  ${String(s.applyGate.survivors).padStart(6)}  asked\n  ${String(s.applyGate.passed).padStart(6)}  at the bar\n  ${String(s.applyGate.injected).padStart(6)}  injected\n  ${String(s.applyGate.noAnswer).padStart(6)}  no answer`] : []),
  ].join("\n\n");
}
