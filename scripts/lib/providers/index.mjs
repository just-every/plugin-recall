// The one place a model provider is declared. Each entry names its key (envName), where to get one (keyUrl), how a key looks
// (looksLikeKey, shapeHint), how to check it for free (validate, validateNote) and how to prove access to a paid endpoint once (access). Setup and doctor
// iterate requiredProviders(); adding a provider is one entry file, one line in PROVIDERS and the roles it serves.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnvFile } from "../key.mjs";
import { openai } from "./openai.mjs";

export const PROVIDERS = Object.freeze([openai]);

/** The roles Recall needs a provider for: embedding statements and judging which matter (the Decisions API). */
export const ROLES = Object.freeze(["embeddings", "judge"]);

/** The providers this configuration needs, once each, in role order. Today OpenAI serves both roles, so no setting chooses one yet. */
export function requiredProviders(config) {
  const out = [];
  for (const role of ROLES) {
    const p = PROVIDERS.find((x) => x.roles.includes(role));
    if (!p) throw new Error(`no provider serves the ${role} role`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The provider's key and where it was found: the environment wins, then ~/.env (`export`, quotes and CRLF line ends allowed).
 * @returns {{key: string, source: "the environment"|"~/.env"} | null}
 */
export function findKey(provider, { env = process.env, homeDir }) {
  const fromEnv = env[provider.envName]?.trim();
  if (fromEnv) return { key: fromEnv, source: "the environment" };
  let text;
  try { text = fs.readFileSync(path.join(homeDir, ".env"), "utf8"); } catch { return null; }
  const fromFile = parseEnvFile(text, provider.envName)?.trim();
  return fromFile ? { key: fromFile, source: "~/.env" } : null;
}

/** A key as it may be shown: the first 3 characters, "...", the last 4 (only the first 3 for a key too short to hide anything). */
export const maskKey = (key) => (key.length >= 12 ? `${key.slice(0, 3)}...${key.slice(-4)}` : `${key.slice(0, 3)}...`);

/** What the records keep instead of a key: the first 16 hex characters of its sha256. */
export const keyFingerprint = (key) => createHash("sha256").update(key).digest("hex").slice(0, 16);
