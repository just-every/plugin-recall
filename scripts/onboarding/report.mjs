// Text output for doctor, in the markers setup uses: ✓ ok, ! warn, ✗ fail, · info (coloured on a terminal through `glyph`).
const PLAIN = { ok: "✓", warn: "!", fail: "✗", info: "·" };
const KIND = { ok: "ok", warn: "warn", fail: "fail", info: "skip" };

/** @param {object[]} checks @param {{glyph?: (kind: string) => string}} [o] ui.glyph, to colour the markers on a terminal */
export function formatChecks(checks, { glyph } = {}) {
  const mark = (level) => (glyph ? glyph(KIND[level]) : PLAIN[level]);
  const out = [];
  for (const c of checks) {
    out.push(`  ${mark(c.level)} ${c.title}`);
    for (const l of c.lines) out.push(`      ${l}`);
  }
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  out.push("", fails ? `${fails} problem${fails === 1 ? "" : "s"} to fix${warns ? `, ${warns} warning${warns === 1 ? "" : "s"}` : ""}.` : warns ? `Nothing is broken; ${warns} warning${warns === 1 ? "" : "s"}.` : "Everything checks out.");
  return out.join("\n");
}
