// Saving the key into ~/.env: one line set, every other byte kept, a dotfiles symlink kept a link, the file's mode kept (a new file is 0600).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { envFileState, upsertEnvLine } from "../scripts/onboarding/env-file.mjs";
import { tmpDir } from "./helpers.mjs";

const mode = (f) => fs.statSync(f).mode & 0o777;

test("a new ~/.env gets the one line and mode 0600, with no quotes around the value", () => {
  const file = path.join(tmpDir("recall-env"), ".env");
  upsertEnvLine(file, "OPENAI_API_KEY", "sk-new-value-0001");
  assert.equal(fs.readFileSync(file, "utf8"), "OPENAI_API_KEY=sk-new-value-0001\n");
  assert.equal(mode(file), 0o600);
  assert.deepEqual(envFileState(file, "OPENAI_API_KEY"), { exists: true, value: "sk-new-value-0001", loose: false });
});

test("append: a file without a final newline gets one first; every other byte stays as it was", () => {
  const file = path.join(tmpDir("recall-env"), ".env");
  const before = "# my settings\r\nEDITOR=vim\nPATH_EXTRA='a b'";
  fs.writeFileSync(file, before, { mode: 0o600 });
  upsertEnvLine(file, "OPENAI_API_KEY", "sk-appended-0001");
  assert.equal(fs.readFileSync(file, "utf8"), `${before}\nOPENAI_API_KEY=sk-appended-0001\n`);
});

test("replace: the first line that sets the name is replaced, its `export ` kept; the rest of the file is untouched", () => {
  const file = path.join(tmpDir("recall-env"), ".env");
  fs.writeFileSync(file, "A=1\r\n  export OPENAI_API_KEY = \"sk-old-0001\"\r\nB=2\nOPENAI_API_KEY=sk-second-line\n", { mode: 0o600 });
  upsertEnvLine(file, "OPENAI_API_KEY", "sk-replaced-0001");
  assert.equal(fs.readFileSync(file, "utf8"), "A=1\r\n  export OPENAI_API_KEY=sk-replaced-0001\r\nB=2\nOPENAI_API_KEY=sk-second-line\n");
  assert.equal(envFileState(file, "OPENAI_API_KEY").value, "sk-replaced-0001");
});

test("an existing mode is kept (0644 stays 0644, and is reported as readable by others)", () => {
  const file = path.join(tmpDir("recall-env"), ".env");
  fs.writeFileSync(file, "X=1\n");
  fs.chmodSync(file, 0o644);
  assert.equal(envFileState(file, "OPENAI_API_KEY").loose, true);
  upsertEnvLine(file, "OPENAI_API_KEY", "sk-mode-kept-0001");
  assert.equal(mode(file), 0o644);
});

test("a symlinked ~/.env (dotfiles) stays a link; the file it points to is written", () => {
  const dir = tmpDir("recall-env");
  const real = path.join(dir, "dotfiles", "env");
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, "Y=2\n", { mode: 0o600 });
  const link = path.join(dir, ".env");
  fs.symlinkSync(real, link);
  upsertEnvLine(link, "OPENAI_API_KEY", "sk-through-link-0001");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(real, "utf8"), "Y=2\nOPENAI_API_KEY=sk-through-link-0001\n");
  assert.deepEqual(fs.readdirSync(path.dirname(real)), ["env"], "no temp file is left behind");
});

test("envFileState of a missing file", () => {
  assert.deepEqual(envFileState(path.join(tmpDir("recall-env"), ".env"), "OPENAI_API_KEY"), { exists: false, value: undefined, loose: false });
});
