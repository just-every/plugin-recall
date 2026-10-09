// Writing one variable into ~/.env, the file Recall's hooks read a key from when the app that runs them has no such variable. Every other
// byte of the file is kept, a dotfiles symlink stays a link, an existing file keeps its mode and a new one is 0600. The value is never printed.
import fs from "node:fs";
import path from "node:path";
import { parseEnvFile } from "../lib/key.mjs";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What `file` holds for `name`: {exists, value (or undefined), loose (readable by group or other)}. */
export function envFileState(file, name) {
  let text;
  let mode;
  try {
    text = fs.readFileSync(file, "utf8");
    mode = fs.statSync(file).mode;
  } catch {
    return { exists: false, value: undefined, loose: false };
  }
  return { exists: true, value: parseEnvFile(text, name)?.trim(), loose: (mode & 0o044) !== 0 };
}

/** Set `name=value` in `file`: replace the first line that sets it (keeping its `export `), else append one line. */
export function upsertEnvLine(file, name, value) {
  let real = file;
  let text = "";
  let mode = 0o600;
  if (fs.existsSync(file)) {
    real = fs.realpathSync(file);
    text = fs.readFileSync(real, "utf8");
    mode = fs.statSync(real).mode & 0o777;
  }
  const lines = text.split(/(?<=\n)/);
  const re = new RegExp(`^(\\s*(?:export\\s+)?)${escapeRe(name)}\\s*=`);
  const at = lines.findIndex((l) => re.test(l));
  if (at >= 0) {
    const ending = /\r?\n$/.exec(lines[at])?.[0] ?? "";
    lines[at] = `${re.exec(lines[at])[1]}${name}=${value}${ending}`;
  } else {
    if (text && !text.endsWith("\n")) lines.push("\n");
    lines.push(`${name}=${value}\n`);
  }
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.recall-${process.pid}.tmp`);
  fs.writeFileSync(tmp, lines.join(""), { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, real);
}
