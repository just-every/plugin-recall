// Tail a JSONL file by byte offset. Read-only. Each poll() delivers the complete lines appended since the last poll:
//   - a partial last line (a writer is mid-append) is carried until its newline arrives, and cut multi-byte characters never split;
//   - a file that shrank, was replaced (new inode) or whose first bytes changed was truncated or rewritten: onReset() fires first, then the
//     file is read again from byte 0, so the consumer can throw its state away and rebuild;
//   - a file that vanished and comes back is treated the same way; a file that does not exist yet is simply empty.
// Lines that are not valid JSON go to onBad(raw) and are skipped.
import fs from "node:fs";

const HEAD_BYTES = 64;
const CHUNK_BYTES = 4 * 1024 * 1024;

export function createTailer(file, { onLine, onBad = () => {}, onReset = () => {} }) {
  let offset = 0;
  let carry = Buffer.alloc(0);
  let ino = null;
  let head = null;

  function rewind() {
    offset = 0;
    carry = Buffer.alloc(0);
    ino = null;
    head = null;
  }

  function readRange(fd, start, length) {
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  }

  function deliver(bytes, context) {
    const data = carry.length ? Buffer.concat([carry, bytes]) : bytes;
    const last = data.lastIndexOf(0x0a);
    if (last < 0) { carry = Buffer.from(data); return 0; }
    carry = Buffer.from(data.subarray(last + 1));
    let n = 0;
    for (const raw of data.subarray(0, last).toString("utf8").split("\n")) {
      if (!raw.trim()) continue;
      let obj;
      try { obj = JSON.parse(raw); } catch { onBad(raw); continue; }
      onLine(obj, context);
      n++;
    }
    return n;
  }

  /** @returns {number} lines delivered by this poll */
  function poll(context = {}) {
    let st;
    try { st = fs.statSync(file); } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      if (ino !== null) { rewind(); onReset(); }
      return 0;
    }
    let fd;
    try { fd = fs.openSync(file, "r"); } catch (e) {
      if (e.code === "ENOENT") return 0;
      throw e;
    }
    try {
      if (ino !== null) {
        const replaced = st.ino !== ino || st.size < offset;
        const rewritten = !replaced && head && !readRange(fd, 0, head.length).equals(head);
        if (replaced || rewritten) { rewind(); onReset(); }
      }
      ino = st.ino;
      let delivered = 0;
      while (offset < st.size) {
        const bytes = readRange(fd, offset, Math.min(CHUNK_BYTES, st.size - offset));
        if (!bytes.length) break;
        if (offset === 0) head = Buffer.from(bytes.subarray(0, HEAD_BYTES));
        offset += bytes.length;
        delivered += deliver(bytes, context);
      }
      return delivered;
    } finally {
      fs.closeSync(fd);
    }
  }

  return { file, poll, rewind, get offset() { return offset; } };
}
