// Asking: answers parsed the way a person types them, end of input never taken for an answer, and the key read hidden on a terminal.
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runOnboarding } from "../scripts/onboarding/cli.mjs";
import { createPrompter, Interrupted, NoAnswer, parseAnswer } from "../scripts/onboarding/prompt.mjs";
import { fakeClis } from "./fake-cli.mjs";
import { nodeOnlyDir, sandboxHome } from "./sandbox.mjs";

/** A stream that looks like a terminal: isTTY, and setRawMode recorded. */
function fakeTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.raw = [];
  input.setRawMode = (on) => { input.raw.push(on); return input; };
  return input;
}
function sink() {
  const out = new PassThrough();
  out.text = "";
  out.on("data", (c) => { out.text += c; });
  return out;
}
const tick = () => new Promise((r) => setImmediate(r));

test("parseAnswer: yes and no words, empty for the default, home numbers, and what cannot be read", () => {
  for (const t of ["y", "Yes", "YEAH", "yep please", "sure", "OK", "ok!"]) assert.equal(parseAnswer(t).kind, "yes", t);
  for (const t of ["n", "No", "nope", "no thanks"]) assert.equal(parseAnswer(t).kind, "no", t);
  assert.equal(parseAnswer("   ").kind, "default");
  assert.deepEqual(parseAnswer("2", { numbers: true }), { kind: "numbers", numbers: [2] });
  assert.deepEqual(parseAnswer("2,4", { numbers: true }), { kind: "numbers", numbers: [2, 4] });
  assert.deepEqual(parseAnswer("4 2", { numbers: true }), { kind: "numbers", numbers: [2, 4] });
  assert.deepEqual(parseAnswer("2-4", { numbers: true }), { kind: "numbers", numbers: [2, 3, 4] });
  assert.deepEqual(parseAnswer("2 - 3, 5", { numbers: true }), { kind: "numbers", numbers: [2, 3, 5] });
  assert.equal(parseAnswer("2", { numbers: false }).kind, "invalid");
  for (const t of ["maybe", "2,x", "yesno"]) assert.equal(parseAnswer(t, { numbers: true }).kind, "invalid", t);
});

test("questions read one line each, in order; an unreadable answer is asked again; --yes answers everything", async () => {
  const input = new PassThrough();
  const output = sink();
  const p = createPrompter({ input, output });
  input.end("maybe\nn\n\n3\n");
  assert.equal(await p.confirm("Use this key?"), false);
  assert.equal(await p.confirm("Save it?"), true, "empty takes the default");
  assert.deepEqual(await p.goAhead("Go ahead?"), { leaveOut: [3] });
  p.close();
  assert.match(output.text, /^Use this key\? \[Y\/n\] \nType y or n\.\nUse this key\? \[Y\/n\] \nSave it\? \[Y\/n\] \nGo ahead\? \[Y\/n, or numbers to leave homes out\] \n$/);
  const yes = createPrompter({ yes: true, input: new PassThrough(), output: sink() });
  assert.equal(await yes.confirm("Remove?", { fallback: false }), true);
  assert.deepEqual(await yes.goAhead("Go ahead?"), { go: true });
});

test("end of input is not an answer: every kind of question throws NoAnswer", async () => {
  for (const ask of [(p) => p.confirm("Q?"), (p) => p.goAhead("Go?"), (p) => p.secret("Key: ")]) {
    const input = new PassThrough();
    input.end("");
    await assert.rejects(ask(createPrompter({ input, output: sink() })), NoAnswer);
  }
});

test("off a terminal the key is the next line, not echoed", async () => {
  const input = new PassThrough();
  const output = sink();
  const p = createPrompter({ input, output });
  input.end("sk-piped-key-0001\ny\n");
  assert.equal(await p.secret("Paste: "), "sk-piped-key-0001");
  assert.equal(await p.confirm("Save?"), true);
  assert.ok(!output.text.includes("sk-piped"), output.text);
  assert.equal(p.interactive, false);
});

test("hidden input on a terminal: raw mode, one * per character, backspace erases, escapes ignored, the key never written out", async () => {
  const input = fakeTty();
  const output = sink();
  const p = createPrompter({ input, output });
  const answer = p.secret("Paste your OpenAI API key (hidden): ");
  await tick();
  input.write("sk-ab");
  input.write("x\x7f");
  input.write("\x1b[D\x01cd\r");
  assert.equal(await answer, "sk-abcd");
  assert.deepEqual(input.raw, [true, false]);
  assert.equal(output.text, "Paste your OpenAI API key (hidden): ******\b \b**\n");
  assert.equal(p.interactive, true);
});

test("Ctrl-C at the hidden prompt restores the terminal and throws Interrupted", async () => {
  const input = fakeTty();
  const p = createPrompter({ input, output: sink() });
  const answer = p.secret("Key: ");
  await tick();
  input.write("sk-12\x03");
  await assert.rejects(answer, Interrupted);
  assert.deepEqual(input.raw, [true, false]);
});

test("setup: Ctrl-C at the key prompt exits 130 with 'Stopped. Nothing was changed.' and writes nothing", async () => {
  const home = sandboxHome();
  const clis = fakeClis();
  const input = fakeTty();
  const output = sink();
  const env = { HOME: home, PATH: [clis.dir, nodeOnlyDir(), "/usr/bin", "/bin"].join(":"), RECALL_OPENAI_BASE_URL: "http://127.0.0.1:1" };
  const done = runOnboarding("setup", new Map(), { env, homeDir: home, input, output });
  for (let i = 0; i < 200 && !output.text.includes("(hidden, Enter to stop): "); i++) await new Promise((r) => setTimeout(r, 20));
  input.write("sk-\x03");
  assert.equal(await done, 130);
  assert.match(output.text, /Paste your OpenAI API key \(hidden, Enter to stop\): \*\*\*\nStopped\. Nothing was changed\.\n$/);
  assert.deepEqual(input.raw, [true, false]);
  assert.ok(!(await import("node:fs")).existsSync(`${home}/.plugin-recall`));
});
