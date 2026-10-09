// The homes table of setup: every installable home with its Recall status, which ones this run acts on (--homes, --exclude, homes left out
// at an earlier setup or by typing their numbers), whether the index reads it (a home left out is not installed into, but a default home is
// still read for memory), the homes that are only read (Every Code, or a host whose CLI is not on PATH), and the table as printed.
import fs from "node:fs";
import path from "node:path";
import { homeKind, indexedHomes } from "../lib/homes.mjs";
import { resolveHome } from "../lib/home-paths.mjs";
import { UsageError } from "../lib/usage-error.mjs";
import { listTranscripts } from "../lib/transcripts/files.mjs";
import { discoverHomes, HOSTS } from "./agent-homes.mjs";
import { homeStatus, readHomeState, statusText } from "./hosts/index.mjs";
import { readInstalls } from "./install-record.mjs";
import { ONE_LINER } from "./plugin-meta.mjs";
import { keep, padRows, plural, tildePath } from "./ui.mjs";

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** --homes / --exclude: comma-separated paths, each one a discovered home. Returns the matching rows' realpaths. */
function namedHomes(flag, value, rows, homeDir) {
  const out = new Set();
  for (const raw of String(value).split(",").map((s) => s.trim()).filter(Boolean)) {
    const abs = resolveHome(raw, homeDir);
    const row = rows.find((r) => real(r.home) === real(abs));
    if (!row) throw new UsageError(`--${flag}: ${raw} is not an agent home Recall found on this machine`);
    out.add(real(row.home));
  }
  return out;
}

/**
 * @param {{homeDir: string, env: object, tools: object, dataDir: string, M: string, V: string, flags: {homes?: string, exclude?: string}}} o
 * @returns {object[]} rows {host, label, home, display, isDefault, exists, sessions, state, status, acts, leftOut, n}
 */
export function homeRows({ homeDir, env, tools, dataDir, M, V, flags }) {
  const rows = discoverHomes({ homeDir, env, hosts: { claude: tools.claude.found, codex: tools.codex.found } });
  const only = flags.homes ? namedHomes("homes", flags.homes, rows, homeDir) : null;
  const exclude = flags.exclude ? namedHomes("exclude", flags.exclude, rows, homeDir) : new Set();
  const recorded = new Set((readInstalls(dataDir)?.homes ?? []).filter((h) => h.status === "left-out").map((h) => real(h.home)));
  for (const r of rows) {
    r.state = readHomeState(r, V);
    r.status = homeStatus(r.state, { M, V });
    const key = real(r.home);
    r.named = only ? only.has(key) : true;
    r.leftOut = exclude.has(key) || (!only && recorded.has(key));
    r.newlyLeftOut = exclude.has(key) && !recorded.has(key);
  }
  numberRows(rows);
  return rows;
}

/** Can setup act on this row at all (install, or record it left out)? */
export const actionable = (r) => r.named && r.status.kind !== "other";
/** Does this run install into (or keep) Recall in this row? */
export const chosen = (r) => actionable(r) && !r.leftOut;

function numberRows(rows) {
  let n = 0;
  for (const r of rows) r.n = actionable(r) ? ++n : null;
}

/** Leave out the rows with these numbers; false when a number names no row. */
export function leaveOut(rows, numbers) {
  const picked = numbers.map((n) => rows.find((r) => r.n === n));
  if (picked.some((r) => !r)) return false;
  for (const r of picked) { if (!r.leftOut) r.newlyLeftOut = true; r.leftOut = true; }
  return true;
}

const KIND_LABEL = { ...Object.fromEntries(HOSTS.map((h) => [h.host, h.label])), code: "Every Code" };

/**
 * Mark each row read: whether the index reads that home under `cfg` (the settings this run would write). Returns the homes the index reads
 * that are not rows (nothing is installed there): {display, label, sessions}.
 */
export async function markRead(rows, cfg, { homeDir, env }) {
  const homes = (await indexedHomes(cfg, { homeDir, env })).homes;
  const read = new Set(homes.map((h) => real(h.dir)));
  for (const r of rows) r.read = read.has(real(r.home));
  const isRow = new Set(rows.map((r) => real(r.home)));
  return homes.filter((h) => !isRow.has(real(h.dir))).map((h) => {
    const kind = h.kind ?? homeKind(h.dir);
    return { display: tildePath(h.dir, homeDir), label: KIND_LABEL[kind] ?? kind, sessions: listTranscripts(h.dir, kind === "claude" ? "claude" : "codex").length };
  });
}

const leftOutText = (r) => (r.read ? "left out; still read for memory" : "left out");
const isLeftOut = (r) => r.named && r.leftOut && r.status.kind !== "other";

/** The homes table: the installable rows, numbered, then the homes only read; and how to add a left-out home back. */
export function printHomes(ui, rows, V, readOnly = []) {
  ui.title(`Agent homes (${rows.length + readOnly.length})`);
  const cells = rows.map((r) => [
    r.n === null ? "·" : String(r.n),
    r.display,
    r.label,
    plural(r.sessions, "session"),
    !r.named ? "not named in --homes; left as it is" : isLeftOut(r) ? leftOutText(r) : statusText(r.status, V),
  ]);
  for (const h of readOnly) cells.push(["·", h.display, h.label, plural(h.sessions, "session"), "read for memory only"]);
  ui.raw(...padRows(cells));
  const out = rows.filter(isLeftOut);
  if (out.length) ui.say(`  To add ${out.length === 1 ? "the left-out home" : "the left-out homes"} later: ${keep(`${ONE_LINER} --homes ${out.map((r) => r.display).join(",")}`)}`);
}
