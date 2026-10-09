import { readFileSync } from 'node:fs';

export const COMPOSE_SPEC = JSON.parse(readFileSync(new URL('../../../docs/compose-pipelines.json', import.meta.url), 'utf8'));

/** Median imputation, standardization, then explicit missingness indicators. */
export function composeScore(raw, model) {
  const width = model.medians.length;
  let score = model.intercept[0] ?? 0;
  for (let j = 0; j < width; j++) {
    const value = raw[model.features[j]];
    const missing = value === null || value === undefined;
    if (!missing && !Number.isFinite(value)) throw new Error(`Non-finite compose feature ${model.features[j]}`);
    score += ((missing ? model.medians[j] : value) - model.means[j]) / model.scales[j] * model.coefficients[j];
    if (missing) score += model.coefficients[j + width];
  }
  return score;
}

export function inverseLogRank(rank) {
  return rank === null || rank === undefined ? null : 1 / Math.log2(rank + 1);
}

/** Blend only the head; stable ties retain the linear order, as in the reference model. */
export function blendCompose(rows, probabilities, weight) {
  if (!rows.length) return [];
  const max = Math.max(...rows.map(row => row.linear));
  const exp = rows.map(row => Math.exp(row.linear - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return rows.map((row, index) => {
    const p = probabilities.get(row.id);
    if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`Missing or invalid listwise probability for ${row.id}`);
    return { ...row, listwise: p, blend: weight * p + (1 - weight) * exp[index] / sum };
  }).sort((a, b) => b.blend - a.blend);
}
