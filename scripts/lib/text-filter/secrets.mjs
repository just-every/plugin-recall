// What never reaches the index: credential paths, secret-shaped spans, other people's addresses, long digit runs.

// Never opened, whatever a scan would find in it. A rollout under a secrets directory is not read to be excluded, it is not read.
const FORBIDDEN_PATH = /(^|\/)(secrets|\.ssh|\.gnupg|keychains?)(\/|$)|auth\.json$|\.credentials\.json$|(^|\/)\.env(\.|$)|token/i;

export function forbiddenPath(file) {
  return FORBIDDEN_PATH.test(String(file));
}

export const REDACTED = "[redacted]";

// Secrets in the BODY of a turn are redacted wherever they sit (a transcript is not a secrets directory). Redact, not drop: each shape is
// self-delimiting, so taking the span out removes the secret completely and leaves the sentence around it. A turn that is nothing but key
// material redacts down to the marker and is then dropped as `key-material`. A bare long hex run is deliberately NOT a secret here: git
// shas and digests are named on purpose; a hex run only becomes a secret when something calls it one (the labelled pattern below).
const SECRETS = [
  /\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // `sk-ant-...`, `sk-proj-...`, `sah_...`: modern keys break "16 unbroken alphanumerics after sk-" with their own hyphen.
  /\b(?:sk|pk|rk|sah)[-_](?:[A-Za-z0-9]{1,12}[-_]){0,3}[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN[^\n-]{0,40}-----[\s\S]*?(?:-----END[^\n-]{0,40}-----|$)/g,
  // A secret that arrives named rather than shaped: `api_key="..."`, `token: ...`. The label stays outside the span ("edit API token
  // [redacted]" still says what was being done) and the value has to carry a digit, because the other thing that follows a label in a
  // transcript is a word (a pasted `Password:` prompt followed by the next line of terminal output).
  /(?<=\b(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|bearer[_-]?token|secret|password|passwd|token)\b["'`\s]{0,3}[:=\s]\s*["'`]?)(?=[A-Za-z0-9_.-]*\d)[A-Za-z0-9_\-.]{16,}/gi,
];

/** Take every secret-shaped span out, and say how many went. */
export function redactSecrets(text) {
  let redacted = 0;
  let out = text;
  for (const pattern of SECRETS) {
    out = out.replace(pattern, () => { redacted += 1; return REDACTED; });
  }
  return { text: out, redacted };
}

/** An email address. */
export const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/** A run long enough to be a card, an account or a phone number with country code. */
export const LONG_DIGITS = /\d[\d\s-]{11,}\d/;
