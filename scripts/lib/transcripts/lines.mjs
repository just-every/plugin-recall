// Streaming line reader with byte offsets. A Codex rollout reaches hundreds of MB with single lines of 8-11 MB, so nothing here slurps
// a file: chunks are split on newlines at the Buffer level and a line is handed over as a Buffer slice, so a caller can reject it with
// Buffer.indexOf before paying to decode it. Only complete (newline-terminated) lines are consumed; a line still being written is left
// for the next pass, and the returned offset/lines say exactly how far the scan got.
import fs from "node:fs";
import zlib from "node:zlib";

const NL = 10;

/**
 * @param {string} file
 * @param {{offset?: number, lineBase?: number, onLine: (line: Buffer, lineNo: number) => void|false, zst?: boolean}} opts
 *   lineBase is the number of lines already consumed before `offset` (so lineNo is 1-based and absolute). `onLine` returning `false`
 *   stops the scan after that line (the reader needs no more of the file).
 * @returns {Promise<{offset: number, lines: number}>} bytes consumed (end of the last complete line) and absolute line count
 */
export async function scanLines(file, { offset = 0, lineBase = 0, onLine, zst = false }) {
  const raw = fs.createReadStream(file, { start: zst ? 0 : offset, highWaterMark: 4 * 1024 * 1024 });
  const stream = zst ? raw.pipe(zlib.createZstdDecompress()) : raw;
  let pending = null; // Buffer holding the start of an unfinished line
  let consumed = zst ? 0 : offset;
  let lineNo = zst ? 0 : lineBase;
  for await (const chunk of stream) {
    let buf = pending ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(NL, start);
      if (nl < 0) break;
      lineNo += 1;
      const more = onLine(buf.subarray(start, nl), lineNo);
      consumed += nl - start + 1;
      start = nl + 1;
      if (more === false) {
        stream.destroy();
        raw.destroy();
        return { offset: consumed, lines: lineNo };
      }
    }
    pending = start < buf.length ? buf.subarray(start) : null;
    buf = null;
  }
  return { offset: consumed, lines: lineNo };
}

/** The first line of a file (up to `maxBytes`), as a Buffer, or null for an empty file. Used for a Codex rollout's session_meta. */
export async function firstLine(file, { zst = false, maxBytes = 4 * 1024 * 1024 } = {}) {
  const raw = fs.createReadStream(file, { highWaterMark: 256 * 1024 });
  const stream = zst ? raw.pipe(zlib.createZstdDecompress()) : raw;
  let acc = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      acc = Buffer.concat([acc, chunk]);
      const nl = acc.indexOf(NL);
      if (nl >= 0) return acc.subarray(0, nl);
      if (acc.length > maxBytes) throw new Error(`${file}: first line exceeds ${maxBytes} bytes`);
    }
  } finally {
    stream.destroy();
    raw.destroy();
  }
  return acc.length ? acc : null;
}
