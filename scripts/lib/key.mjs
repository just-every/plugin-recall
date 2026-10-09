// API keys from the environment, else from ~/.env. A key is never logged, never written by this module, never put in an error message.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function parseEnvFile(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] !== name) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value;
  }
  return undefined;
}

/** The value of `envName`: the environment wins, then `<home>/.env`. Throws (naming the variable and the file, never a value) when neither has it. */
export function getKey(envName, env = process.env, home = os.homedir()) {
  if (env[envName]) return env[envName];
  const file = path.join(home, ".env");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`${envName} is not in the environment and ${file} cannot be read (${e.code ?? e.message})`);
  }
  const key = parseEnvFile(text, envName);
  if (!key) throw new Error(`${envName} is not in the environment and not in ${file}`);
  return key;
}

export const getOpenAIKey = (env = process.env, home = os.homedir()) => getKey("OPENAI_API_KEY", env, home);
