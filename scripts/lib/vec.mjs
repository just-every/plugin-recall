export const DIM = 1536; // text-embedding-3-small

/** text-embedding-3-small vectors are unit length, so dot == cosine; the dot is all retrieval needs. */
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
}

export function toF32(vector) {
  if (vector.length !== DIM) throw new Error(`embedding has ${vector.length} dimensions, expected ${DIM}`);
  return Float32Array.from(vector);
}
