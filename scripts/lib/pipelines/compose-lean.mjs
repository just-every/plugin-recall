// P6 retains the sessions, embedding and BM25 channels of the composition model and their six features.
import { makeComposePipeline } from "./compose.mjs";

export const composeLeanPipeline = makeComposePipeline("compose-lean", true);
