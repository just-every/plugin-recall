// What the first index will cost, from a dry-run scan (indexer.mjs, dryRun) and the price list in ledger.mjs.
import { costUsd } from "../lib/ledger.mjs";

/** About four characters to a token for prose. The ledger records the real usage; this is only for the estimate shown before consent. */
export const CHARS_PER_TOKEN = 4;
/** What one prompt costs on the Decisions API, about: roughly 200 narrow questions, measured on real turns at about $0.004. */
export const DECISIONS_USD_PER_PROMPT = 0.004;
/** Statements per card-writer call (cards/enrich.mjs batches of about 40). */
export const CARD_BATCH = 40;

/**
 * @param {{statements: number, toEmbed: {texts: number, chars: number}}} scan the dry-run report
 * @returns {{statements: number, texts: number, tokens: number, embeddingUsd: number, cardCalls: number, promptUsd: number, promptsPerDollar: number}}
 */
export function estimateFirstIndex(scan) {
  const tokens = Math.ceil(scan.toEmbed.chars / CHARS_PER_TOKEN);
  return {
    statements: scan.statements,
    texts: scan.toEmbed.texts,
    tokens,
    embeddingUsd: costUsd("text-embedding-3-small", tokens),
    cardCalls: Math.ceil(scan.statements / CARD_BATCH),
    promptUsd: DECISIONS_USD_PER_PROMPT,
    promptsPerDollar: Math.floor(1 / DECISIONS_USD_PER_PROMPT),
  };
}

/** Dollars for a person: "$0.004", "$0.014", "$1.25"; amounts under a hundredth of a cent say so. */
export const usd = (n) => (n === 0 ? "$0" : n < 0.0001 ? "less than $0.0001" : n < 0.01 ? `$${Number(n.toPrecision(2))}` : `$${n.toFixed(2)}`);

/** A cap as set, in plain dollars: "$1", "$2.5", "$0.0000001" (never exponent notation). */
export const dollars = (n) => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 10, useGrouping: false })}`;
