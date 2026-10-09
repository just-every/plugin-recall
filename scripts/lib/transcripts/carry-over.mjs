// Exact text/UUID carry-over recorded by the host, independent of generated summary prose.
import { buildStatement } from '../indexer.mjs';
import { norm, sha256 } from '../text.mjs';

export const visibilityTextHash = (text) => sha256(norm(text));

export function compactionCarryOver(record, host, config) {
  if (host === 'claude') {
    return { textHashes: [], uuids: record.compactMetadata?.preservedMessages?.allUuids ?? [] };
  }
  const hashes = new Set();
  for (const item of record.payload?.replacement_history ?? []) {
    if (item.type !== 'message' || item.role !== 'user') continue;
    const raw = (item.content ?? []).filter((b) => b.type === 'input_text' || b.type === 'text').map((b) => b.text).join('\n');
    hashes.add(visibilityTextHash(raw));
    // Apply the same envelope removal as indexing, so the indexed text matches a carried user message.
    const { statement } = buildStatement({ raw, ts: record.timestamp, host }, config);
    if (statement) hashes.add(visibilityTextHash(statement.text));
  }
  return { textHashes: [...hashes], uuids: [] };
}

export function carriedStatementIds(turns, carryOver) {
  const hashes = new Set(carryOver?.textHashes), uuids = new Set(carryOver?.uuids);
  return new Set(turns.filter(({ statement, uuid }) => hashes.has(visibilityTextHash(statement.text)) || (uuid && uuids.has(uuid))).map(({ statement }) => statement.id));
}
