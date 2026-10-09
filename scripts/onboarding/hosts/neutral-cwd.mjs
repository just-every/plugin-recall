// The working directory every host CLI child runs in. Both hosts read the working directory as a project:
//   codex   <cwd>/.codex/config.toml is a project config layer. Run from the home folder, ~/.codex/config.toml becomes one, and
//           `codex plugin marketplace remove` under CODEX_HOME=~/.codex_other fails: "marketplace `plugin-recall` is configured in
//           project (~/.codex/config.toml); remove it from that configuration source instead" (when the project is trusted).
//   claude  <cwd>/.claude/settings.json is project settings. `claude plugin marketplace remove` from the home folder deletes the marketplace
//           and its enabled plugin from ~/.claude/settings.json too, a different home from the CLAUDE_CONFIG_DIR being worked on.
// So no host child inherits the person's cwd. It gets a private (0700), empty directory made once per process in the system temp folder: a
// place no host treats as a project, with no .codex or .claude in it or, on the usual temp folder, in any parent. Not the data dir
// (~/.plugin-recall): that sits under the home folder, one level below the very folder that holds ~/.codex and ~/.claude.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dir = null;

/** The empty directory host CLI children run in; created on first use and removed when this process exits. */
export function neutralCwd() {
  if (dir && fs.existsSync(dir)) return dir;
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "recall-host-")));
  const made = dir;
  process.once("exit", () => { try { fs.rmSync(made, { recursive: true, force: true }); } catch { /* already gone */ } });
  return dir;
}
