# Evidence

What was measured, how, and what it does not show. Everything here was measured on one developer's history (about 12,000 typed messages across Claude Code and Codex), by the people who built Recall; treat the absolute rates as rough and the contrasts between arms as the sturdier result. No fresh-data study of the current defaults end to end has been run.

## The studies behind the current defaults

Two studies of the second release's behaviour (typed cards, directive-only), both on that one history. The cards and the judges came from a GPT model through `codex exec` because no Claude account was usable, so the card writer's own kind and scope calls (Haiku) were not tested.

**Study A: 85 correction moments, the agent's reply generated twice per arm and judged blind.** Memory beats no memory: the share of replies that avoid the mistake the user later corrected was 0.291 with no memory, 0.362 with the first release and 0.351 with the second (second minus no memory +0.060, 95% interval +0.025 to +0.100; second minus first -0.010, -0.060 to +0.043, so equal within noise). The second release injected 40% fewer items and none from another repo that was not global.

- The context-aware query is the one component that finds needles: 27% of cases had a needle in the injection against 14% without it.
- Directive-only forfeits reachable needles: 58 of 145 needles were cards of kind `other` (task requests such as "keep monitoring this"), and only 13 of the first release's 31 needle hits could still be injected.
- The scope filter cost nothing (20 against 23 hit cases without it) and removed 33 off-repo items.
- The gist in the judge's question gave no benefit (26 against 23 hit cases, same cost).
- The long situation raised Decisions refusals: 186 in 44 of 85 cases against 7 without the context. None of the 145 needles was refused.

**Study B: 160 real messages in normal flow, first release against second, judged in hindsight by a model blind to the arm.** The second release was quieter, not better at finding value. About 2.0 cards per message against 3.9 quotes; irrelevant notes fell from 19% to 8 to 9%, misleading ones from 38% to 28 to 29%; but the share of messages where Recall said at least one useful thing fell from 21% to 11% (difference -9.4 points, 95% interval -16.9 to -1.9, after repairing repo identity).

- 24 of the first release's 43 useful notes were facts (where files are, which host or endpoint, how a job was run) that directive-only cannot say. At the start of a session (first 3 messages) the first release had value in 28% of messages and the second in 5%.
- The value is local: a note said in the same repo was useful 13% of the time and irrelevant 6%; a note from another repo was useful 3 to 4%.
- The 234 `global` notes were 70% of the second release's output and 5% useful. They were dominated by hubs: ten statements were 31% of the output (102 of 333 notes) and none was useful; the worst went into 15 of 160 messages. Global corrections were 3% useful.
- Repo identity: 36 messages and 4,281 statements had no repo only because their directory is gone; renamed or sibling repos cost 8 of the first release's useful notes under the exact-name scope rule.
- Policies simulated on the judged notes (dropped notes not replaced): dropping any statement said into 6 or more of the 160 messages cut notes by a third (2.08 to 1.41 per message) and messages with a misleading note from 47% to 35% at a cost of about one point of value (11% to 10%); same-repo only was 0.86 notes per message, 56% silent, value 8%; raising the gate to 0.99 halved the notes and cut value from 11% to 4%.
- Caveats: 160 messages, one person, one judge family that also wrote the cards (kappa 0.79 to 0.89 on notes judged twice; a manual read of 30 "useful" calls found 17 clear, 6 borderline, 7 weak).

The current defaults follow from these: same repo first with a tight global channel (kinds rule and preference only), facts and task requests let through, hubs suppressed across sessions, repo identity repaired and aliasable, the gate left at 0.95, no skip rules, the judge's question without the gist, and a shorter, cleaned situation.

**Refusals before and after cleaning the situation (20 correction cases that have an assistant reply in their context).** Refused questions per question asked: long situation 48 of 2,779 (1.73%, 5 cases with a refusal); the current eligibility with the old 800-character reply 41 of 3,130 (1.31%); as shipped (prose only, 400 characters) 8 of 3,128 (0.26%, 5 cases). Cleaning and shortening the reply cut refusals by about 80% on this sample. Needle hits on the same cases did not change (6 of 38 needles injected, before and after); 20 cases cannot show a difference in value.

## Precision rules (an audit of the live hook, then an offline test of four rules)

A live audit of what the hook injected found 38% of the cards misleading. An offline evaluation then replayed 274 labelled messages (the live firings, the 160 normal-flow messages of study B and the 85 correction moments of study A, with their judged labels) with the eligibility rules applied to the ranked candidates and the next eligible candidate filling each slot. Four rules, together, cut the messages carrying a misleading card by 10.2 points (pooled; 95% interval -15.0 to -5.5) and left the share of messages with a useful card unchanged (-0.7 points; -4.4 to +2.6). They are in the plugin as defaults (README, "Precision rules").

- RG, a placeholder gist (`gist_source: "none"`): the cards of session-opening messages, 65% of them misleading.
- RU, the statement cites a URL, a local port or a file path.
- R5, a statement from another repo of 300 characters or more.
- R4v, a rule or preference of 500 characters or more.

Caveats: the labels are a model judge's, the rules were found on these same messages, and in the plugin they act before ranking, not on the ranked list as in the evaluation, so the judge ranks a history without the statements they keep out. The plugin's check of the four rules agrees with the evaluation's definitions on every one of the 1,958 cards of the three datasets (0 differences).

## Retrieval measurements (the pipeline is unchanged since)

**Confirmatory run on a fresh frozen holdout: candidate recall at stop time.** One run specified before it ran, on a holdout built after the pipelines had been chosen (118 stop cases). Recall@5 is the case hit rate; 95% intervals are case-bootstrap percentile intervals (2,000 resamples, paired where a difference is shown); a crashed case counts as a miss. Two golds: **original** (labels pooled from replies; under 2 needles per case, and blind to any statement outside the pooled candidates) and **fully judged** (original plus every top-5 item of every run, judged by one blind labeller; a lower bound).

| Stop-time situations (118 cases) | Original gold R@5 [95% CI] | Fully judged R@5 [95% CI] | vs `default` [95% CI] |
|---|---|---|---|
| `embeddings` | 0.059 [0.017, 0.102] | 0.195 [0.127, 0.271] | -0.136 [-0.229, -0.051] |
| `default` | 0.093 [0.042, 0.153] | 0.331 [0.254, 0.415] | n/a |
| `sessions` (25 crashes) | 0.076 [0.034, 0.127] | 0.271 [0.195, 0.347] | -0.059 [-0.153, +0.025] |
| `default+codex` | 0.144 [0.085, 0.212] | 0.331 [0.246, 0.415] | 0.000 [-0.076, +0.076] |
| `default+listwise` (1 crash) | 0.144 [0.085, 0.212] | 0.347 [0.263, 0.432] | +0.017 [-0.068, +0.102] |
| `compose-lean` | 0.161 [0.102, 0.229] | 0.458 [0.373, 0.551] | +0.127 [+0.034, +0.221] |
| `compose` (48 of 118 cases ran) | 0.167 [0.063, 0.271] | 0.563 [0.438, 0.708] | +0.146 [0.000, +0.313] |

By the pre-registered rules, the usefulness rule (`default` beats `embeddings` by at least +0.05 with the interval's lower bound above -0.05, original gold) **failed**: +0.034 [-0.009, +0.076]. `compose-lean` beat `default` on the fully judged gold by +0.127 but missed the synchronous cost bar ($0.0317 per query cold against $0.03), so `default` stays the hook's pipeline; `compose` and `compose-lean` remain as named pipelines for `recall eval`. This measured stop-time candidate recall, a situation the current hook does not use; prompt-time recall on fresh data was not measured.

**An earlier fresh holdout (93 verified cases, 130 needles, 2,673 statements).** `default` against `embeddings` recall@5: stop 0.065 (6 of 93) against 0.032, prompt 0.086 (8 of 93) against 0.054; the differences (+0.032 each, intervals -0.011 to +0.086 and -0.011 to +0.075) are inside the noise and short of the +0.05 rule. A follow-up found that excluding the whole live session removes the pipeline's strongest cases (it hit 33 of 45 on own-session cases against 18 of 45 for embeddings; the cross-session gain was only about +0.04) and that the holdout omitted compressed Codex rollouts. Compaction-aware exclusion (see [hosts.md](hosts.md) section 5) addresses the visibility mismatch; it has not been measured on a fresh holdout.

**Development set (104 verified correction cases the pipeline was selected on, so optimistic by construction).**

| Mode | Pipeline | recall@5 | recall@10 | MRR |
|---|---|---|---|---|
| stop (104 cases) | `default` | 0.452 (47/104) | 0.481 | 0.284 |
| stop | `embeddings` | 0.260 (27/104) | 0.317 | 0.183 |
| prompt (85 cases) | `default` | 0.294 (25/85) | 0.341 | 0.241 |
| prompt | `embeddings` | 0.212 (18/85) | 0.259 | 0.145 |

The pipeline was the maximum of about 40 on these cases; its own estimate for fresh data was 0.40 to 0.45, which did not hold. The prompt-time fusion constant is k = 10 (the value its prompt-time cross-validation refit), k = 60 at stop time. Saturation (about 23 statements per query score 0.99 or more) is why the judge alone is a weak ranker; fusion with embeddings and BM25, and breaking the judge's ties by embedding rank, make the order useful. A verified needle is inside the prefilter for 79 of 104 cases, so about a quarter of cases cannot be found by this design.

**Injection gate (development set, first release).** At tau 0.95, 23 of 85 prompt cases had a needle injected, 4.24 statements per case, precision lower bound 0.083: the gate barely discriminates (it keeps nearly every hit and nearly every injection). On 22 real prompts the first release injected on 20, 3.9 statements on average. The current defaults (typed cards, k 3, same-repo scope, hubs, no repeats) narrow this; how much has not been measured end to end.

## Latency and cost

Measured with the real hook script as a subprocess against a 12,223-statement index on 22 real turns, one at a time, `RECALL_NO_CACHE=1` (every request goes to the API), first release: p50 0.95 s, p90 1.04 s, max 1.21 s; cost per turn $0.0041. Wall time is the whole process: node start, index and embedding-store load (about 100 MB), query embedding, Decisions requests, output. Offline replay cost $0.0042 per query. The current release adds a read of the last 4 MiB of the transcript and the cards file to each turn and asks the judge about statements with longer lines; neither effect on latency or cost has been measured. Cold per-query cost and latency of the other pipelines (10 samples each): `sessions` $0.025, p50 1.3 s; `default+codex` p50 10 s; `compose` $0.055, p50 10.7 s; `compose-lean` $0.032, p50 1.5 s.

Indexing a history of about 14,000 transcript files and 12,600 statements took 15 minutes and $0.012 of embeddings; later runs are incremental.

## The card writer

Measured on random statements from the same history, with no gold labels. Extended thinking off: a batch of 40 took 21 s against 137 s with it. 400 statements took 11 calls and about 5 to 6 minutes on a loaded machine, most of it spent reading transcripts for context; expect the full index of 12,000 statements to be about 300 calls and half an hour to an hour. All 400 got a valid card (two gists of 21 words were asked again). On the 400: 17% directives (31 corrections, 30 decisions, 4 rules, 3 preferences), 20% questions, 6% status, 56% `other`; scope `repo` for 90%, `global` 5%, `unclear` 5%. The writer is conservative about `global`, so **the cross-repo channel (global rules and preferences) stays small**, which is the point of the scope rule and its price. A bare approval is `other`, which cut directives from 27% to 17% on the same 400. Not measured: the accuracy of kind and scope against any labels, and whether the gists help the judge.

## Limits

- One person, one corpus, selection on the evaluation set: the development numbers are optimistic by construction, and the fresh holdouts measured far lower.
- The current defaults are unevaluated end to end. The card writer has no gold labels, its gists can be loose, and cards are written once and not refreshed. The filters trade recall for noise: a statement without a card, a repo-scoped statement said in another repo, a correction or decision from another repo, and a global rule the writer scoped to its repo are never injected, and nothing measures how often that loses a statement you needed.
- Repo identity for a deleted directory is a path rule: right for `~/www/<org>/<repo>` and worktree layouts, wrong for a cwd that names an org, a monorepo subdirectory outside those layouts, or a repo renamed after the session (that is what `repoAliases` is for).
- Whether a session is automated is inferred from host signals, not declared by the payload. A session the plugin cannot classify is silent.
