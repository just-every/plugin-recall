// Sessions: consecutive K24 chunks within each eligible conversation, clipped to L2400.
// Preserve the literal experiment's whole-node clipping: invisible members still belong to the node.
import { clip } from "../text.mjs";
import { ITEM_CLIP } from "./questions.mjs";

export const SESSION_SPEC = Object.freeze({ chunkSize: 24, nodeClip: 2400, topNodes: 32, packSize: 200 });
export const SESSION_PREDICATE = "Does this set of past owner statements include one that is important for handling the situation above correctly?";

export function makeSessionNodes(corpus, eligible, embRank) {
  const threads = new Map();
  for (const idx of eligible) {
    const tid = corpus.items[idx].session_id;
    if (!threads.has(tid)) threads.set(tid, []);
    threads.get(tid).push(idx);
  }
  const nodes = [];
  for (const [tid, indices] of threads) {
    for (let start = 0; start < indices.length; start += SESSION_SPEC.chunkSize) {
      const chunk = indices.slice(start, start + SESSION_SPEC.chunkSize);
      const lines = chunk.map((idx) => clip(corpus.items[idx].text, ITEM_CLIP));
      const visible = [];
      let offset = 0;
      for (let j = 0; j < chunk.length; j++) {
        if (offset < SESSION_SPEC.nodeClip) visible.push(chunk[j]);
        offset += lines[j].length + 1;
      }
      const text = clip(lines.join("\n"), SESSION_SPEC.nodeClip);
      nodes.push({
        id: `${tid}:${start}`, indices: chunk, visible, text,
        instructions: `Past owner statements from one earlier conversation:\n${text}\n${SESSION_PREDICATE}`,
        embRank: Math.min(...chunk.map((idx) => embRank.get(idx))),
      });
    }
  }
  return nodes;
}
