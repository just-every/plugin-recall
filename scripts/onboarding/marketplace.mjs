// Recall's own local marketplace, which both hosts install from: a versioned copy of the running package in the data dir, and the two
// marketplace files pointing at it. Neither host takes npm as a marketplace source, so setup copies what is running (from the npx cache, a
// global install or a checkout alike) and the installed plugin is pinned to exactly that version. Works offline.
//   <dataDir>/marketplace/.claude-plugin/marketplace.json     plugins[0].source = "./plugins/recall-<V>"
//   <dataDir>/marketplace/.agents/plugins/marketplace.json    plugins[0].source = {"source": "local", "path": "./plugins/recall-<V>"}
//   <dataDir>/marketplace/plugins/recall-<V>/                 the package files (package.json `files`, as npm packs them)
// A version directory is never edited in place: a different copy of the same version replaces it whole.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** -1, 0 or 1 for two x.y.z versions (a missing part counts as 0). */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

/** Never copied, wherever they are (npm leaves them out of a pack too). */
const SKIP = [/(^|\/)\.DS_Store$/, /(^|\/)\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /\.swp$/, /(^|\/)\.npmrc$/, /(^|\/)npm-debug\.log$/];

function walkFiles(root, rel = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(root, p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** The package's files as `npm pack` lists them: package.json `files` (a `/**\/*` suffix is the directory), `!` negations, the usual skips. */
export function packFiles(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const strip = (p) => p.replace(/\/\*\*\/\*$/, "").replace(/\/+$/, "");
  const include = pkg.files.filter((p) => !p.startsWith("!")).map(strip);
  const exclude = pkg.files.filter((p) => p.startsWith("!")).map((p) => strip(p.slice(1)));
  const found = new Set(["package.json"]);
  for (const entry of include) {
    const abs = path.join(root, entry);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isDirectory()) for (const f of walkFiles(root, entry)) found.add(f);
    else if (stat.isFile()) found.add(entry);
  }
  const excluded = (f) => exclude.some((x) => f === x || f.startsWith(`${x}/`)) || SKIP.some((re) => re.test(f));
  return [...found].filter((f) => !excluded(f)).sort();
}

/** sha256 over the sorted relative paths and their bytes. */
export function treeHash(root, files) {
  const h = createHash("sha256");
  for (const f of [...files].sort()) h.update(f).update("\0").update(fs.readFileSync(path.join(root, f))).update("\0");
  return h.digest("hex");
}

export const marketplaceDir = (dataDir) => path.join(dataDir, "marketplace");
export const pluginsDir = (dataDir) => path.join(marketplaceDir(dataDir), "plugins");
export const versionDir = (dataDir, V) => path.join(pluginsDir(dataDir), `recall-${V}`);

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

/** The two marketplace files for version V, built from the running package's own marketplace files. */
function marketplaceFiles(root, V) {
  const rel = `./plugins/recall-${V}`;
  const claude = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  claude.plugins[0].source = rel;
  const codex = JSON.parse(fs.readFileSync(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
  codex.plugins[0].source = { source: "local", path: rel };
  return [
    [path.join(".claude-plugin", "marketplace.json"), `${JSON.stringify(claude, null, 2)}\n`],
    [path.join(".agents", "plugins", "marketplace.json"), `${JSON.stringify(codex, null, 2)}\n`],
  ];
}

/**
 * Where the local marketplace stands for the running package (`root`, version V); reads only.
 * copy: "self" (the running package is that directory), "current", "missing" or "differs" (same version, other bytes).
 */
export function marketplaceStatus({ dataDir, root, V }) {
  const M = marketplaceDir(dataDir);
  const dir = versionDir(dataDir, V);
  let copy;
  if (real(root) === real(dir)) copy = "self";
  else if (!fs.existsSync(dir)) copy = "missing";
  else copy = treeHash(dir, walkFiles(dir)) === treeHash(root, packFiles(root)) ? "current" : "differs";
  const filesCurrent = marketplaceFiles(root, V).every(([rel, text]) => readText(path.join(M, rel)) === text);
  return { M, dir, copy, filesCurrent, needsWrite: copy === "missing" || copy === "differs" || !filesCurrent };
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Write the version directory (when it is missing or differs) and then the marketplace files. Returns the status it acted on. */
export function writeMarketplace({ dataDir, root, V }) {
  const status = marketplaceStatus({ dataDir, root, V });
  const plugins = pluginsDir(dataDir);
  if (status.copy === "missing" || status.copy === "differs") {
    const tmp = path.join(plugins, `.recall-${V}.tmp-${process.pid}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const f of packFiles(root)) {
      const from = path.join(root, f);
      const to = path.join(tmp, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      fs.chmodSync(to, fs.statSync(from).mode & 0o777);
    }
    if (status.copy === "differs") {
      const old = path.join(plugins, `.recall-${V}.old-${process.pid}`);
      fs.renameSync(status.dir, old);
      fs.renameSync(tmp, status.dir);
      fs.rmSync(old, { recursive: true, force: true });
    } else fs.renameSync(tmp, status.dir);
  }
  for (const [rel, text] of marketplaceFiles(root, V)) if (readText(path.join(status.M, rel)) !== text) atomicWrite(path.join(status.M, rel), text);
  return status;
}

const HOUR_MS = 3_600_000;

/**
 * Delete old version directories: keep V, the newest older version, and every version in `referenced` (what a home still has installed).
 * Leftover temp directories older than an hour go too. Every deletion names its own path.
 * @returns {string[]} the directories removed
 */
export function collectGarbage({ dataDir, V, referenced = new Set(), now = Date.now() }) {
  const plugins = pluginsDir(dataDir);
  let entries = [];
  try { entries = fs.readdirSync(plugins, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return []; }
  const versions = entries.map((e) => /^recall-(.+)$/.exec(e.name)?.[1]).filter(Boolean);
  const previous = versions.filter((v) => compareVersions(v, V) < 0).sort(compareVersions).at(-1);
  const keep = new Set([V, previous, ...referenced].filter(Boolean));
  const removed = [];
  for (const e of entries) {
    const p = path.join(plugins, e.name);
    const version = /^recall-(.+)$/.exec(e.name)?.[1];
    const stale = /^\.recall-.+\.(tmp|old)-\d+$/.test(e.name) && now - fs.statSync(p).mtimeMs > HOUR_MS;
    if ((version && !keep.has(version)) || stale) {
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(p);
    }
  }
  return removed;
}
