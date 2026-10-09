// Child process for the concurrency tests: `node writer.mjs '<json spec>'`. Prints one JSON result line on stdout.
import fs from "node:fs";
import path from "node:path";
import { createLedger, CapExceededError } from "../../scripts/lib/ledger.mjs";
import { withLockSync } from "../../scripts/lib/lock.mjs";
import { createStore } from "../../scripts/lib/store.mjs";
import { createTurnLog } from "../../scripts/lib/turn-log.mjs";
import { logCapSilence } from "../../scripts/lib/cap-guard.mjs";

const spec = JSON.parse(process.argv[2]);
const out = {};

if (spec.mode === "statements") {
  const store = createStore(spec.dir);
  for (let i = 0; i < spec.batches; i++) {
    const rows = Array.from({ length: spec.rowsPerBatch }, (_, j) => ({ id: `w${spec.worker}-b${i}-r${j}`, text: `statement ${spec.worker}/${i}/${j} ${"x".repeat(spec.pad)}`, ts: "2026-09-01T00:00:00Z" }));
    store.appendStatements(rows);
  }
  out.appended = spec.batches * spec.rowsPerBatch;
} else if (spec.mode === "ledger") {
  const ledger = createLedger({ dir: spec.dir, dailyCapUsd: spec.capUsd });
  let ok = 0;
  let refused = 0;
  for (let i = 0; i < spec.attempts; i++) {
    try {
      const r = ledger.reserve(spec.usd);
      try {
        await new Promise((resolve) => setTimeout(resolve, spec.holdMs ?? 5));
        ledger.record({ endpoint: "/x", inputTokens: 1, costUsd: spec.usd });
        ok++;
      } finally {
        r.release();
      }
    } catch (e) {
      if (!(e instanceof CapExceededError)) throw e;
      refused++;
    }
  }
  Object.assign(out, { ok, refused });
} else if (spec.mode === "counter") {
  const file = path.join(spec.dir, "counter.txt");
  for (let i = 0; i < spec.times; i++) {
    withLockSync(path.join(spec.dir, "locks", "counter.lock"), () => {
      const n = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
      fs.writeFileSync(file, String(n + 1));
    }, { timeoutMs: 20_000 });
  }
} else if (spec.mode === "turnlog") {
  const log = createTurnLog(spec.dir);
  for (let i = 0; i < spec.lines; i++) log.write({ event: "prompt", outcome: "injected", worker: spec.worker, i, context: "c".repeat(spec.pad) });
} else if (spec.mode === "capwarn") {
  const log = createTurnLog(spec.dir);
  for (let i = 0; i < spec.lines; i++) logCapSilence({ log, base: { event: "prompt", worker: spec.worker }, dataDir: spec.dir, cap: { scope: "daily", capUsd: 1, spentUsd: 1 }, now: () => new Date(spec.now) });
} else {
  throw new Error(`unknown mode ${spec.mode}`);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
