// The body of the stand-in `claude` and `codex` executables (test/fake-cli.mjs makes them). Each call is logged. They write the host state
// files in the formats the real CLIs write (claude 2.1.287, codex 0.160.1; docs/hosts.md), keep a plugin's cached copy per version the way
// Claude Code does (the copy an update replaces, or an uninstall removes, is marked .orphaned_at, never deleted), answer the login probes, and write cards for
// `claude -p` and `codex exec`. Switches live in <dir>/fake.json: {claudeLoggedOut, codexLoggedOut, claudeAuthUnknown, fail: {"<bin> <args...>": "message"},
// real: {claude: "<path>", codex: "<path>"}}; with `real`, every `plugin` subcommand is passed to that real binary (install-real-cli.test.mjs).
// Both read the working directory as a project the way the real CLIs do (codex 0.162, claude 2.1.295): codex refuses `plugin marketplace remove`
// of a marketplace that <cwd>/.codex/config.toml names, and claude's `plugin marketplace remove` also deletes the marketplace and its plugins
// from <cwd>/.claude/settings.json.
const fs = require("node:fs");
const path = require("node:path");

const [bin, dir] = [process.env.FAKE_CLI_NAME, process.env.FAKE_CLI_DIR];
const args = process.argv.slice(2);
const opts = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, "fake.json"), "utf8")); } catch { return {}; } })();
const env = process.env;
fs.appendFileSync(path.join(dir, "calls.jsonl"), `${JSON.stringify({
  bin, args, cwd: process.cwd(), home: env.HOME, claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? null, codexHome: env.CODEX_HOME ?? null, recallChild: env.RECALL_CHILD ?? null,
  keys: Object.keys(env).filter((k) => /_API_KEY$|_AUTH_TOKEN$|^CODEX_ACCESS_TOKEN$/.test(k)).sort(),
})}\n`);

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const fail = (msg, code = 1) => { process.stderr.write(`Error: ${msg}\n`); process.exit(code); };
const key = args.filter((a) => a !== "--json").join(" ");
for (const [k, msg] of Object.entries(opts.fail ?? {})) if (`${bin} ${key}` === k) fail(msg);

if (args[0] === "plugin" && opts.real?.[bin]) {
  const r = require("node:child_process").spawnSync(opts.real[bin], args, { stdio: "inherit", env });
  process.exit(r.status ?? 1);
}
if (args[0] === "--version") { console.log(bin === "claude" ? "2.1.287 (Claude Code)" : "codex-cli 0.160.1"); process.exit(0); }

if (bin === "claude" && args[0] === "auth" && args[1] === "status") {
  if (opts.claudeAuthUnknown) fail("unknown command 'auth'");
  const loggedIn = !opts.claudeLoggedOut;
  console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" }));
  process.exit(loggedIn ? 0 : 1);
}
if (bin === "codex" && args[0] === "login" && args[1] === "status") {
  if (opts.codexLoggedOut) { process.stderr.write("Not logged in\n"); process.exit(1); }
  console.log("Logged in using ChatGPT");
  process.exit(0);
}

/** The text of a card writer's prompt, answered with one valid card per statement. */
function cardsFor(input) {
  const count = [...input.matchAll(/^### (\d+)$/gm)].length;
  return { cards: Array.from({ length: count }, (_, i) => ({ n: i + 1, kind: "rule", scope: "global", gist: "the agent had just replied to an earlier message" })) };
}
function readStdin(then) {
  let input = "";
  process.stdin.on("data", (c) => { input += c; });
  process.stdin.on("end", () => then(input));
}
if (bin === "claude" && args.includes("-p")) readStdin((input) => console.log(JSON.stringify({ is_error: false, result: "", structured_output: cardsFor(input) })));
else if (bin === "codex" && args[0] === "exec") {
  const out = args[args.indexOf("--output-last-message") + 1];
  readStdin((input) => fs.writeFileSync(out, JSON.stringify(cardsFor(input))));
} else if (args[0] === "plugin") (bin === "claude" ? claudePlugin : codexPlugin)(args.slice(1).filter((a) => a !== "--json"));
else fail(`fake ${bin}: unexpected arguments ${JSON.stringify(args)}`, 2);

// ---- claude plugin ----
function claudePlugin(a) {
  const home = env.CLAUDE_CONFIG_DIR || path.join(env.HOME, ".claude");
  const known = path.join(home, "plugins", "known_marketplaces.json");
  const installed = path.join(home, "plugins", "installed_plugins.json");
  const settingsFile = path.join(home, "settings.json");
  const k = readJson(known, {});
  const inst = readJson(installed, { version: 2, plugins: {} });
  const settings = readJson(settingsFile, {});
  const ok = (extra = {}) => { console.log("Working..."); console.log(JSON.stringify({ outcome: "ok", ...extra })); process.exit(0); };
  const save = () => { writeJson(known, k); writeJson(installed, inst); writeJson(settingsFile, settings); };
  /** Claude Code's cache of a plugin: <home>/plugins/cache/<market>/<plugin>/<version>/. The installed copy is marked orphaned when it goes. */
  const cacheOf = (id) => { const [plugin, market] = id.split("@"); return path.join(home, "plugins", "cache", market, plugin); };
  const orphan = (id) => {
    const v = inst.plugins[id]?.[0]?.version;
    const dir = v && path.join(cacheOf(id), v);
    if (dir && fs.existsSync(dir)) fs.writeFileSync(path.join(dir, ".orphaned_at"), String(Date.now()));
  };
  const versionOf = (id) => {
    const [plugin, market] = id.split("@");
    if (!k[market]) fail(`Marketplace "${market}" not found`);
    const m = readJson(path.join(k[market].installLocation, ".claude-plugin", "marketplace.json"), null);
    const entry = m?.plugins.find((p) => p.name === plugin);
    if (!entry) fail(`Plugin "${plugin}" not found in marketplace "${market}"`);
    const installPath = path.resolve(k[market].installLocation, entry.source);
    return { installPath, version: readJson(path.join(installPath, ".claude-plugin", "plugin.json"), {}).version };
  };
  if (a[0] === "marketplace" && a[1] === "add") {
    const src = path.resolve(a[2]);
    const name = readJson(path.join(src, ".claude-plugin", "marketplace.json"), null)?.name;
    if (!name) fail(`No marketplace found at ${src}`);
    k[name] = { source: { source: "directory", path: src }, installLocation: src, lastUpdated: new Date().toISOString() };
    settings.extraKnownMarketplaces = { ...settings.extraKnownMarketplaces, [name]: { source: { source: "directory", path: src } } };
    save();
    ok({ marketplace: name });
  }
  if (a[0] === "marketplace" && a[1] === "update") { if (!k[a[2]]) fail(`Marketplace "${a[2]}" not found`); k[a[2]].lastUpdated = new Date().toISOString(); save(); ok(); }
  if (a[0] === "marketplace" && a[1] === "remove") {
    if (!k[a[2]]) fail(`Marketplace "${a[2]}" not found`);
    delete k[a[2]];
    if (settings.extraKnownMarketplaces) delete settings.extraKnownMarketplaces[a[2]];
    for (const id of Object.keys(inst.plugins)) if (id.endsWith(`@${a[2]}`)) { orphan(id); delete inst.plugins[id]; if (settings.enabledPlugins) delete settings.enabledPlugins[id]; }
    save();
    const projectFile = path.join(process.cwd(), ".claude", "settings.json");
    if (path.resolve(projectFile) !== path.resolve(settingsFile) && fs.existsSync(projectFile)) {
      const project = readJson(projectFile, {});
      delete project.extraKnownMarketplaces?.[a[2]];
      for (const id of Object.keys(project.enabledPlugins ?? {})) if (id.endsWith(`@${a[2]}`)) delete project.enabledPlugins[id];
      writeJson(projectFile, project);
    }
    ok();
  }
  if (a[0] === "install" || a[0] === "update") {
    const id = a[1];
    if (a[0] === "update" && !inst.plugins[id]) fail(`Plugin "${id}" is not installed`);
    const { installPath, version } = versionOf(id);
    if (inst.plugins[id]?.[0]?.version !== version) orphan(id);
    const copy = path.join(cacheOf(id), version);
    fs.mkdirSync(copy, { recursive: true });
    fs.cpSync(path.join(installPath, ".claude-plugin"), path.join(copy, ".claude-plugin"), { recursive: true });
    fs.rmSync(path.join(copy, ".orphaned_at"), { force: true });
    inst.plugins[id] = [{ scope: "user", installPath, version, installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() }];
    settings.enabledPlugins = { ...settings.enabledPlugins, [id]: true };
    save();
    ok({ plugin: id, version });
  }
  if (a[0] === "uninstall") {
    if (!inst.plugins[a[1]]) fail(`Plugin "${a[1]}" is not installed`);
    orphan(a[1]);
    delete inst.plugins[a[1]];
    if (settings.enabledPlugins) delete settings.enabledPlugins[a[1]];
    save();
    ok();
  }
  if (a[0] === "list") { console.log(JSON.stringify(Object.entries(inst.plugins).map(([id, e]) => ({ id, version: e[0].version, enabled: settings.enabledPlugins?.[id] === true })))); process.exit(0); }
  fail(`fake claude: unknown plugin command ${a.join(" ")}`, 2);
}

// ---- codex plugin ----
function codexPlugin(a) {
  const home = env.CODEX_HOME || path.join(env.HOME, ".codex");
  if (env.CODEX_HOME && !fs.existsSync(env.CODEX_HOME)) fail(`CODEX_HOME points to ${JSON.stringify(env.CODEX_HOME)}, but that path does not exist`);
  fs.mkdirSync(home, { recursive: true });
  const configFile = path.join(home, "config.toml");
  let toml = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";
  const sectionRe = (name) => new RegExp(`^\\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*\\n(?:(?!\\[).*\\n?)*`, "m");
  const getSection = (name) => sectionRe(name).exec(toml)?.[0] ?? null;
  const setSection = (name, body) => { const s = `[${name}]\n${body}`; toml = getSection(name) !== null ? toml.replace(sectionRe(name), s) : `${toml}${toml && !toml.endsWith("\n") ? "\n" : ""}${s}`; };
  const dropSection = (name) => { toml = toml.replace(sectionRe(name), ""); };
  const save = () => fs.writeFileSync(configFile, toml);
  const ok = (v = {}) => { process.stderr.write("WARNING: Refusing to create helper binaries under temporary dir\n"); console.log(JSON.stringify({ status: "ok", ...v }, null, 2)); process.exit(0); };
  const sourceOf = (name) => { const s = getSection(`marketplaces.${name}`); return s ? JSON.parse(/source = (".*")/.exec(s)[1]) : null; };
  if (a[0] === "marketplace" && a[1] === "add") {
    const src = path.resolve(a[2]);
    const name = readJson(path.join(src, ".agents", "plugins", "marketplace.json"), null)?.name;
    if (!name) fail(`no marketplace at ${src}`);
    const had = sourceOf(name);
    if (had && had !== src) fail(`marketplace '${name}' is already added from a different source; remove it before adding this source`);
    setSection(`marketplaces.${name}`, `last_updated = "${new Date().toISOString()}"\nsource_type = "local"\nsource = ${JSON.stringify(src)}\n`);
    save();
    ok({ marketplaceName: name, installedRoot: src });
  }
  if (a[0] === "marketplace" && a[1] === "remove") {
    const projectConfig = path.join(process.cwd(), ".codex", "config.toml");
    if (path.resolve(projectConfig) !== path.resolve(configFile) && fs.existsSync(projectConfig) && new RegExp(`^\\[marketplaces\\.${a[2]}\\]`, "m").test(fs.readFileSync(projectConfig, "utf8"))) {
      fail(`marketplace \`${a[2]}\` is configured in project (${projectConfig}); remove it from that configuration source instead`);
    }
  }
  if (a[0] === "marketplace" && a[1] === "remove") { if (!sourceOf(a[2])) fail(`marketplace '${a[2]}' is not added`); dropSection(`marketplaces.${a[2]}`); save(); ok(); }
  if (a[0] === "add") {
    const [plugin, market] = a[1].split("@");
    const src = sourceOf(market);
    if (!src) fail(`marketplace '${market}' is not added`);
    const entry = readJson(path.join(src, ".agents", "plugins", "marketplace.json"), {}).plugins.find((p) => p.name === plugin);
    const root = path.resolve(src, entry.source.path);
    const version = readJson(path.join(root, ".codex-plugin", "plugin.json"), {}).version;
    const cache = path.join(home, "plugins", "cache", market, plugin);
    fs.rmSync(cache, { recursive: true, force: true });
    fs.mkdirSync(path.join(cache, version), { recursive: true });
    fs.cpSync(path.join(root, ".codex-plugin"), path.join(cache, version, ".codex-plugin"), { recursive: true });
    setSection(`plugins."${a[1]}"`, "enabled = true\n");
    save();
    ok({ pluginId: a[1], version });
  }
  if (a[0] === "remove") {
    const [plugin, market] = a[1].split("@");
    if (getSection(`plugins."${a[1]}"`) === null) fail(`plugin '${a[1]}' is not installed`);
    dropSection(`plugins."${a[1]}"`);
    fs.rmSync(path.join(home, "plugins", "cache", market, plugin), { recursive: true, force: true });
    save();
    ok();
  }
  if (a[0] === "list") { console.log(JSON.stringify({ plugins: [...toml.matchAll(/^\[plugins\."([^"]+)"\]/gm)].map((m) => m[1]) }, null, 2)); process.exit(0); }
  fail(`fake codex: unknown plugin command ${a.join(" ")}`, 2);
}
