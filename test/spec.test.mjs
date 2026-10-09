// The default pipeline's constants are the tuned winner's: every value of SPEC is checked against docs/x3-pipeline.json, the frozen spec of
// the measured pipeline, so the pipeline cannot drift from the measured one unnoticed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../scripts/lib/config.mjs";
import { GENERIC_TEXT, ITEM_CLIP } from "../scripts/lib/pipelines/questions.mjs";
import { SPEC } from "../scripts/lib/pipelines/spec.mjs";
import { STOP_HEAD, PROMPT_HEAD, TURN_CLIP, LATEST_CLIP } from "../scripts/lib/situations.mjs";

const x3 = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "x3-pipeline.json"), "utf8"));

test("SPEC equals the x3 winner's reference_spec and thresholds", () => {
  const r = x3.reference_spec;
  assert.equal(x3.name, "x3-rrf-pf-s");
  assert.equal(SPEC.embeddingTextClip, r.query.embedding_text_clip);
  assert.equal(SPEC.embeddingsTop, r.prefilter.embeddings_top);
  assert.equal(SPEC.bm25Top, r.prefilter.bm25_top);
  assert.equal(SPEC.sameThreadTop, r.prefilter.same_thread_top);
  assert.equal(SPEC.bm25DocClip, r.bm25.doc_clip);
  assert.equal(SPEC.itemClip, r.d_generic.item_clip);
  assert.equal(ITEM_CLIP, r.d_generic.item_clip);
  assert.equal(SPEC.packSize, r.d_generic.pack_size);
  assert.equal(SPEC.maxQuestionsPerRequest, r.d_generic.max_questions_per_request);
  assert.equal(SPEC.rrfK, r.fusion.k);
  assert.equal(SPEC.wEmbeddings, r.fusion.w_e);
  assert.equal(SPEC.wBm25, r.fusion.w_b);
  assert.equal(SPEC.wDGeneric, r.fusion.w_dg);
  assert.equal(r.fusion.use_same_thread_list, false, "the same-thread list selects the prefilter but is not fused");
  assert.equal(`${r.d_generic.quote_prefix}"x"\n${r.d_generic.question}`, `Past owner statement: "x"\n${GENERIC_TEXT}`);
  assert.equal(SPEC.injectPromptTau, x3.thresholds.prompt_time_injection.tau_dgeneric);
});

test("the situations are x3's layouts", () => {
  assert.ok(x3.prompt_time_query.situation.startsWith(PROMPT_HEAD));
  assert.equal(PROMPT_HEAD, "SITUATION (the owner's latest message, before the agent has acted):");
  assert.ok(x3.query.situation.format.startsWith(STOP_HEAD));
  assert.equal(TURN_CLIP, 500);
  assert.equal(LATEST_CLIP, 1500);
});

test("the prompt hook's defaults: the winner's prompt-time threshold 0.95, the default pipeline, v2's k of 3", () => {
  const c = loadConfig({});
  assert.equal(c.promptThreshold, x3.thresholds.prompt_time_injection.tau_dgeneric);
  assert.equal(c.pipeline, "default");
  assert.equal(c.k, 3);
});
