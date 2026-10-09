import { buildCorpus } from "./corpus.mjs";

/** The searchable corpus from the on-disk index. Statements still waiting for an embedding are reported, never silently ignored. */
export function loadIndexedCorpus(store) {
  const statements = store.loadStatements();
  const corpus = buildCorpus({ statements, embeddings: store.loadEmbeddings() });
  return { corpus, statements: statements.length, withoutEmbedding: corpus.withoutEmbedding.length };
}
