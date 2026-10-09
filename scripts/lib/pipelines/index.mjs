// Named pipelines. Every pipeline is {name, gate(entry, cfg) -> bool, run(ctx) -> {ranked: [{id, score, parts}]}}.
import { defaultPipeline } from "./default.mjs";
import { embeddingsPipeline } from "./embeddings.mjs";
import { rerankPipeline, codexPipeline } from "./rerank.mjs";
import { listwisePipeline } from "./default-listwise.mjs";
import { sessionsPipeline } from "./sessions.mjs";
import { composePipeline } from "./compose.mjs";
import { composeLeanPipeline } from "./compose-lean.mjs";

export const PIPELINES = Object.freeze({
  [embeddingsPipeline.name]: embeddingsPipeline,
  [defaultPipeline.name]: defaultPipeline,
  [rerankPipeline.name]: rerankPipeline,
  [codexPipeline.name]: codexPipeline,
  [listwisePipeline.name]: listwisePipeline,
  [sessionsPipeline.name]: sessionsPipeline,
  [composePipeline.name]: composePipeline,
  [composeLeanPipeline.name]: composeLeanPipeline,
});

export function getPipeline(name) {
  const p = PIPELINES[name];
  if (!p) throw new Error(`unknown pipeline ${JSON.stringify(name)}; available: ${Object.keys(PIPELINES).join(", ")}`);
  return p;
}
