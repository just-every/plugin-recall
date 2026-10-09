// In-process stand-ins for the host CLIs, for the host module tests: write a home's state in the hosts' own formats (docs/hosts.md), and a
// scripted runner that records each command with its environment and applies it to the home that environment names. No process is started.
import fs from "node:fs";
import path from "node:path";

export const ID = "recall@plugin-recall";
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };

/** A Claude Code home: Recall `version` installed (or not), enabled or not, its marketplace at `marketplace`, and another copy's id. */
export function claudeState(home, { version = null, enabled = true, marketplace = null, other = null } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const plugins = {};
  if (version) plugins[ID] = [{ scope: "user", installPath: path.join(home, "plugins", "cache", "plugin-recall", "recall", version), version, installedAt: "2026-10-01T00:00:00.000Z" }];
  if (other) plugins[other] = [{ scope: "user", installPath: "/elsewhere", version: "0.1.0" }];
  writeJson(path.join(home, "plugins", "installed_plugins.json"), { version: 2, plugins });
  if (marketplace) writeJson(path.join(home, "plugins", "known_marketplaces.json"), { "plugin-recall": { source: { source: "directory", path: marketplace }, installLocation: marketplace } });
  writeJson(path.join(home, "settings.json"), { enabledPlugins: { ...(version ? { [ID]: enabled } : {}), ...(other ? { [other]: true } : {}) } });
}

/** A Codex home: config.toml sections and the plugin cache for `version`. */
export function codexState(home, { version = null, enabled = true, marketplace = null, other = null, trusted = false } = {}) {
  fs.mkdirSync(home, { recursive: true });
  let toml = "";
  if (marketplace) toml += `[marketplaces.plugin-recall]\nsource_type = "local"\nsource = ${JSON.stringify(marketplace)}\n\n`;
  if (version) {
    toml += `[plugins."${ID}"]\nenabled = ${enabled}\n\n`;
    fs.mkdirSync(path.join(home, "plugins", "cache", "plugin-recall", "recall", version), { recursive: true });
  }
  if (other) toml += `[plugins."${other}"]\nenabled = true\n\n`;
  if (trusted) toml += `[hooks.state."${ID}:hooks/hooks.json:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:test"\n`;
  fs.writeFileSync(path.join(home, "config.toml"), toml);
}

const dropTable = (toml, header) => toml.replace(new RegExp(`^\\[${header.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&")}\\]\\n(?:(?!\\[).*\\n?)*`, "m"), "");

/** Apply one host command to the home, as the real CLI would. */
function apply(host, home, args, V) {
  const a = args.filter((x) => x !== "--json");
  if (host === "claude") {
    const known = readJson(path.join(home, "plugins", "known_marketplaces.json"), {});
    const inst = readJson(path.join(home, "plugins", "installed_plugins.json"), { version: 2, plugins: {} });
    const settings = readJson(path.join(home, "settings.json"), {});
    if (a[1] === "marketplace" && a[2] === "add") known["plugin-recall"] = { source: { source: "directory", path: a[3] }, installLocation: a[3] };
    else if (a[1] === "marketplace" && a[2] === "remove") delete known["plugin-recall"];
    else if (a[1] === "install" || a[1] === "update") { inst.plugins[ID] = [{ scope: "user", version: V }]; settings.enabledPlugins = { ...settings.enabledPlugins, [ID]: true }; }
    else if (a[1] === "uninstall") { delete inst.plugins[ID]; delete settings.enabledPlugins?.[ID]; }
    writeJson(path.join(home, "plugins", "known_marketplaces.json"), known);
    writeJson(path.join(home, "plugins", "installed_plugins.json"), inst);
    writeJson(path.join(home, "settings.json"), settings);
    return;
  }
  const file = path.join(home, "config.toml");
  let toml = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (a[1] === "marketplace" && a[2] === "remove") toml = dropTable(toml, "marketplaces.plugin-recall");
  else if (a[1] === "marketplace" && a[2] === "add") toml += `[marketplaces.plugin-recall]\nsource = ${JSON.stringify(a[3])}\n`;
  else if (a[1] === "add") {
    toml = `${dropTable(toml, `plugins."${ID}"`)}[plugins."${ID}"]\nenabled = true\n`;
    fs.rmSync(path.join(home, "plugins", "cache", "plugin-recall", "recall"), { recursive: true, force: true });
    fs.mkdirSync(path.join(home, "plugins", "cache", "plugin-recall", "recall", V), { recursive: true });
  } else if (a[1] === "remove") toml = dropTable(toml, `plugins."${ID}"`);
  fs.writeFileSync(file, toml);
}

/**
 * A runner that records {cmd, args, env} and applies the command. `script(call)` may return a result instead ({exitCode, stdout, stderr,
 * timedOut}) to make that command fail or do nothing.
 */
export function scriptedRunner({ homeDir, V, script = () => null }) {
  const calls = [];
  const run = async (cmd, args, { env, timeoutMs }) => {
    const call = { cmd, args, env, timeoutMs };
    calls.push(call);
    const scripted = script(call);
    if (scripted) return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...scripted };
    const home = cmd === "claude" ? env.CLAUDE_CONFIG_DIR ?? path.join(homeDir, ".claude") : env.CODEX_HOME;
    apply(cmd, home, args, V);
    return { exitCode: 0, stdout: cmd === "claude" ? 'Working...\n{"outcome":"ok"}\n' : '{\n  "status": "ok"\n}\n', stderr: cmd === "codex" ? "WARNING: Refusing to create helper binaries under temporary dir\n" : "", timedOut: false };
  };
  return { run, calls, lines: () => calls.map((c) => `${c.cmd} ${c.args.join(" ")}`) };
}
