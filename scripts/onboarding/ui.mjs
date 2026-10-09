// What setup and uninstall print: glyphs (coloured only on a terminal), section titles, paths shown with ~, padded columns (a cell too
// wide for its column ends the line, and the row goes on below it), prose wrapped at 100 characters, or the terminal's width when that is
// narrower, with 4-space continuation lines (never inside a keep() span), and the one progress line a terminal rewrites in place.
import os from "node:os";
import path from "node:path";

/** The widest a printed prose line gets; a narrower terminal wraps at its own width. */
export const WIDTH = 100;
const GLYPHS = { ok: ["✓", "32"], fail: ["✗", "31"], warn: ["!", "33"], skip: ["·", "2"] };

/** `~/x` for a path under the home folder, else the absolute path. */
export function tildePath(p, homeDir = os.homedir()) {
  const abs = path.resolve(p);
  const home = path.resolve(homeDir);
  if (abs === home) return "~";
  return abs.startsWith(`${home}${path.sep}`) ? `~/${abs.slice(home.length + 1)}` : abs;
}

/** "1 session", "2 sessions". */
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** The widest a padded column gets; a longer cell (an absolute path outside ~) sits on its own line and its row goes on below it. */
export const MAX_COLUMN = 40;

/** Rows of cells as lines, every column but the last padded to its widest cell (at most MAX_COLUMN), columns 2 spaces apart. */
export function padRows(rows, { indent = "  ", max = MAX_COLUMN } = {}) {
  const widths = [];
  for (const r of rows) r.forEach((c, i) => { if (i < r.length - 1 && visible(c).length <= max) widths[i] = Math.max(widths[i] ?? 0, visible(c).length); });
  const out = [];
  for (const r of rows) {
    let line = indent;
    r.forEach((c, i) => {
      const w = widths[i] ?? 0;
      const start = visible(line).length;
      line += c;
      if (i === r.length - 1) return;
      if (visible(c).length > w) { // too wide for its column: the rest of the row goes on the next line, under its own columns
        out.push(line.trimEnd());
        line = " ".repeat(start + w);
      } else line += " ".repeat(w - visible(c).length);
      line += "  ";
    });
    out.push(line.trimEnd());
  }
  return out;
}

const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const NBSP = "\u00a0";
/** Text that wrapping never breaks (a command such as `recall doctor`): its spaces are kept together until it is printed. */
export const keep = (s) => String(s).replace(/ /g, NBSP);
const unkeep = (s) => s.replaceAll(NBSP, " ");

/** One line wrapped at WIDTH on spaces; continuation lines get the line's own indent plus 4 spaces. */
export function wrap(line, width = WIDTH) {
  if (visible(line).length <= width) return [line];
  const indent = /^ */.exec(line)[0];
  const out = [];
  let rest = line;
  let lead = "";
  while (visible(lead + rest).length > width) {
    const room = width - lead.length;
    let cut = rest.lastIndexOf(" ", room);
    if (cut <= indent.length) cut = rest.indexOf(" ", room);
    if (cut <= 0) break;
    out.push(lead + rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut + 1).trimStart();
    lead = `${indent}    `;
  }
  out.push(lead + rest);
  return out;
}

/** The wrap width for this stream: WIDTH, or one less than a narrower terminal's columns (so a full line never soft-wraps). */
export const wrapWidth = (stream) => (stream.isTTY && stream.columns > 20 ? Math.min(WIDTH, stream.columns - 1) : WIDTH);

/**
 * @param {{stream?: NodeJS.WritableStream, env?: object, homeDir?: string}} [o]
 */
export function createUi({ stream = process.stdout, env = process.env, homeDir = os.homedir() } = {}) {
  const tty = Boolean(stream.isTTY);
  const color = tty && env.NO_COLOR === undefined && env.TERM !== "dumb";
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  let progressShown = false;
  const clearProgress = () => { if (progressShown) { stream.write("\r\x1b[2K"); progressShown = false; } };
  const ui = {
    tty,
    color,
    path: (p) => tildePath(p, homeDir),
    glyph: (kind) => paint(GLYPHS[kind][1], GLYPHS[kind][0]),
    bold: (s) => paint("1", s),
    /** Print lines as they are, wrapping prose that runs past the wrap width. */
    say(...lines) { clearProgress(); for (const l of lines) for (const w of wrap(l, wrapWidth(stream))) stream.write(`${unkeep(w)}\n`); },
    /** Print lines exactly (table rows, commands), never wrapped. */
    raw(...lines) { clearProgress(); for (const l of lines) stream.write(`${l}\n`); },
    blank() { ui.say(""); },
    title(s) { ui.say(ui.bold(s)); },
    /** `  ✓ text` (or ✗ ! ·). */
    item(kind, text) { ui.say(`  ${ui.glyph(kind)} ${text}`); },
    /** On a terminal: one line rewritten in place, indented like the step lines around it. Off a terminal: nothing (the next line says what happened). */
    progress(text) { if (!tty) return; stream.write(`\r\x1b[2K  ${text}`); progressShown = true; },
    write(s) { clearProgress(); stream.write(s); },
  };
  return ui;
}
