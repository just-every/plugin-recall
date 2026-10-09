// The statement card: what kind of thing the user said, where it applies, and what was going on when they said it.
//   {id, kind, scope, scope_repo, gist, model, at}   (+ gist_source, written by `recall enrich`, optional when reading, see below)
//   kind   rule | preference | decision | correction | question | status | other (a fact the agent cannot know, or a task request; shown as
//          "Fact/task"). Which kinds may be injected is the config's excludeKinds; only rules and preferences cross repos.
//   scope  global (working style, agent behaviour, communication, cross-project preference) | repo (specific to that project's code or
//          product) | unclear
//   gist   at most 20 words, written only from the context before the statement
//   scope_repo  the repo the statement was said in when scope is repo or unclear; null for global (and for a statement with no repo)
//   gist_source where the context came from: "transcript" (the statement's src line), "index" (a corpus statement matched to the live
//          index, then its transcript), "history" (the previous row of the same session in the typed-prompt log the statement came from,
//          no assistant reply), "prior-statement" (the previous owner statement of the same session, no assistant reply), "none" (nothing
//          before it)
export const KINDS = Object.freeze(["rule", "preference", "decision", "correction", "question", "status", "other"]);
/** The kinds a global statement may be injected with in a repo other than the one it was said in. */
export const CROSS_REPO_KINDS = Object.freeze(["rule", "preference"]);
/** How the injected card names a kind. */
export const KIND_LABELS = Object.freeze({ rule: "Rule", preference: "Preference", decision: "Decision", correction: "Correction", question: "Question", status: "Status", other: "Fact/task" });
export const SCOPES = Object.freeze(["global", "repo", "unclear"]);
export const GIST_SOURCES = Object.freeze(["transcript", "index", "history", "prior-statement", "none"]);
export const GIST_MAX_WORDS = 20;

export const wordCount = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;

/** What the model returns for one batch: one entry per numbered statement. */
export const BATCH_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "kind", "scope", "gist"],
        properties: {
          n: { type: "integer" },
          kind: { type: "string", enum: KINDS },
          scope: { type: "string", enum: SCOPES },
          gist: { type: "string" },
        },
      },
    },
  },
});

/** Problems with one model-written entry (a list; empty means valid). */
export function modelEntryProblems(e) {
  const out = [];
  if (!e || typeof e !== "object") return ["not an object"];
  if (!Number.isInteger(e.n)) out.push("n is not an integer");
  if (!KINDS.includes(e.kind)) out.push(`kind ${JSON.stringify(e.kind)} is not one of ${KINDS.join(", ")}`);
  if (!SCOPES.includes(e.scope)) out.push(`scope ${JSON.stringify(e.scope)} is not one of ${SCOPES.join(", ")}`);
  if (typeof e.gist !== "string" || !e.gist.trim()) out.push("gist is empty");
  else if (wordCount(e.gist) > GIST_MAX_WORDS) out.push(`gist has ${wordCount(e.gist)} words (at most ${GIST_MAX_WORDS})`);
  else if (/\n/.test(e.gist)) out.push("gist spans several lines");
  return out;
}

/** The card line for a statement and a valid model entry. */
export function buildCard({ statement, entry, model, at, gistSource }) {
  const problems = modelEntryProblems(entry);
  if (problems.length) throw new Error(`cannot build a card for ${statement.id}: ${problems.join("; ")}`);
  return {
    id: statement.id,
    kind: entry.kind,
    scope: entry.scope,
    scope_repo: entry.scope === "global" ? null : (statement.repo ?? null),
    gist: entry.gist.trim().replace(/\s+/g, " "),
    model,
    at,
    gist_source: gistSource,
  };
}

/** Problems with a stored card line (a list; empty means valid). */
export function cardProblems(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["not an object"];
  const out = [];
  if (typeof c.id !== "string" || !c.id) out.push("id is not a non-empty string");
  if (!KINDS.includes(c.kind)) out.push(`kind ${JSON.stringify(c.kind)} is not one of ${KINDS.join(", ")}`);
  if (!SCOPES.includes(c.scope)) out.push(`scope ${JSON.stringify(c.scope)} is not one of ${SCOPES.join(", ")}`);
  if (!(c.scope_repo === null || (typeof c.scope_repo === "string" && c.scope_repo))) out.push("scope_repo is not a repo name or null");
  else if (c.scope === "global" && c.scope_repo !== null) out.push("a global card has no scope_repo");
  if (typeof c.gist !== "string" || !c.gist.trim()) out.push("gist is empty");
  else if (wordCount(c.gist) > GIST_MAX_WORDS) out.push(`gist has ${wordCount(c.gist)} words (at most ${GIST_MAX_WORDS})`);
  if (typeof c.model !== "string" || !c.model) out.push("model is not a non-empty string");
  if (typeof c.at !== "string" || Number.isNaN(Date.parse(c.at))) out.push("at is not a timestamp");
  if (c.gist_source !== undefined && !GIST_SOURCES.includes(c.gist_source)) out.push(`gist_source ${JSON.stringify(c.gist_source)} is not one of ${GIST_SOURCES.join(", ")}`);
  const allowed = new Set(["id", "kind", "scope", "scope_repo", "gist", "model", "at", "gist_source"]);
  for (const k of Object.keys(c)) if (!allowed.has(k)) out.push(`unknown field ${JSON.stringify(k)}`);
  return out;
}
