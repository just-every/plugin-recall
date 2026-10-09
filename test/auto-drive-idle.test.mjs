// The end of an Every Code Auto Drive run in a typed-prompt log of 2025 (transcripts/auto-drive.mjs): the log never marks it, but a person who
// comes back to a session does so after an idle gap. A run's rows are submissions until a row comes AUTO_DRIVE_IDLE_MS or more after its
// session's previous row; that row and the session's later rows are the person's, until the session's next /auto row starts another run. A
// coordinator prompt that follows a long agent turn (hours, but under the gap) is still a submission. Synthetic rows, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { runIndex } from "../scripts/lib/indexer.mjs";
import { createStore } from "../scripts/lib/store.mjs";
import { AUTO_DRIVE_IDLE_MS, autoDriveLines } from "../scripts/lib/transcripts/auto-drive.mjs";
import { historyLine } from "../scripts/lib/transcripts/history.mjs";
import { tmpDir } from "./helpers.mjs";

const RUN = "0190e000-ad00-7000-8000-00000000ad11";
const T0 = Date.parse("2025-09-10T08:00:00.000Z") / 1000;
const H = 3600;
const ROWS = [
  { session_id: RUN, ts: T0, text: "/auto make the invoice export stream its rows" },
  { session_id: RUN, ts: T0 + 40, text: "Primary goal: make the invoice export stream its rows. Plan first, then implement in small steps." },
  { session_id: RUN, ts: T0 + 40 + 2 * H + 50 * 60, text: "Focus files: src/export/stream.ts. Add a regression test for the ten thousand row case after the long turn." },
  { session_id: RUN, ts: T0 + 40 + 2 * H + 50 * 60 + 5 * H, text: "Back after lunch: the export looks right now, please commit what you have" },
  { session_id: RUN, ts: T0 + 40 + 2 * H + 50 * 60 + 5 * H + 120, text: "And then write a short note in the changelog about the streaming export" },
  { session_id: RUN, ts: T0 + 12 * H, text: "/auto tidy the ledger module and keep its public functions unchanged" },
  { session_id: RUN, ts: T0 + 12 * H + 30, text: "Primary goal: tidy the ledger module. Orient yourself to this repository first, then plan." },
];
const parsed = (rows) => rows.map((r, i) => ({ ...historyLine(JSON.stringify(r)), line: i + 1 }));
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

test("an idle gap of AUTO_DRIVE_IDLE_MS ends a run: the row after it and the session's later rows are typed, until the next /auto", () => {
  assert.equal(AUTO_DRIVE_IDLE_MS, 3 * 3_600_000);
  assert.deepEqual([...autoDriveLines(parsed(ROWS))], [2, 3, 7], "2 h 50 min after the previous row is still the run; 5 h after it is not");
});

test("index: the owner's rows after the gap are statements, the coordinator's are not; a later pass keeps the run's last row time", async () => {
  const root = tmpDir("recall-auto-idle");
  const home = path.join(root, ".code");
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "history.jsonl");
  fs.writeFileSync(file, jsonl(ROWS.slice(0, 2)));
  const config = loadConfig({ RECALL_DATA: path.join(root, "data") });
  const store = createStore(config.dataDir);
  const run = () => runIndex({ config, store, homeDir: root, env: {}, embed: false, now: () => Date.parse("2026-10-01T00:00:00.000Z") });
  await run();
  assert.deepEqual(store.loadState().files[file].autoDrive, { [RUN]: (T0 + 40) * 1000 }, "the run is on, and the state says since when");
  fs.appendFileSync(file, jsonl(ROWS.slice(2)));
  const again = await run();
  assert.equal(again.excluded["auto-drive"], 2);
  assert.deepEqual(store.loadStatements().map((s) => s.text), [
    "make the invoice export stream its rows",
    "Back after lunch: the export looks right now, please commit what you have",
    "And then write a short note in the changelog about the streaming export",
    "tidy the ledger module and keep its public functions unchanged",
  ]);
});

test("a slash command after the idle gap is kept but does not end the run: the coordinator's next prompts are still submissions", () => {
  const S = "0190e000-ad00-7000-8000-00000000ad12";
  const rows = [
    { session_id: S, ts: T0, text: "/auto add retry with backoff to the coordinator's model requests" },
    { session_id: S, ts: T0 + 60, text: "Implement retry with backoff for transient stream errors. Plan first, then execute." },
    { session_id: S, ts: T0 + 60 + 4 * H, text: "/review latest commit" },
    { session_id: S, ts: T0 + 60 + 4 * H + 9 * 60, text: "Plan quick validation for the latest changes, then run the review again." },
    { session_id: S, ts: T0 + 60 + 4 * H + 20 * 60, text: "Let us add a non-interactive harness that simulates stream disconnects. Plan first." },
    { session_id: S, ts: T0 + 60 + 8 * H, text: "Please commit what you have and push the branch" },
    { session_id: S, ts: T0 + 60 + 8 * H + 60, text: "And open a pull request for it as well" },
  ];
  assert.deepEqual([...autoDriveLines(parsed(rows))], [2, 4, 5], "the /review row is the person's; the run goes on after it until a typed row after a gap");
});

const at = (S, rows) => rows.map(([s, text]) => ({ session_id: S, ts: T0 + s, text }));

test("a typed row after the gap ends the run for good: a slash command after it does not start it again, the next typed row is the person's", () => {
  const S = "0190e000-ad00-7000-8000-00000000ad13";
  const rows = at(S, [
    [0, "/auto add a progress bar to the invoice export"],
    [60, "Implement the progress bar in src/export/progress.ts. Plan first, then execute."],
    [5 * H, "The bar flickers on every row, slow its refresh down to once a second"],
    [6 * H, "/review"],
    [6 * H + 60, "Now also show the row count next to the bar"],
  ]);
  assert.deepEqual([...autoDriveLines(parsed(rows))], [2], "the run ended at the typed row after the gap; nothing after it is a submission");
});

test("a second /auto while a run is on starts the run again from its own time: a coordinator prompt a minute after it is a submission", () => {
  const S = "0190e000-ad00-7000-8000-00000000ad14";
  const rows = at(S, [
    [0, "/auto make the ledger export stream its rows"],
    [60, "Primary goal: make the ledger export stream its rows. Plan first, then implement in small steps."],
    [5 * H, "/auto now make the invoice export stream its rows too"],
    [5 * H + 60, "Primary goal: make the invoice export stream its rows. Orient yourself to this repository first, then plan."],
  ]);
  assert.deepEqual([...autoDriveLines(parsed(rows))], [2, 4], "the gap is measured from the second /auto row, not from the run's earlier rows");
});

test("a row inside a run that carries an attached image is the person's (a coordinator never attaches one), and the run goes on after it", () => {
  const S = "0190e000-ad00-7000-8000-00000000ad15";
  const rows = at(S, [
    [0, "/auto fix the overlapping footer in the settings view"],
    [60, "Focus files: src/settings/footer.tsx. Reproduce the overlap first, then fix it."],
    [4 * 60, "[image: Screenshot 2025-09-10 at 8.04.00 am.png] Still overlapping, the footer sits two rows too high"],
    [5 * 60, "Measure the footer height in the layout pass and add a regression test for it."],
    [9 * 60, "Not quite! [image: Screenshot 2025-09-10 at 8.09.00 am.png] Now it is one row too low"],
    [10 * 60, "Adjust the offset by one row and rerun the snapshot tests."],
  ]);
  assert.deepEqual([...autoDriveLines(parsed(rows))], [2, 4, 6]);
});
