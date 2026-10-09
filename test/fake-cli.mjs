// Stand-in `claude` and `codex` executables for the onboarding tests (the behaviour is in fake-cli.cjs): they answer --version and the login
// probes, record every call, write the host state files a real `plugin` command writes, and `claude -p` / `codex exec` write one valid card per
// statement. `set()` flips the switches (logged out, a failing command) for later calls.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./helpers.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-cli.cjs");

/**
 * A directory with executable `claude` and/or `codex` stand-ins.
 * @param {{claude?: boolean, codex?: boolean, claudeLoggedOut?: boolean, codexLoggedOut?: boolean, claudeAuthUnknown?: boolean, fail?: Record<string, string>}} [o]
 * @returns {{dir: string, log: () => object[], set: (o: object) => void}}
 */
export function fakeClis({ claude = true, codex = true, ...switches } = {}) {
  const dir = tmpDir("recall-fake-cli");
  const set = (o) => {
    const file = path.join(dir, "fake.json");
    const now = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    fs.writeFileSync(file, JSON.stringify({ ...now, ...o }));
  };
  set(switches);
  for (const [name, on] of [["claude", claude], ["codex", codex]]) {
    if (!on) continue;
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nFAKE_CLI_NAME=${name} FAKE_CLI_DIR="${dir}" exec "${process.execPath}" "${SCRIPT}" "$@"\n`, { mode: 0o755 });
  }
  const logFile = path.join(dir, "calls.jsonl");
  return { dir, set, log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse) : []) };
}
