# Pipelines, index and evaluation

## Index

`recall index` mines your agent homes incrementally and embeds each new statement once (`text-embedding-3-small`, cached by text hash).

| Host | Read | Counted as yours |
|---|---|---|
| Claude Code | `<home>/projects/**/<session>.jsonl` (sub-agent transcripts excluded) | `type:user`, not sidechain, not meta, `origin.kind:"human"`; plus messages typed mid-turn (`attachment` of type `queued_command`, origin human); older transcripts without `origin` by the text rules |
| Codex | `<home>/sessions/**/rollout-*.jsonl[.zst]`, `<home>/archived_sessions/rollout-*` | `event_msg` `item_completed` `UserMessage` of interactive sessions only (`exec` and sub-agent rollouts are skipped); `response_item` user turns only when a rollout has no such events; a legacy rollout (no `session_meta`) when a typed-prompt log names its session |
| Every Code | `~/.code/sessions/**/rollout-*.jsonl`, `~/.code/archived_sessions/` | same as Codex |
| typed-prompt logs | `<home>/history.jsonl` of every kind | every row whose session no transcript speaks for (Codex, Every Code: no rollout of the session; Claude Code: no transcript statement of the same project with the same text); rows younger than 10 minutes wait for the next pass |

Which homes: `~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, `~/.code` when present, plus the homes listed in the `homes` setting (an entry `{"path", "kind"}` is read for indexing only and never runs a worker). Other `~/.claude*` and `~/.codex*` directories are reported by `recall index` and `recall doctor`, not read. With the optional roster (`homesRoster`) the roster names the homes instead of the standard ones. Credentials are never opened: the walk skips dot-directories and any path naming `secrets`, `.ssh`, `auth.json`, `.credentials.json`, `.env` or containing `token`.

What is excluded, counted by reason in the report and logged one line each to `<data>/logs/index-dropped.jsonl`: tool results, task notifications, peer messages, skill bodies and slash expansions, harness envelopes, sub-agent briefs, `claude -p` and `codex exec` prompts, whole Claude sessions run in a temp directory, compaction summaries, key material, and anything shorter than `minChars` (20). The text rules are in `scripts/lib/text-filter/` (see [design.md](design.md)); an opt-in `fleet` profile and your own `dropPatterns` add more. Secret-shaped spans are redacted, long digit runs are dropped, and (when `ownerEmails` is set) so are statements containing anyone else's email address.

`recall index` builds the statements and their embeddings incrementally: new transcript bytes are scanned, each new statement is embedded once by text hash, and a statement without an embedding is not searchable until the next pass (`recall query` warns). Per file the scan state keeps size, mtime, byte offset and line count, so a growing transcript is read from where it stopped, an unchanged one is not opened, and a half-written last line waits for the next pass. A statement's id is a hash of host, time and text, so the same turn found in a resumed session or a second home is one statement. Session-chunk nodes (24 consecutive statements of one conversation, clipped to 2,400 characters) are cut from the eligible statements for each query, because eligibility depends on the decision time and the live session, so they are never stored; BM25 is computed per query over the eligible documents for the same reason. Decisions answers are cached by question, which is why a repeated situation costs nothing.

After answering a prompt, the hook may start `recall index --enrich` as a detached background process (at most once per `autoIndexMinutes`, default 30, behind a lock; `autoIndex: false` turns it off): it indexes and embeds, releases the index lock, then writes the cards of the new statements. `recall index --dry-run` scans from scratch in memory, writes nothing, and reports what an index would hold and cost: per source (`bySource`, `<home>|transcripts`, `<home>|archived` or `<home>|history`: the statements found and how many are not in the index yet), per desktop-envelope peel (`byPeel`), and whether every indexed statement is still produced with the same text (`idStability`: an indexed statement whose transcript is gone cannot be, and is counted apart).

## Named pipelines

Selectable with the `pipeline` setting (`RECALL_PIPELINE`; UserPromptSubmit and `recall query`), `recall query --pipeline` and `recall eval --pipeline`:

| Name | What it does |
|---|---|
| `default` | the tuned winner, below; the UserPromptSubmit pipeline |
| `embeddings` | cosine top-k of the situation's embedding; the baseline |
| `sessions` | session chunks (K24/L2400), top 32 routes, fixed node/item/embedding blend |
| `default+codex` | default top 20 reordered by a listwise `codex exec` judgement through the router; invalid permutations throw |
| `default+listwise` | default top 24, Decisions choices in forward and reverse order, averaged probabilities |
| `compose` | sessions + HyDE + embeddings + BM25 + offline durability; frozen combiner and listwise blend (needs `recall index --durable`) |
| `compose-lean` | sessions + embeddings + BM25; frozen combiner and listwise blend; no durable index needed |
| `default+rerank` | compatibility name for `default+codex` |

Their frozen coefficients and constants are in [compose-pipelines.json](compose-pipelines.json) and [x3-pipeline.json](x3-pipeline.json). All of them keep the default pipeline's probability gate for hook injection.

## The default pipeline

`scripts/lib/pipelines/default.mjs`, constants in `scripts/lib/pipelines/spec.mjs`, checked against `docs/x3-pipeline.json` by `test/spec.test.mjs`:

1. **Situation.** The shared input of every query. At prompt time (`queryContext`):
   ```
   SITUATION (conversation so far, newest last):

   PROJECT: <repo, else the cwd's directory name>

   OWNER (earlier): <your previous message, prose only, clipped to 300>

   ASSISTANT: <the agent's last reply, prose only, clipped to 400>

   OWNER (latest message, before the agent has acted): <the new message, clipped to 1500>
   ```
   The earlier message and the reply are read from the tail of the live transcript (the last 4 MiB); a part that does not exist (the first message of a session, a Codex `--ephemeral` run with no rollout) is left out, and a user turn equal to the new prompt is not "earlier". Both earlier parts are reduced to prose before they are clipped (`scripts/lib/plain-prose.mjs`): fenced code, tool-output wrappers, `cat -n` style file dumps, diff headers, `$ ` shell lines, indented code, URLs and tokens of 81 or more characters are removed. The new message is left exactly as typed. With `queryContext` off the situation is the new message alone.
2. **Query.** Embedding of the situation clipped to 6000 characters; BM25 query = tokenised situation (k1 1.2, b 0.75, IDF over the eligible history only).
3. **Prefilter.** Embeddings top 150, BM25 top 60 and the 30 newest eligible statements of the same thread (session), deduplicated: about 200 statements.
4. **D-generic.** The question "Is this past owner statement important for handling the situation above correctly?" for each prefilter statement, one predicate per statement, packs of 72 sent concurrently. The statement line is `Past owner statement: "<text, clipped to 260>"` (with `itemGist` on, `Past owner statement (said while <gist>): "<text>"`). A refused question is ranked after every scored one, in embedding order, and counted.
5. **Fusion.** Reciprocal rank fusion: `1/(k+E) + 1/(k+B) + 2/(k+Dg)` with E and B the full-history embedding and BM25 ranks, Dg the rank by judge probability inside the prefilter (ties by embedding rank), k = 60 (k = 10 at prompt time). The same-thread list selects the prefilter but is not fused. Order: fused score, then embedding rank, then position.

Eligibility is enforced once, in the retrieval core: an item is eligible only if its time is strictly before the decision time (compared as parsed microseconds, never as strings), its id is not in `exclude_ids`, for hooks it is not from the live session's visible statements, and, with the card filter on, its card allows it in the current repo (kind not in `excludeKinds`; said in the current repo, or a global rule or preference; a statement with no card is not eligible; and none of the four precision rules keeps it out: `excludeNewSessionGist`, `excludeCitations`, `crossRepoMaxChars`, `ruleMaxChars`).

Injection: a statement is injected only if the pipeline's gate passes, never merely because it ranked high. For `default` that is the D-generic probability at least `promptThreshold` (0.95); for `embeddings` the cosine at least `embThreshold` (0.35). Then, in this order: statements already injected in this session are dropped (`noRepeat`, before the cut so a repeat never costs a slot), hubs are dropped (injected into `hubMaxSessions` other sessions within `hubWindowDays`), repeats of one text are merged keeping the best-scored copy, then the apply gate (below) reranks what is left and keeps the first `k` (3) at `applyThreshold` (0.2) or more, and those are rendered as cards. With `applyGate` off the top `k` of what is left are taken in their fused order. API probabilities are coarse (rounded to 0.01) and not calibrated: use them to rank and gate, not as confidence.

## The apply gate

`scripts/lib/apply-gate.mjs`; run by the prompt hook between the survivor list (`survivorsOf` in `injection.mjs`: the pipeline's gate, `noRepeat`, hubs, repeats of one text) and the `k` cut. Experiment x10 (the usefulness-gate experiment, see docs/evidence.md for the earlier ones) scored several phrasings of "is this statement useful here" against labelled cards; "does it apply to the task the assistant is doing right now, not just the same topic" with the card gist in the statement line (`apply@g`) is the one built in: it separates useful from misleading cards far better than the D-generic probability does (AUC 0.749 against 0.531).

- **Question** (word for word): `Does this past owner statement apply to the task the assistant is doing right now, not just the same topic?`
- **Statement line**: `Past owner statement (said while <gist>): "<text, clipped to 260>"`, then a newline, then the question, as one predicate named `<statement id>|apply@g`. `itemGist` (D-generic's line) is unrelated and stays off.
- **Input**: the situation text of D-generic, unchanged.
- **Request**: one request with one predicate per survivor (the API takes 200 per request; the ranked list holds at most 50). The question cache and the cap guard apply as for D-generic.
- **Selection**: the survivors sorted by the probability, descending (ties keep the fused order); those at `applyThreshold` or more, at most `k`. A refused or unanswered question (and a statement with no card, which cannot be shown) cannot pass.
- **Deadline**: the gate runs inside the hook's `timeoutMs`, which starts before retrieval. When it cannot answer (deadline, cap, API error) the hook injects nothing and logs `apply-gate-failed` (a cap hit logs `cap-reached` as before), because the gate is the precision step and the unreranked list is what it exists to replace.
- **Log**: the prompt line's `applyGate` record (`threshold`, `k`, `survivors`, `passed`, `selected`, `refused`, `questions`, `requests`, `cachedRequests`, `cacheHits`, `costUsd`, `ms`, and `rows`: `{id, p, pass}` per survivor in fused order, at most 50) and `apply` (the two settings with their sources). `candidates` and `injected` are unchanged: `injected` lists the injected ids in the order they were rendered.

## Repo identity and aliases

A statement's repo decides the scope rule, so a statement filed under no repo (its directory was deleted or renamed after the session) can only be treated as another repo's. The repo of a session is taken in this order (`scripts/lib/repo-identity.mjs`):

1. the checkout on disk: its own `.git`, or the repository a linked worktree points back at;
2. when the directory is gone or was never a checkout, the working directory's layout alone, with no disk access: `<tool home>/worktrees/<id>/<repo>` (Codex, Every Code), `<repo>/.claude/worktrees/<name>`, `<repo>/.worktrees/<name>`, `<repo>-worktrees/<name>`, `~/www/<org>/<repo>` (the repo is the first directory below the org), `~/www/<repo>`, and `~/<repo>` for a project directly under the home folder (not `Documents`, `Library` and the like, and no dot-directories);
3. the name of the git remote the session recorded (a Codex `session_meta` `git.repository_url`), only when the path says nothing.

The rule is the same at index time and at hook time (the payload's `cwd`). `recall index` also repairs statements already indexed with no repo, from the cwd kept in its scan state. `repoAliases` (config key, or `RECALL_REPO_ALIASES` as JSON) says that a renamed or sibling repo is the same repo for the scope rule, both ways: `{"web-app-v2": "web-app"}`. Chains and self-aliases are errors.

## Hub suppression

A few generic statements, said into everything, can dominate the output and are never useful. A statement already injected into at least `hubMaxSessions` (default 3) distinct **other** sessions within the last `hubWindowDays` (default 14) days is a hub and is not injected again; the check runs before the `k` cut, so the next statement takes its place. The current session does not count (that is `noRepeat`). `hubMaxSessions` 0 turns it off. The hook keeps `<data>/state/hub-index.json`, updated under a lock on each injection and pruned to the window; when it does not exist it is built once from the turn logs. A file that exists but is invalid is an error naming the way out (delete it).

## Statement cards

`recall enrich` writes one card per statement to `<data>/cards.jsonl`, a JSON line `{id, kind, scope, scope_repo, gist, model, at, gist_source}`:

| Field | Meaning |
|---|---|
| `kind` | `rule`, `preference`, `decision`, `correction`, `question`, `status`, `other` (shown on the injected card as `Fact/task`). Definitions and examples are in [cards-prompt.md](cards-prompt.md), the fixed prompt the writer is given. Which kinds are injected is the `excludeKinds` setting, and only rules and preferences cross repos. |
| `scope` | `global`: working style, agent behaviour, communication or a cross-project preference. `repo`: specific to that project's code or product. `unclear`. |
| `scope_repo` | the repo the statement was said in for `repo` and `unclear` (null for `global`) |
| `gist` | at most 20 words, what was going on when you said it, written only from what came before the statement |
| `gist_source` | where that context came from: `transcript`, `index`, `history` (the previous row of the session in the typed-prompt log the statement came from), `prior-statement`, `none` |

The writer is chosen once per run (`--worker auto`, the default): `claude -p --model haiku` with a JSON schema when a Claude home is usable (by default the current host's own), otherwise `codex exec`, otherwise the run stops before it starts and names why. Batches are about 40 numbered statements, at most 4 calls at once. Extended thinking is switched off for the worker (`MAX_THINKING_TOKENS=0`; it made a batch of 40 about six times slower). Every card is validated (kind, scope, gist length); an invalid or missing one is asked again once, and a statement still without a valid card is left without one and listed loudly (and the exit code is non-zero). It is incremental (ids that already have a card are skipped), takes a lock per output file, and never writes a card it did not receive. A card is written once and not refreshed; to re-card, delete `cards.jsonl` (or the lines you want redone).

## Offline evaluation and replay

`recall eval` follows an offline contract exactly:

- corpus JSONL `{"id","text","ts","session_id","repo","host":"claude|codex|code"}`
- cases JSONL `{"case_id","mode":"prompt|stop","query","decision_ts","session_id","exclude_ids":[...]}`, optionally with `"context":{"project":"<repo>","prior":[{"role":"user|owner|assistant","text":"..."}]}` (the current repo and the conversation before the message, oldest first)
- output JSONL `{"case_id","ranked":[{"id","score"} x top 50]}`, in case order
- eligible iff `ts < decision_ts` (parsed) and `id` not in `exclude_ids`; the case's `session_id` excludes nothing and names the thread for the same-thread list
- a `query` that already starts with `SITUATION` is used as is; a bare text is wrapped in its mode's layout
- the settings apply as configured; on the command line `--v1` sets every behaviour setting to the first release's values (bare dated quotes, `k` 5), `--v2` to the current defaults. With the card filter on, `--cards <file>` supplies the cards of the corpus (`recall enrich --corpus ...` writes them); a corpus statement without a card is not eligible
- `--hub-history <file>` is the replay's injection history for hub suppression (one `{"id","session_id","ts"}` per line); without it nothing is a hub, and the live hub index is never read
- `--inject-out <file>` writes, per case, the situation as sent, the ranking with the judge's probability, and `context`, the exact block the prompt hook would inject
- gold is never an input. The run is resumable (cases already in `--out` are skipped), writes `<out>.stats.jsonl` and `<out>.errors.jsonl`, and exits non-zero if any case failed or was not run. The eval corpus is embedded into its own store (`<data>/eval-store`), never the hooks' index. For latency measurements use `--no-cache`.

Decisions answers are cached per exact question before uncached questions are packed. Predicate keys are a SHA-256 of `input + NUL + instructions` (first 32 hex characters); choice keys a SHA-256 of `{input,type,instructions,choices}` with option order preserved. Question names and packing do not affect identity; refusals are retained.
