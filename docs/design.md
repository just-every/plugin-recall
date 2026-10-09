# Recall: design notes

## Why this shape

A research prototype found that cheap, narrow Decisions questions put the earlier statement that matters in the top 5 a little more often than embeddings do (recall@5 0.327 against 0.260, MRR 0.29 against 0.19 on its development set), that the two methods find different needles (Decisions only 19 cases, embeddings only 12, both 15 of 104), and that two things cap the approach: saturation (about 23 items per case rate 0.99 or more) and the prefilter ceiling (30% of cases have the needle beyond embedding rank 300). Recall is the smallest useful product of that: an index of the statements you typed, a retrieval core with named pipelines, and one hook. It acts only when you send a message; it has no Stop hook.

## Data layout (`RECALL_DATA`, default `~/.plugin-recall`, shared by every home and host)

```
statements.jsonl            append-only: {id, text, ts, session_id, repo, host, hash, src}   src = <file>:L<1-based line>
embeddings/c-*.f32,.json    immutable chunks of float32 rows keyed by text hash (a sentence is embedded once)
state/files.json            per transcript file: size, mtime, byte offset, line count, session meta
state/last-index.json       last index report (counts per exclusion reason)
state/index.lock            the one-indexer-at-a-time lock (holder pid + token; recovered when the holder died)
state/warned.json           when the hourly cap warning last fired
state/hub-index.json        which statements were injected into which sessions (hub suppression)
locks/*.lock                short critical sections: ledger cap check, statements append, warning clock
inflight/*.json             live cost reservations of every process (counted against the daily cap)
cards.jsonl                 one card per statement: {id, kind, scope, scope_repo, gist, model, at, gist_source}; append-only, last line wins
turns/<session>.json        the ids injected so far in the session (noRepeat)
ledger.jsonl                spend, one line per billable call
cache/, question-cache.sqlite   response and answer caches
logs/turns-*.jsonl          per-turn log; logs/index-dropped.jsonl; logs/auto-index.log
router/usage-cache.json     `usageCmd` output TTL cache (only with usage routing)
config.json                 optional settings
```

Chunk files are written under a temporary name and renamed (the `.json` that makes a chunk visible is renamed last), so readers and writers never need a lock. The JSONL files are append-only; the statements append and the ledger's cap check run under `scripts/lib/lock.mjs` locks, and a reader skips a last line that is still being written.

## Retrieval

`retrieve({corpus, query, mode, decisionTs, excludeIds, excludeSession, pipeline, deps, cfg})`:

1. eligible indices: `ts < decisionTs` (parsed microseconds), not in `excludeIds`, not from `excludeSession`, and (card filter on) allowed in `currentRepo` by its card: its kind is not in `excludeKinds`, and it was said in `currentRepo` (any scope, aliases applied) or is a global rule or preference, and no precision rule keeps it out (`cards/precision.mjs`: a placeholder gist, a cited URL or path, a cross-repo statement of 300 characters or more, a rule or preference of 500 or more; the first rule that applies is the reason the turn log records, and the tally comes back from `retrieve` as `excluded`);
2. the pipeline runs over the eligible set: `prefilter` ranks all eligible items by cosine and by BM25 (IDF from the eligible items only), and builds the candidate set;
3. the Decisions stage asks the D-generic question about each candidate in packs of up to 200 (one shared `input`, one predicate per statement; questions are independent in the API so packing never changes an answer);
4. ranking: probability, ties by embedding rank; refused and unscored items follow in embedding order. Scores in the output are made strictly monotone with the order, raw numbers are in `parts`.

The pipelines and their constants are described in [pipelines.md](pipelines.md).

## Hooks

`UserPromptSubmit`: stay silent unless a person is at the keyboard (`headless.mjs`, [hosts.md](hosts.md) section 4) and the shared spend cap is not reached; then filter the prompt with the same text rules as the index (so automation briefs, task notifications, skill buttons and trivial prompts are silent), retrieve with `decisionTs = now`, the live session's visible statements excluded and `currentRepo` from the payload's cwd, gate, drop what the session was told already, drop hubs, take k, format the cards, record the injected ids, log. The whole retrieval runs under `timeoutMs`; every network call carries the same deadline. Any failure prints the host's "continue" output after logging loudly.

Host differences are handled in `hook-io.mjs`: Claude (`prompt_id`, `scratchpad_dir`, no `model` or `turn_id`), Codex (`turn_id`, `model`, `agent_id` for sub-agents, `{"continue":true,...}`), Every Code (`CODE_HOOK_PAYLOAD`, plain stdout, exit 2).

## Setup and doctor

`scripts/onboarding/` holds `recall setup` (the one-liner `npx -y @just-every/plugin-recall`), `recall uninstall` and `recall doctor`. Setup detects the tools and homes, finds or asks for the key (`scripts/lib/providers/` declares each provider), shows one plan and asks once; only then does it prove Decisions access with one tiny request, save the key, write `config.json`, copy the package into `<data>/marketplace/plugins/recall-<version>/`, build the index, start the card writer in the background and install into each home through the host's own CLI (`hosts/`, docs/hosts.md section 2.5). A run with nothing to do writes nothing. Doctor only reads: it never writes, shows a key only masked, and makes at most one free request (`GET /v1/models`).

## Text filtering

`scripts/lib/text-filter/` turns a raw transcript turn into the words a person typed or says why not: envelopes are peeled (`envelopes.mjs`), harness turns dropped (`harness.mjs`), secrets redacted and other people's data dropped (`secrets.mjs`), and the opt-in fleet profile (`fleet.mjs`) and `dropPatterns` add rules for turns that agent tooling writes as if typed. `ownerNames` and `ownerEmails` switch on the two rules that need to know who you are.

## Choices worth knowing

- ESM (`.mjs`), no dependencies. Node 22.15 is the floor.
- The gate for injection is the judge's probability, not rank: with saturation the top five of a fused ranking are not necessarily worth saying. The injection threshold (0.95) is the prototype's, untuned on this plugin's own logs; k is 3.
- The card filter is part of eligibility, not a post-filter: with excluded kinds and the scope rule on, the prefilter, BM25 statistics, session chunks and ranks are computed over the statements that could be injected, so the judge is not asked about questions and other repos' statements. Statements without a card are not eligible (fail closed), which is why the hook says `no-cards` loudly until `recall enrich` has run.
- `RECALL_OPENAI_BASE_URL` exists so the test suite can run the hook scripts as real subprocesses against a local fake; it is also a legitimate proxy setting.
- Generative steps (cards, the optional rerank and HyDE stages) use your own `claude` or `codex` CLI, never an API this plugin bills.

## Not covered

- Codex plugin discovery, the trust flow and the loader's `${PLUGIN_ROOT}` expansion are only covered by a real `codex plugin add`; unit tests cover the shell form of the hook command under both hosts' environments.
- Every Code hooks are unit-tested with `CODE_HOOK_PAYLOAD`, not run inside `coder`.
