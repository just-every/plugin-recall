// Asking. `--yes` accepts every yes/no question; otherwise each question reads one line from stdin (a terminal, or a pipe in a script), in the
// order the flow reaches it. End of input is never an answer: it throws NoAnswer. A key is read hidden on a terminal (one * per character).

/** stdin ended before a question was answered. */
export class NoAnswer extends Error {
  constructor() { super("no answer on stdin"); this.name = "NoAnswer"; }
}
/** Ctrl-C at the hidden key prompt (the terminal is in raw mode there, so the shell's own SIGINT does not happen). */
export class Interrupted extends Error {
  constructor() { super("interrupted"); this.name = "Interrupted"; }
}

const YES = new Set(["y", "yes", "yeah", "yep", "sure", "ok"]);
const NO = new Set(["n", "no", "nope"]);

/**
 * One typed answer: {kind: "default"} (empty), "yes", "no", {kind: "numbers", numbers} (`2`, `2,4`, `2-4`, `2 4`, when numbers are allowed),
 * or "invalid".
 */
export function parseAnswer(text, { numbers = false } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return { kind: "default" };
  const word = t.split(/[\s,.!]+/)[0].toLowerCase();
  if (YES.has(word)) return { kind: "yes" };
  if (NO.has(word)) return { kind: "no" };
  if (numbers) {
    const norm = t.replace(/\s*-\s*/g, "-");
    if (/^\d+(-\d+)?([\s,]+\d+(-\d+)?)*$/.test(norm)) {
      const out = new Set();
      for (const tok of norm.split(/[\s,]+/)) {
        const [a, b = a] = tok.split("-").map(Number);
        for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.add(n);
      }
      return { kind: "numbers", numbers: [...out].sort((x, y) => x - y) };
    }
  }
  return { kind: "invalid" };
}

/** Skip one terminal escape sequence (arrow keys, bracketed-paste markers) at the start of `s`; returns what follows it. */
function skipEscape(s) {
  if (s[0] !== "[" && s[0] !== "O") return s.slice(1);
  let i = 1;
  while (i < s.length && !(s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e)) i++;
  return s.slice(i + 1);
}

/**
 * @param {{yes?: boolean, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} [o]
 */
export function createPrompter({ yes = false, input = process.stdin, output = process.stdout } = {}) {
  let buf = "";
  let ended = false;
  let attached = false;
  let notify = null;
  const wake = () => { const n = notify; notify = null; n?.(); };
  const onData = (c) => { buf += String(c); wake(); };
  const onEnd = () => { ended = true; wake(); };
  const attach = () => {
    if (attached) return;
    attached = true;
    input.setEncoding?.("utf8");
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onEnd);
    input.resume?.();
  };
  const more = () => new Promise((resolve) => { notify = resolve; });

  async function readLine() {
    attach();
    for (;;) {
      const i = buf.indexOf("\n");
      if (i >= 0) { const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); return line; }
      if (ended) { if (!buf) return null; const line = buf; buf = ""; return line; }
      await more();
    }
  }

  async function readHidden() {
    attach();
    input.setRawMode(true);
    let value = "";
    try {
      for (;;) {
        while (!buf && !ended) await more();
        if (!buf) { if (value) { output.write("\n"); return value; } return null; }
        const ch = buf[0];
        buf = buf.slice(1);
        if (ch === "\r" || ch === "\n") { output.write("\n"); return value; }
        if (ch === "\x03") { output.write("\n"); throw new Interrupted(); }
        if (ch === "\x7f" || ch === "\b") { if (value) { value = value.slice(0, -1); output.write("\b \b"); } continue; }
        if (ch === "\x1b") { buf = skipEscape(buf); continue; }
        if (ch < " ") continue;
        value += ch;
        output.write("*");
      }
    } finally {
      input.setRawMode(false);
    }
  }

  async function ask(question, hint, { numbers, fallback, invalid }) {
    for (;;) {
      output.write(`${question} [${hint}] `);
      const line = await readLine();
      if (line === null) { output.write("\n"); throw new NoAnswer(); }
      if (!input.isTTY) output.write("\n"); // a piped answer is not echoed: end the question's line
      const a = parseAnswer(line, { numbers });
      if (a.kind === "default") return { kind: fallback ? "yes" : "no" };
      if (a.kind !== "invalid") return a;
      output.write(`${invalid}\n`);
    }
  }

  return {
    yes,
    /** A yes/no question; an empty answer takes `fallback`. */
    async confirm(question, { fallback = true } = {}) {
      if (yes) { output.write(`${question} [--yes] yes\n`); return true; }
      return (await ask(question, fallback ? "Y/n" : "y/N", { numbers: false, fallback, invalid: "Type y or n." })).kind === "yes";
    },
    /** The go-ahead: {go: true}, {go: false}, or {leaveOut: [row numbers]}. */
    async goAhead(question) {
      if (yes) { output.write(`${question} [--yes] yes\n`); return { go: true }; }
      const a = await ask(question, "Y/n, or numbers to leave homes out", { numbers: true, fallback: true, invalid: "Type y, n, or home numbers such as 2,4." });
      return a.kind === "numbers" ? { leaveOut: a.numbers } : { go: a.kind === "yes" };
    },
    /** A secret: hidden with * on a terminal; off a terminal the next stdin line, not echoed. Returns it untrimmed. */
    async secret(question) {
      output.write(question);
      if (input.isTTY && typeof input.setRawMode === "function") {
        const v = await readHidden();
        if (v === null) throw new NoAnswer();
        return v;
      }
      const line = await readLine();
      output.write("\n");
      if (line === null) throw new NoAnswer();
      return line;
    },
    /** Whether a hidden prompt can be asked again (a terminal), or the first bad answer ends the run (a pipe). */
    interactive: Boolean(input.isTTY),
    close() {
      if (!attached) return;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      input.pause?.();
    },
  };
}
