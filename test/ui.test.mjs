// What setup prints, as ui.mjs lays it out: the wrap width follows a narrower terminal, a path too wide for its column sits on its own
// line with the row going on below it, the progress line is indented like the step lines, and nothing is coloured off a terminal.
import test from "node:test";
import assert from "node:assert/strict";
import { createUi, MAX_COLUMN, padRows, wrap, wrapWidth } from "../scripts/onboarding/ui.mjs";

const stream = ({ tty = false, columns } = {}) => {
  const s = { isTTY: tty, columns, text: "", write(c) { s.text += c; return true; } };
  return s;
};

test("prose wraps at 100, or at one less than a narrower terminal's width, with 4-space continuation lines", () => {
  assert.equal(wrapWidth(stream()), 100);
  assert.equal(wrapWidth(stream({ tty: true, columns: 80 })), 79);
  assert.equal(wrapWidth(stream({ tty: true, columns: 200 })), 100);
  const out = stream({ tty: true, columns: 80 });
  const line = `  ${"word ".repeat(40).trim()}`;
  createUi({ stream: out, env: { NO_COLOR: "1" } }).say(line);
  const lines = out.text.trimEnd().split("\n");
  assert.ok(lines.length > 2 && lines.every((l) => l.length <= 79), lines.join("\n"));
  assert.ok(lines.slice(1).every((l) => l.startsWith("      word")), "continuations keep the indent plus 4");
  assert.deepEqual(wrap("short", 10), ["short"]);
});

test("a cell wider than its column ends the line; the rest of the row goes on below, under its own columns", () => {
  const long = `/elsewhere/${"x".repeat(MAX_COLUMN)}/claude-home`;
  const rows = padRows([["1", "~/.claude", "Claude Code", "new"], ["2", long, "Claude Code", "new"], ["3", "~/.codex", "Codex", "up to date"]]);
  assert.deepEqual(rows, [
    "  1  ~/.claude  Claude Code  new",
    `  2  ${long}`,
    "                Claude Code  new",
    "  3  ~/.codex   Codex        up to date",
  ]);
});

test("the progress line is rewritten in place on a terminal, indented by 2, and never written off a terminal", () => {
  const tty = stream({ tty: true, columns: 120 });
  const ui = createUi({ stream: tty, env: {} });
  ui.progress("Indexing: embedded 3/6");
  ui.item("ok", "Indexed 6 statements");
  assert.equal(tty.text, "\r\x1b[2K  Indexing: embedded 3/6\r\x1b[2K  \x1b[32m✓\x1b[0m Indexed 6 statements\n");
  const pipe = stream();
  const plain = createUi({ stream: pipe, env: {} });
  plain.progress("Indexing: embedded 3/6");
  plain.item("ok", "Indexed 6 statements");
  assert.equal(pipe.text, "  ✓ Indexed 6 statements\n");
});

test("doctor prints the markers setup prints (✓ ! ✗ ·), coloured only on a terminal", async () => {
  const { formatChecks } = await import("../scripts/onboarding/report.mjs");
  const checks = [{ level: "ok", title: "a", lines: ["detail"] }, { level: "warn", title: "b", lines: [] }, { level: "fail", title: "c", lines: [] }, { level: "info", title: "d", lines: [] }];
  assert.equal(formatChecks(checks), "  ✓ a\n      detail\n  ! b\n  ✗ c\n  · d\n\n1 problem to fix, 1 warning.");
  const plain = createUi({ stream: stream(), env: {} });
  assert.equal(formatChecks(checks, { glyph: plain.glyph }), formatChecks(checks));
  const tty = createUi({ stream: stream({ tty: true, columns: 120 }), env: {} });
  assert.ok(formatChecks(checks, { glyph: tty.glyph }).startsWith("  \x1b[32m✓\x1b[0m a\n"));
});

test("the PATH line is the one for the person's shell", async () => {
  const { pathLine } = await import("../scripts/onboarding/launcher.mjs");
  const exp = `echo 'export PATH="$HOME/.local/bin:$PATH"'`;
  assert.equal(pathLine({ SHELL: "/bin/zsh" }, "darwin"), `${exp} >> ~/.zshrc`);
  assert.equal(pathLine({ SHELL: "/bin/bash" }, "darwin"), `${exp} >> ~/.bash_profile`);
  assert.equal(pathLine({ SHELL: "/usr/bin/bash" }, "linux"), `${exp} >> ~/.bashrc`);
  assert.equal(pathLine({ SHELL: "/opt/homebrew/bin/fish" }, "darwin"), "fish_add_path ~/.local/bin");
  assert.equal(pathLine({}, "linux"), `${exp} >> ~/.profile`);
});
