// Turns a host or the fleet writes that are not the person's, found on real homes after 0.4.0 began reading typed-prompt logs and Every Code
// rollouts: Every Code's auto-resolve request (bare in its log, behind its preface in a rollout) while the owner's own wordings of the same
// question stay; and a turn that is nothing but Every Code's image placeholder. (The fleet profile's wake relay is in text-filter.test.mjs.)
// Synthetic text, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { judgeOwnerText } from "../scripts/lib/owner-filter.mjs";

const DEFAULTS = { minText: 20 };
const FLEET = { minText: 20, filterProfiles: ["fleet"], ownerNames: ["sam"] };
const CANNED = "Is this a real issue introduced by our changes? If so, please fix and resolve all similar issues.";

test("Every Code auto-resolve: the canned request is harness text in a log row and in a rollout turn (behind its preface or before it)", () => {
  const turns = [
    CANNED,
    `${CANNED}\n\nYou are continuing an automated /review resolution loop. Findings:\n- [P1] totals off by one`,
    `You are continuing an automated /review resolution loop. Review the listed findings and fix them.\n\nFindings:\n- [P2] a stale cache\n${CANNED}`,
  ];
  for (const raw of turns) {
    assert.equal(judgeOwnerText(raw, DEFAULTS).reason, "harness");
    // the fleet profile drops the preface form first, as a brief handed to the reader ("You are continuing ...")
    assert.equal(judgeOwnerText(raw, FLEET).text, undefined);
  }
});

test("the owner's own wordings of the review question are kept: only the exact canned sentence is the harness's", () => {
  for (const own of [
    `${CANNED.slice(0, -1)} in the importer as well`,
    "Is this a real issue introduced by our changes? If so, fix it and add a test for the empty month.",
    "Is this a real issue or a false alarm from the reviewer? Check before changing anything",
  ]) assert.equal(judgeOwnerText(own, DEFAULTS).text, own);
});

test("a turn that is only Every Code's image placeholder holds no words; an image with words is kept whole", () => {
  assert.equal(judgeOwnerText("[image: Screenshot 2026-02-03 at 9.15.02 am.png]", DEFAULTS).reason, "image-only");
  assert.equal(judgeOwnerText("[image: shot-1.png] [image: shot-2.png]", DEFAULTS).reason, "image-only");
  const withWords = "[image: Screenshot 2026-02-03 at 9.15.02 am.png] The send button sits one row too low on narrow terminals";
  assert.equal(judgeOwnerText(withWords, DEFAULTS).text, withWords);
});
