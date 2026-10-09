# Recall for Claude Code and Codex

Recall is a memory plugin. RAG misses nuance: the small thing you said three weeks ago, in another thread, that matters for exactly this request ("no fallbacks, show me the failure", "keep the diff small", "ask before touching the database"). Recall mines the messages **you typed** in your Claude Code, Codex and Every Code history, finds the few that matter for the request in front of the agent, and brings them back through **one hook, `UserPromptSubmit`**. It acts only when you send a message.

It injects at most 3 short **typed memory cards**:

```
<recall-context>
From your earlier conversations (Recall). Apply if relevant; no need to mention them. Each card names its source; run its context command only if a memory matters here and the card is not enough.
• Rule, all projects (said 7 Sep, the agent had just pushed a fix straight to main):
  "Never push to main without asking me first."
  source: ~/.codex/sessions/2026/09/07/rollout-2026-09-07T10-12-00-0199aaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl.zst:L1234 · context: node /home/sam/.claude/plugins/cache/plugin-recall/recall/0.5.1/scripts/recall.mjs show codex-3f9a1c0d2b7e4a65
• Fact/task, this repo (billing-api) (said 2 Oct, the user asked where the fixtures live):
  "The fixtures are in test/data, never copy them."
  source: ~/.claude/projects/-home-sam-projects-billing-api/0a1b2c3d-0000-4000-8000-000000000001.jsonl:L871 · context: node /home/sam/.claude/plugins/cache/plugin-recall/recall/0.5.1/scripts/recall.mjs show claude-91c4e7a2d05b3f18
</recall-context>
```

**Where a card came from.** Every card ends with a `source:` line (the transcript and line the statement was said on, with `~` for the home directory) and the command that reads the conversation around it, so an agent that finds a card relevant but too thin to act on can look at what was going on, and only then. The command names the plugin root the hook is running from (`CLAUDE_PLUGIN_ROOT`, else `PLUGIN_ROOT`, else the root of the running script), so it runs the same copy of the plugin in that home. See `recall show` under "Using it".

A bundled skill tells the agent what the cards mean and how to look things up on demand (`recall query "..."`).

How it picks them: an index of everything you typed (embeddings, cached by text); a cheap model-written **card** for each statement (kind, scope, a one-line gist); at each prompt, embeddings plus BM25 shortlist about 200 candidates and the OpenAI Decisions API judges each with one narrow question ("is this past statement important for handling the situation above correctly?"); only statements above a high bar, from the right repo, not already said in this session and not a hub, are injected.

## Install

```bash
npx -y @just-every/plugin-recall
```

**You need** Node 22.15 or newer, Claude Code or Codex (or both) installed and logged in (one of them writes Recall's short summaries), and an OpenAI API key from an organisation with access to the Decisions API (Recall uses it for embeddings and to pick what to bring back). Access is per organisation: a key without it is stopped at setup, before anything is installed.

**What it does.** It asks at most two things: your OpenAI key, only when it finds none (or with `--new-key`), and "Go ahead?" once over the whole plan. Nothing is written and nothing is paid for before that yes.

- Finds Claude Code and Codex, says whether each is logged in, and lists every agent home it can install into (`~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, and sibling homes such as `~/.claude_work` or `~/.codex-alt`), numbered, then the homes it only reads (`~/.code`, or a host whose CLI is not installed). Under the table it gives the `--homes` command that adds a left-out home back.
- Finds your OpenAI key in the environment or in `~/.env`, or asks you to paste it (hidden input; Enter on an empty line stops; quotes and a leading `OPENAI_API_KEY=` are removed), and checks it for free. It says there that it needs a key with Decisions API access. A key OpenAI rejects is named as such; if it is the `OPENAI_API_KEY` exported in your shell, setup says so, because that variable wins over `~/.env` (unset it and delete it from your shell profile).
- Shows one plan: the homes, the key it found (masked, with where it found it), saving the key to `~/.env`, what the first index costs, what each prompt costs, the daily spend cap and, the first time a key is used for sending, what leaves the machine (with `--skip-key` it says "Nothing leaves this machine until you add a key." instead). Type `y`, or home numbers (`2`, `2,4`, `2-4`): that is a yes that leaves those homes out. The homes and the plan are shown again and setup goes on without asking again. A key that is only in your shell's environment is saved too: desktop apps do not pass that environment to hooks, so `~/.env` is where the hook reads it. Only `--no-save-key` (remembered for later runs) leaves the file alone.
- Checks once that the key can pick what to bring back (one tiny request to the Decisions API, less than $0.0001), then builds the index with a progress line and starts writing the short summaries in the background with your own `claude` or `codex` CLI. If the check fails, nothing is installed and nothing is left behind.
- Installs Recall into every chosen home through the host's own CLI (`claude plugin`, `codex plugin`), from a copy of this exact version kept in `~/.plugin-recall/marketplace`, and adds a `recall` command at `~/.local/bin/recall`.
- Ends with a summary: where it is on, what it costs, how to watch, check, pause, resume and remove it, the line that puts `~/.local/bin` on your shell's PATH, and the one step Codex needs from you (approve Recall once in each Codex home's Hooks page: the "Hooks need review" screen on its next start, or `/hooks`). If a home could not be installed, it prints the exact command that retries only those homes (`npx -y @just-every/plugin-recall --homes <homes>`).

Running it again changes nothing and asks nothing when everything is current. To pipe the key from a script: `printf '%s\n' "$KEY" | npx -y @just-every/plugin-recall --yes`. `npx -y @just-every/plugin-recall --help` lists every option.

| Option | Effect |
|---|---|
| `--yes`, `-y` | Go ahead without asking. Every home is installed except `--exclude` and homes left out at an earlier run; a key that was found is used and saved. With no key anywhere, pipe it in (above). |
| `--homes <list>` | Act only on these homes (comma separated, `~/x` or absolute), even ones left out earlier. Every other home stays as it is. |
| `--exclude <list>` | Do not install into these homes, now and on later runs. A left-out home is still read for memory when it is a default home (`~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`); the homes table says so. |
| `--new-key` | Ask for a different key (hidden paste, or piped with `--yes`), check it, and save it to `~/.env` in place of the one there. |
| `--no-index` | Install without building the index now; the hook builds it in the background after your next prompt. |
| `--skip-key` | No key question, check or request (implies `--no-index`). Recall stays silent until it has a key, and nothing leaves the machine. |
| `--no-save-key` | Do not save the key to `~/.env`, now or on later runs (recorded in `state/key-choices.json`; `--new-key` saves one again). The hooks then read it only from the environment of the app that runs them, so the key must be in `OPENAI_API_KEY`. |
| `--daily-cap <usd>` | The daily spend cap (default $1). On a later run it changes the cap. |
| `--dry-run` | Show what would happen and change nothing (no request, no file, no host command). |

The same flow is `recall setup` (or just `recall`) once `~/.local/bin` is on your PATH; `npx -y @just-every/plugin-recall doctor` (or `recall doctor`) checks everything afterwards, and `npx -y @just-every/plugin-recall pause` / `resume` switch Recall off and on (see Kill switch). `recall help --all` lists every command with its options; the evaluation and research commands are listed only with `RECALL_DEVELOPER=1`.

**Update:** `npx -y @just-every/plugin-recall@latest`. It updates every home in place and keeps the previous version's copy until the next update. **Uninstall:** `npx -y @just-every/plugin-recall uninstall [--purge]` (see Uninstall).

**Decisions API access.** The judge is the OpenAI Decisions API, and not every key may call it; no free request can tell. Access is per OpenAI organisation: use a key from one that has it, or ask OpenAI to enable it. Setup names this where it asks for the key, proves access once with the smallest real request and stops, with nothing installed and no folder left behind, if the key has none (HTTP 401, 403 or 404, which only `recall doctor` shows). `recall doctor` shows when it was checked.

**By hand from a checkout**, without the installer:

```bash
# Claude Code
claude plugin marketplace add /path/to/plugin-recall
claude plugin install recall@plugin-recall

# Codex
codex plugin marketplace add /path/to/plugin-recall
codex plugin add recall@plugin-recall
```

Then put `OPENAI_API_KEY=...` in `~/.env`, approve the hook in Codex, and build the index and the cards once with `recall index --enrich` (until cards exist the hook is silent and logs `no-cards`). Both hosts cache an installed plugin by version, so after changing a checkout bump the version or install again. The installer, run later, points the `plugin-recall` marketplace at its own copy.

## Privacy

**Stored locally**, in `~/.plugin-recall` (or `$RECALL_DATA`), shared by every home and host: the statements you typed (`statements.jsonl`, with the transcript file and line they came from), their embeddings, their cards, a ledger of spend, response caches, and logs of what the hook did (each turn's log line holds the situation it searched with, clipped to 3,000 characters, and the cards it injected). Nothing else is copied from your transcripts, and credentials are never opened (paths with `secrets`, `.ssh`, `auth.json`, `.credentials.json`, `.env` or `token` are skipped).

**Sent to OpenAI** (your API key):
- every statement once, to the embeddings API: at most its first 2,000 characters, after secret-shaped text (API keys, bearer tokens, private keys) has been redacted and statements holding long digit runs have been dropped;
- on each prompt you send: to the embeddings API the situation, and to the Decisions API the situation plus about 200 earlier statements of yours, each clipped to 260 characters. The situation is the project name, your previous message (redacted the same way, clipped to 300 characters), **the agent's last reply as plain prose clipped to 400 characters (code, tool output and URLs removed; this part is not redacted)**, and your new message.

**Sent to your own `claude` or `codex` CLI**, under the login it already has (so to Anthropic or OpenAI as your normal use does): to write a card, each statement (clipped to 1,200 characters) with your previous message (300), the previous assistant message (600) and the repo name. The worker runs with hooks disabled, a read-only sandbox, no tools and no session persistence.

**Not sent anywhere:** the index, the cards, the logs and the caches. Recall has no telemetry. A non-interactive session (`claude -p`, `codex exec`, sub-agents) is never searched and never indexed.

**Delete everything:** `rm -rf ~/.plugin-recall` (or your `RECALL_DATA`). That removes the index, cards, ledger, logs and `config.json`. `npx -y @just-every/plugin-recall uninstall --purge` removes the plugin from every home and deletes this directory too. To forget one statement, delete its line from `statements.jsonl` and `cards.jsonl`; an index run would add it back from the transcript, so delete it from the transcript too or add a `dropPatterns` entry that matches it.

## Costs

| What | Cost |
|---|---|
| First index | embeddings at $0.02 per million tokens: about $0.014 for 12,000 statements |
| Each prompt | about $0.004 (about 200 Decisions questions), $0 when the same situation was judged before (answers are cached) |
| Cards | no API charge from Recall; one call to your own CLI per about 40 statements |
| `recall query` | the same as a prompt |

A shared daily cap (default **$1 per UTC day, across every home and host**) is enforced before any request is sent: a request that would pass it is refused. When the cap is reached the hooks go silent until UTC midnight, with a quiet log line per silenced turn and one loud line per hour. `totalCapUsd` caps the whole ledger. `recall spend` shows the totals and where each cap comes from.

## Kill switch

1. `npx -y @just-every/plugin-recall pause` (or `recall pause`) makes every hook a no-op in every home; `npx -y @just-every/plugin-recall resume` turns Recall back on. It sets or clears `"disabled"` in `~/.plugin-recall/config.json` (you can also set `RECALL_DISABLED=1` where the host passes your environment), is read on every turn, and so takes effect immediately. `recall doctor` says when Recall is paused.
2. Disable the plugin in the host, keeping it installed: `claude plugin disable recall@plugin-recall`; for Codex set `enabled = false` under `[plugins."recall@plugin-recall"]` in `config.toml`, or `codex plugin remove`.
3. Uninstall.

## Uninstall

```bash
npx -y @just-every/plugin-recall uninstall           # or: recall uninstall
npx -y @just-every/plugin-recall uninstall --purge   # also delete ~/.plugin-recall
npx -y @just-every/plugin-recall uninstall --homes ~/.codex   # only these homes; the copy, the command and the data stay
```

It removes Recall from every home it is in, through each host's own CLI, then its copy in `~/.plugin-recall/marketplace` and the `recall` command, and Claude Code's cached copies in `<home>/plugins/cache/plugin-recall` once Claude Code has marked every one of them orphaned (otherwise it says Claude Code deletes them itself). Your index, cards and logs stay in `~/.plugin-recall` (delete them with `rm -rf ~/.plugin-recall`, or `--purge`), and `OPENAI_API_KEY` stays in `~/.env`. A home with another copy of Recall is left alone. A home whose `claude` or `codex` CLI is no longer installed fails on its own line ("claude is not installed; install it (...) or remove the home with --homes"): install the CLI again, or name the other homes with `--homes`. A failed home keeps Recall's copy for it, and the command to retry is printed. By hand, per home (`CLAUDE_CONFIG_DIR=<home>` or `CODEX_HOME=<home>` in front for another home):

```bash
claude plugin uninstall recall@plugin-recall && claude plugin marketplace remove plugin-recall
codex plugin remove recall@plugin-recall && codex plugin marketplace remove plugin-recall
```

Every Code has no plugin system: remove the `[[projects."...".hooks]]` entry from `~/.code/config.toml`.

## Using it

The hook needs no attention. Two commands are for you and the agent:

```bash
recall doctor                                  # what works and what does not
recall query "should I add a fallback here"    # what would Recall say? (the same search the hook runs, costs about $0.004)
recall query "deploy process" --kind rule,preference,decision --json
recall show claude-91c4e7a2d05b3f18            # the conversation around a recalled statement (the id is on the card; reads a transcript, costs nothing)
recall logs                                    # what the hook did today, by outcome and silence reason
recall spend                                   # spend today and in total, and the caps
recall monitor                                 # live local web view of the hook (loopback only, read-only)
```

`recall query <text> [--repo <name>] [--any-repo] [--kind rule,preference,...] [--k n] [--json] [--pipeline name] [--session id] [--before iso]`: `--repo` searches as if you were working in that repo (its statements plus your global rules and preferences), `--any-repo` lifts the repo restriction, `--kind` limits the cards considered, `--json` adds each statement's id, date, repo, kind and score. `*` marks what the hook itself would inject.

`recall show <statement-id> [--before 4] [--after 3] [--json]` prints a clean excerpt of the conversation a statement was said in. It is what the `context:` command on an injected card runs. It reads only: no API call, and nothing written except one line in the turn log (below). The id is the one on the card (and in `statements.jsonl`, and in `recall query --json`); `--before N` and `--after N` (at most 50) set how many turns come before and after the statement; `--json` prints the same data as JSON.

```
$ recall show claude-91c4e7a2d05b3f18 --before 1 --after 1
recall show claude-91c4e7a2d05b3f18
2026-10-02 09:14:05 UTC | host claude | home ~/.claude | repo billing-api | session 0a1b2c3d-0000-4000-8000-000000000001
source: ~/.claude/projects/-home-sam-projects-billing-api/0a1b2c3d-0000-4000-8000-000000000001.jsonl:L871
(1 turns before and 1 after; text is the prose only, each turn clipped to 600 characters; ">>" marks the statement the card quoted)

   ASSISTANT  09:13:12  L866
   The fixtures could live next to the tests or under test/data. Which do you prefer?

>> USER (recalled statement)  09:14:05  L871
   The fixtures are in test/data, never copy them.

   ASSISTANT  09:14:31  L874
   Understood, I will read them from test/data. ...

   [ran 1 tool: Read]
```

- **What is a turn.** One message you typed or one assistant text message, in transcript order. Your turns follow the indexer's rules (typed turns and messages typed while the agent worked; harness envelopes, skill bodies, task notifications, `claude -p` prompts and other automation turns are not shown); the assistant's are its text only. A sub-agent's records, reasoning and tool results are never shown. A Codex message is written twice in a rollout (as an event and as a `response_item`): one copy is shown.
- **Tool calls** between turns are one line, `[ran 3 tools: Bash, Read, Edit]` (a repeated tool as `Bash x4`), never their arguments or output. Calls before the first turn shown are left out.
- **Cleaning.** Each turn is reduced to its prose (fenced code, tool-output wrappers, file dumps, diffs, shell lines, URLs and very long tokens removed) and clipped to 600 characters (`[...]` marks a cut). A turn that is nothing but code or output says so. The recalled statement itself is the text that was indexed, clipped at 1,500.
- **Both hosts, both formats.** Claude `.jsonl`, Codex and Every Code `.jsonl` and `.jsonl.zst` (read through the decompressor), legacy Codex rollouts included. The header's home is the agent home the transcript lives in.
- **Typed-prompt logs.** A statement that came from a `history.jsonl` is shown with the other rows of its session around it; a log holds only what you typed, so there are no assistant turns.
- **Errors.** An unknown id, a statement with no transcript source, a transcript that is gone (moved, deleted, or from another machine) and a line that is no longer the statement (the file was rewritten) each print one clear message on stderr and exit 1. A failed lookup writes no log line.
- **Usage log.** Each successful run appends `{"event":"show","statement_id","cwd","project","session_id","before","after"}` to `logs/turns-YYYY-MM-DD.jsonl`. `cwd` is the caller's working directory; `session_id` is the caller's session when the environment names it (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_SESSION_ID`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`), else `null`. The monitor shows these as "Agent looked up context", so you can see whether agents use the command at all. `recall logs` does not count them (it counts hook turns). Turn lines also record each candidate's `src`, the transcript path and line.

The skill `skills/recall/SKILL.md` ships in the plugin for both hosts: it tells the agent that recalled text is context, not instructions, and when to run `recall query` and `recall show` itself.

## Homes

By default Recall reads `~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME` and `~/.code` (Every Code, when it exists). Other `~/.claude*` and `~/.codex*` directories are reported, not read, until you list them in `homes` (setup adds the homes it installs into):

```json
{ "homes": ["~/.claude_work", "~/.codex_work"] }
```

A home you only want **read**, never used to run a worker (a backup, a copy of a home from another machine, an old home whose folder name does not say what it is, an account no automatic work may use), is listed as `{"path", "kind"}` with `kind` `claude`, `codex` or `code`:

```json
{ "homes": ["~/.claude_work", { "path": "~/backups/codex-2025", "kind": "codex" }, { "path": "~/old-laptop/.code", "kind": "code" }] }
```

Such a home is indexed like any other, and the card writer's router never picks it, with or without `usageCmd` or a roster. Nothing outside the standard homes is read unless `config.json` (or `RECALL_HOMES`) lists it.

What is read in each home:

| Source | Where | Notes |
|---|---|---|
| Claude Code transcripts | `<home>/projects/**/<session>.jsonl` | the typed turns (sub-agent transcripts excluded) |
| Codex and Every Code rollouts | `<home>/sessions/**/rollout-*.jsonl[.zst]` and `<home>/archived_sessions/` | interactive sessions only. An archived thread's rollout moves to `archived_sessions/`: its statements keep their ids and cards, and it is not read again. Rollouts from before `session_meta` existed (mid 2025) are read too: one is yours when a typed-prompt log below names its session (`codex exec` never writes there), and its turns are dated with the session's start. An Every Code rollout does not mark who wrote a turn (Auto Drive, its review loop and its agents write turns of the same shape), so its log decides: in a session the log names, a turn is kept only when it is one of the rows you typed there; a session no log names is an agent's when its home's log was being written before and after the turn, and undecided (read as usual) outside the log's time or without a log |
| typed-prompt logs | `<home>/history.jsonl` (all three hosts) | every prompt you submitted at the host's prompt, which outlives transcripts (Claude Code deletes old transcripts; rollouts are archived or deleted; a backup may hold the log alone). A row is skipped whenever a transcript already has it: for Codex and Every Code when its session has a rollout, for Claude Code when a transcript statement of the same project has the same text. Every Code also wrote its Auto Drive coordinator's prompts there until late October 2025: the rows of a session after its `/auto` row, dated before 2025-10-23, are skipped until a typed row comes 3 hours or more after the session's previous one (the run is over: that row and the later ones are yours again, up to the next `/auto`; a slash command after such a gap is kept, but the run can go on after it). A row inside a run that carries an attached image (`[image: ...]`) is yours; your other interjections during a run cannot be told from the coordinator's prompts and are skipped with them. The goal typed after `/auto` is kept, also in a session that has a rollout (the rollout holds only Auto Drive's "Primary Goal:" wrapper of it). A row's repo is its Claude project's; a Codex or Every Code row has none |

An index built by an earlier version is brought up to the current text rules once: each file it read is read again from the start and every line is judged again, so the upgraded index holds what a fresh index of the same files would. A line that holds no statement yet is judged like a new turn. A statement the current rules make of its line again is kept; one they read to another text is rewritten in place under its id (its card survives, and its new text is embedded); one they reject is retired: taken out of `statements.jsonl` (nothing retrieves it, and its card, which stays in `cards.jsonl`, is never attached again) and written to `retired.jsonl` with the reason. A turn is never indexed twice under two ids: a candidate whose turn already has a statement is skipped. A Codex or Every Code rollout turn is known by its host, session and time (to the millisecond, with its place among the turns of its file that share that time), whatever the rollout file is called or wherever it is; a legacy rollout's turns and a typed-prompt log's rows, whose times are coarse, by their line as well.

The desktop apps' envelopes are taken off before a turn is judged: the Codex app's context sections ahead of `## My request for Codex:` (attached files, the in-app browser's state, selections, review findings) leave what you typed and the comments you left on a page or a diff; a Claude desktop quote reply (`<!-- reply -->` or `<!-- attach -->` and its `>` lines) leaves your own lines.

## Configuration

Settings come from three layers, **first one set wins: the environment variable, then `config.json`, then the built-in default.** The file is `<data dir>/config.json` (`~/.plugin-recall/config.json`; one file configures every home and host). Use the file for anything a desktop app must see, because desktop apps do not pass your shell environment to hooks. The file is read again on every hook run, so an edit takes effect on the next turn.

```json
{
  "dailyCapUsd": 2,
  "k": 3,
  "homes": ["~/.claude_work"],
  "repoAliases": { "web-app-v2": "web-app" }
}
```

**A bad file is loud, never ignored and never half-applied.** Invalid JSON, an unknown key (a typo such as `dailyCapUSD` included), a wrong type or an out-of-range value makes the hook silent for that run: it logs one `level:"error"` line with `reason:"config-invalid"` and the exact problem. `recall doctor` shows it too. Values are JSON types (`5` not `"5"`; lists are arrays; `null` for "no cap"). `RECALL_DATA` (it locates the file) and `RECALL_CHILD` (the plugin's own worker marker) are environment only.

| Setting (`config.json`) | Environment variable | Default | Meaning |
|---|---|---|---|
| `disabled` | `RECALL_DISABLED` | `false` | the kill switch |
| `dailyCapUsd` | `RECALL_DAILY_CAP_USD` | `1` | daily spend cap in USD, shared by every home |
| `totalCapUsd` | `RECALL_TOTAL_CAP_USD` | none | cap on the whole ledger, all days (`null` = none) |
| `k` | `RECALL_K` | `3` | at most this many cards per prompt |
| `promptThreshold` | `RECALL_PROMPT_THRESHOLD` | `0.95` | judge probability needed to inject |
| `excludeKinds` | `RECALL_EXCLUDE_KINDS` | `["question","status"]` | card kinds never injected (`none` / `[]` for none) |
| `scopeFilter` | `RECALL_SCOPE_FILTER` | `true` | a statement from another repo is injected only if it is a global rule or preference |
| `repoAliases` | `RECALL_REPO_ALIASES` | `{}` | `{"old-name": "canonical-name"}`: those repos count as the same repo |
| `excludeNewSessionGist` | `RECALL_EXCLUDE_NEW_SESSION_GIST` | `true` | precision rule RG, below: a card with the new-session placeholder gist is never injected |
| `excludeCitations` | `RECALL_EXCLUDE_CITATIONS` | `true` | precision rule RU: a statement that cites a URL, a local port or a file path is never injected |
| `crossRepoMaxChars` | `RECALL_CROSS_REPO_MAX_CHARS` | `300` | precision rule R5: a statement from another repo of this many characters or more is never injected; 0 = off |
| `ruleMaxChars` | `RECALL_RULE_MAX_CHARS` | `500` | precision rule R4v: a rule or preference of this many characters or more is never injected; 0 = off |
| `applyGate` | `RECALL_APPLY_GATE` | `true` | the apply gate, below: a second question per surviving statement, "does it apply to the task now?"; off = the survivors in their fused order |
| `applyThreshold` | `RECALL_APPLY_THRESHOLD` | `0.2` | the apply probability a statement needs to be injected |
| `queryContext` | `RECALL_QUERY_CONTEXT` | `true` | the judge sees the project, your previous message and the agent's last reply |
| `itemGist` | `RECALL_ITEM_GIST` | `false` | show the judge each statement's gist (no measured benefit) |
| `noRepeat` | `RECALL_NO_REPEAT` | `true` | a statement injected earlier in a session is never injected again in it |
| `hubMaxSessions`, `hubWindowDays` | `RECALL_HUB_MAX_SESSIONS`, `RECALL_HUB_WINDOW_DAYS` | `3`, `14` | a statement injected into this many other sessions within this many days is not injected again; 0 sessions = off |
| `pipeline` | `RECALL_PIPELINE` | `default` | retrieval pipeline (see [docs/pipelines.md](docs/pipelines.md)) |
| `embThreshold` | `RECALL_EMB_THRESHOLD` | `0.35` | cosine needed with the `embeddings` pipeline |
| `minChars` | `RECALL_MIN_CHARS` | `20` | shortest statement indexed |
| `timeoutMs` | `RECALL_TIMEOUT_MS` | `20000` | the hook's own deadline (inside the host's 28 s) |
| `autoIndex`, `autoIndexMinutes` | `RECALL_AUTO_INDEX`, `RECALL_AUTO_INDEX_MINUTES` | `true`, `30` | background `recall index --enrich` after prompts |
| `homes` | `RECALL_HOMES` | `[]` | extra agent homes to read: a path, or `{"path", "kind"}` for a home read for indexing only (see Homes; environment: paths separated by `:`, or a JSON array) |
| `claudeHome`, `codexHome` | `RECALL_CLAUDE_HOME`, `RECALL_CODEX_HOME` | none | pin the home the card writer runs under |
| `workerTimeoutMs` | `RECALL_WORKER_TIMEOUT_MS` | `120000` | CLI worker timeout |
| `allowHeadless` | `RECALL_ALLOW_HEADLESS` | `false` | allow the hook in non-interactive sessions (smoke tests only) |
| `noCache` | `RECALL_NO_CACHE` | `false` | bypass the answer caches (for latency measurements) |
| `openaiBaseUrl` | `RECALL_OPENAI_BASE_URL` | `https://api.openai.com` | endpoint root (a proxy; the test suite points it at a local fake) |
| `ownerEmails` | `RECALL_OWNER_EMAILS` | `[]` | your addresses. When set, a statement containing anyone else's address is not indexed; when empty that rule does nothing |
| `ownerNames` | `RECALL_OWNER_NAMES` | `[]` | your sender names. When set, an agent-delivered `[repo] sender: text` message from another sender is not indexed; when empty that rule does nothing |
| `filterProfiles` | `RECALL_FILTER_PROFILES` | `[]` | extra filter sets; `["fleet"]` is described below |
| `dropPatterns` | `RECALL_DROP_PATTERNS` (JSON array) | `[]` | regular expressions (case-insensitive): a typed turn matching one is not indexed |
| `homesRoster` | `RECALL_HOMES_ROSTER` | none | optional fleet roster, below |
| `usageCmd` | `RECALL_USAGE_CMD` | none | optional usage command for routing workers, below |
| `usageTtlMs`, `usageMaxPercent` | `RECALL_USAGE_TTL_MS`, `RECALL_USAGE_MAX_PERCENT` | `120000`, `90` | usage routing: cache lifetime; drop a home at or above this percent of any window |

Every turn's log line records the effective caps, pipeline, `k` and behaviour settings with where each came from (`env`, `file` or `default`), and, beside the statements they kept out, the four precision settings (and, with the apply gate on, its two settings).

### Precision rules

Four eligibility rules, on by default, keep out the statements that a live audit found most often misleading (38% of the injected cards were). They are applied where `excludeKinds` and the scope filter are, to the whole history before ranking, so a statement they keep out is never a candidate and the next eligible one takes its slot.

- **RG** (`excludeNewSessionGist`): the card's gist is the new-session placeholder (`gist_source: "none"` in `cards.jsonl`). Session-opening messages are one-off task briefs; 65% of the cards from them were misleading.
- **RU** (`excludeCitations`): the statement cites a URL, a local port or a file path (`https://`, `http://`, `127.0.0.1`, `localhost`, `:` and four or five digits, a home-directory path, `~/`, or a name ending `.ts` `.js` `.mjs` `.md` `.json` `.tsx`).
- **R5** (`crossRepoMaxChars`): the statement was said in another repo than the session's and is 300 characters or longer.
- **R4v** (`ruleMaxChars`): a card of kind `rule` or `preference` whose statement is 500 characters or longer.

A limit counts characters of the statement and keeps out a statement at the limit itself; `0` switches the rule off. A statement that several rules would keep out is counted once, under the first in the order above. The rules narrow the card filter, so with `excludeKinds` empty and `scopeFilter` off (the v1 values) there is no filter and no rule. `recall query --any-repo` also lifts R5. Evidence: over 274 labelled messages, offline, the four together cut the messages carrying a misleading card by 10.2 points (95% interval -15.0 to -5.5) and left the share with a useful card unchanged (-0.7, -4.4 to +2.6); see [docs/evidence.md](docs/evidence.md). To switch all four off:

```json
{ "excludeNewSessionGist": false, "excludeCitations": false, "crossRepoMaxChars": 0, "ruleMaxChars": 0 }
```

Each prompt's log line says how many statements each rule kept out (`excluded`, per reason: `gist-placeholder`, `cites-location`, `cross-repo-long`, `long-directive`, each with its count and the newest 50 ids), and `recall logs` and the monitor's detail view show them.

### The apply gate

After the judge and every eligibility rule, Recall asks one more question about each statement that is still a candidate for injection: "Does this past owner statement apply to the task the assistant is doing right now, not just the same topic?" The statement is shown with the gist of what was going on when it was said (`Past owner statement (said while <gist>): "<text>"`), over the same situation text as the first question, all in one request. The survivors are reranked by that probability and the first `k` at `applyThreshold` (0.2) or more are injected. It is a precision gate, not a fallback: a refused or unanswered question cannot pass, and if the hook's deadline (`timeoutMs`), the spend cap or the API stops it before it answers, nothing is injected at all (a loud log line, reason `apply-gate-failed`), never the survivors in their old order. It shares the question cache and the spend cap with the first question and is expected to add about $0.00014 and 260 ms per query. `noRepeat` and the hub rule still apply first, so a repeat or a hub is neither asked about nor injected; a statement that was asked about and not injected is not counted as told. The gate needs the statement cards (they supply the gist); with the card filter off a statement with no card cannot pass it.

Evidence (experiment x10, offline, 757 labelled statement-message pairs): this question separates useful from misleading statements with AUC 0.75 (95% interval 0.71 to 0.79) where the first question's probability gives 0.53 (0.49 to 0.58). Tuned on 160 messages and tested on 114 others: the share of messages that carry a misleading card fell from 45.6% to 25.4% (-20.2 points, interval -28.9 to -12.3), the share of injected cards that were useful rose from 33.9% to 47.0%, and the share of messages that carry a useful card did not change measurably (-2.6 points, interval -8.8 to +3.5). Switch it off with `{ "applyGate": false }` (or `RECALL_APPLY_GATE=0`); `applyThreshold` moves the bar (higher = fewer, surer cards).

Each prompt's log line records, under `applyGate`, every survivor's apply probability (three decimals; `null` = no answer) and whether it reached the bar, the counts, the cost and the time (at most 50 survivors per line), and `recall logs` and the monitor's detail view show them. `recall query` and `recall eval` replay the ranking and the first question only; they do not run the gate.

### Many accounts and agent fleets (optional)

None of this is needed for one person with one account.

- **Worker routing.** By default the card writer runs `claude -p --model haiku` (or `codex exec`) under the current host's own home and environment; no usage command is needed. If you spread work over several accounts, set `usageCmd` to a command that prints usage as JSON when run with `--json`, `{"results": [{"path": "<home>", "kind": "claude|codex", "windows": [{"label": "1w", "usedPercent": 40, "elapsedPercent": 50}]}]}`: Recall then considers every home it found (and `homes`), drops one that has no row, an `error`, `needsAuth` or a window at `usageMaxPercent`, and uses the one with the most headroom.
- **Roster.** `homesRoster` names a `.json` file (or a `.mjs` module exporting `CONTROL_USAGE_HOMES`) of `{"id", "kind": "claude|codex", "home", "protected", "manual"}` entries. With a roster, only the homes it lists are read, and only entries with `protected: false` and `manual: false` may run a worker. A roster that cannot be read is an error.
- **Fleet filter profile.** Where agent orchestration tooling writes briefs, relays, dispatch headers and probes into transcripts as if you had typed them, `"filterProfiles": ["fleet"]` drops those shapes (and peels a few labels and dumps; see `scripts/lib/text-filter/fleet.mjs`), and `ownerNames` tells it which sender names are yours. `docs/examples/fleet-config.json` is a complete example of these options together.

## How it works with each host

- **Claude Code and Codex** share `hooks/hooks.json`, `scripts/` and `skills/`: `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` are the two manifests, `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` the two marketplaces. Details of each host's hook contract, transcript format and quirks are in [docs/hosts.md](docs/hosts.md).
- **Every Code** has no plugin system; add a project hook to `~/.code/config.toml`:
  ```toml
  [[projects."/abs/path".hooks]]
  event = "user.prompt_submit"
  run = ["node", "/abs/path/to/plugin-recall/scripts/user-prompt-submit.mjs"]
  timeout_ms = 28000
  ```
  The script detects `CODE_HOOK_PAYLOAD` and prints plain stdout for context. This adapter is unit-tested only.
- **Non-interactive sessions are silent.** The hook demands positive evidence of a person at a keyboard (`claude -p`, the Agent SDK, `codex exec`, sub-agents, Codex's internal memory agent and anything it cannot classify get nothing, no API call). Every silenced turn is logged with its reason. `RECALL_ALLOW_HEADLESS=1` re-enables the hook for a deliberate smoke test.

## Files, logs and the monitor

Everything is under the data dir (`~/.plugin-recall` unless `RECALL_DATA` is set; layout in [docs/design.md](docs/design.md)). Many hook processes run at once, so appends are single `O_APPEND` writes or happen under stale-recovering lock files, and a request's cost is reserved under the ledger lock so two hooks cannot both take the last cents of the cap.

- `logs/turns-YYYY-MM-DD.jsonl` (UTC date): one line per hook invocation, injected or silent: `host`, `home`, `cwd`, `project`, `transcript`, `session_id`, `outcome`, the silence `reason`, the situation searched with, the top 20 candidates with scores and each one's kind, scope, gist and source (`src`), the statements the precision rules kept out (`excluded`) and their settings, the injected ids and the exact block, latency and cost. Silence reasons you will see: `headless:*`, `unknown:*`, `cap-reached`, `disabled`, `child`, `subagent`, `not-owner-text:*` (a harness turn, a too-short message ...), `empty-index`, `no-cards`, `nothing-above-threshold`; failures are `level:"error"` with `retrieval-failed`, `config-invalid` or `hook-crashed`. `recall show` runs add `event:"show"` lines (see `recall show`).
- `recall logs [--day YYYY-MM-DD | --days n] [--json]` counts them; `jq` over the file answers anything else, for example `jq -r 'select(.outcome=="injected") | .context' logs/turns-$(date -u +%F).jsonl` prints the blocks as the agent saw them.
- `recall monitor` is a live read-only web view of all this; see Monitor below.

## Monitor

`recall monitor` is a live, read-only web view of what the hook is doing, for watching Recall work while you use the computer. It is a small Node server with no dependencies; it never opens a browser or takes focus.

```bash
recall monitor                       # http://127.0.0.1:4777/
recall monitor --port 4800           # another port (--port 0 picks a free one)
```

Open the printed address yourself; stop it with Ctrl-C. It reads the data dir and **never writes there**, makes no API calls and costs nothing; it binds to loopback only, answers only requests whose `Host` header names this machine, and serves only GET. The page shows one card per turn (time, host, home, project, what you wrote, a chip for what the hook did, latency and cost), a detail view with the situation sent to the judge, the top 20 candidates with kind, scope, gist, source (`~/…jsonl:L123`, the transcript line the statement came from) and judge probability, and the exact injected block, counters for the UTC day the cap counts (including context lookups by agents, the `recall show` runs), spend by hour, an "Agent looked up context" list (the latest eight `recall show` runs), active sessions and the index size, with filters for host, home and period. Light and dark follow the system; it works at phone width. Every reason a hook can write has plain-language wording in `scripts/monitor/reasons.mjs`.

## Failure behaviour

A timeout, an API error or a crash means no injection and a loud entry (`level:"error"` in the turn log and a line on stderr); the hook prints the host's "continue" output so the host is never blocked. Nothing is invented. With no cards yet the hook logs `no-cards` and says nothing (and starts the background index, which writes them).

## Development

```bash
npm test                      # node --test, no network, no paid call
claude plugin validate .
npm pack --dry-run
```

Tests use synthetic transcript lines that mirror the real formats (`test/fixtures`, see its README), a deterministic in-process or local-HTTP fake of the two OpenAI endpoints, and stand-in `claude` and `codex` executables. `test/publish-readiness.test.mjs` fails if anything specific to one person's machine or fleet shows up in a tracked file. The method and measurements behind the defaults are in [docs/evidence.md](docs/evidence.md); the pipelines in [docs/pipelines.md](docs/pipelines.md).

## Limits

- The measurements are from one developer's history, with selection on the evaluation set; the defaults of the current release have not been evaluated end to end (see [docs/evidence.md](docs/evidence.md)). Treat Recall as an experiment: the prompt gate is weak, so expect most injected statements to be only loosely relevant on a prompt where nothing was said before.
- Cards are written once by a model, without gold labels: it can call a directive a question or scope a global rule to its repo. The filters trade recall for noise, and nothing measures how often a needed statement is lost.
- Excluding the live session's visible statements means a statement from earlier in the same long session is never recalled, until the host compacts it away.
- Repo identity for a directory that no longer exists falls back to a path rule (the last path segment, with worktree layouts unwrapped), so statements typed in deleted checkouts can land under an odd repo name; `repoAliases` maps names together.
- Whether a session is automated is inferred from host signals; one Recall cannot classify is silent.
- Codex plugin loading and the Every Code adapter were not exercised end to end.

## Upgrading

**From 0.4.x or earlier:** run `npx -y @just-every/plugin-recall` once. It repoints the `plugin-recall` marketplace of every home at its own versioned copy and updates the plugin there; a hook you already approved in Codex stays approved, and your index and cards are kept. An earlier `--source` install is replaced the same way.

**From 0.2.x:** a `config.json` that still has a removed key is **invalid** and makes the hook silent until the key is removed: `ownerEmail` (now `ownerEmails`, a list), `directiveOnly` (replaced by `excludeKinds` in 0.2) and the keys of the removed Stop hook (`stopPipeline`, `stopThreshold`, `stopCandidates`, `stopVerify`, `stopVerifyMax`, `stopMinChars`, `stopInjectThreshold`). If you used a fleet roster, see "Many accounts and agent fleets". Run `recall doctor` afterwards.

## License

MIT, see [LICENSE](LICENSE). Changes are in [CHANGELOG.md](CHANGELOG.md).
