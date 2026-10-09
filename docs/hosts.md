# Recall and its hosts: Claude Code, Codex, Every Code

What Recall relies on in each host: how a plugin and its hook are loaded, what the hook receives, what transcripts look like on disk, how a person at a keyboard is told from an automated worker, and how context compaction is handled. The formats were observed on Claude Code 2.1.287 to 2.1.293, Codex CLI 0.147 to 0.160 and Every Code 0.6.74. Each fact was either run against the real binary in a scratch directory, read from the host's source or schema, or taken from its documentation. The test fixtures in `test/fixtures` are synthetic lines that mirror these formats.

## 1. Findings that shaped the design

1. **Codex ignores `timeoutSec`.** A hook handler with `timeoutSec=1` that sleeps 3 s ran to completion; the same handler with `timeout=1` was killed. The field is `timeout` (seconds), default 600 for every event except SessionEnd. Recall's `hooks/hooks.json` uses `timeout`.
2. **Claude's `UserPromptSubmit` default timeout is 30 s** (other events 600 s). Recall sets `"timeout": 28` explicitly and its own deadline (`timeoutMs`, 20 s) is inside it.
3. **The prompt is the field `prompt`** in the hook input of both Claude Code and Codex (the Claude docs example says `user_prompt`).
4. **Session-scoped loading exists for both hosts without touching real config**: `claude --plugin-dir <dir>`, and `codex exec -c 'hooks.UserPromptSubmit=[...]' --dangerously-bypass-hook-trust` (inline hooks, no plugin install).
5. **Mid-turn typed messages in Claude are not `type:"user"` records.** They are `attachment` records of type `queued_command` with `origin.kind:"human"`. A miner that only reads `type:"user"` misses them.
6. **Every Code (`coder`) has no plugin system**; it has project hooks in `config.toml` with a different shape (section 2.4). Codex plugins do not load there.

## 2. Plugins and hooks

### 2.1 Layout shared by both hosts

```
plugin/
  .claude-plugin/plugin.json     only "name" is required (kebab-case; "claude-" and "anthropic-" prefixes are reserved)
  .claude-plugin/marketplace.json
  .codex-plugin/plugin.json      name, version, description, author, homepage, repository, license, keywords, "skills": "./skills/",
                                 interface{displayName, shortDescription, longDescription, developerName, category, capabilities,
                                 defaultPrompt, brandColor, websiteURL}
  .agents/plugins/marketplace.json   the Codex marketplace
  hooks/hooks.json               read by both hosts from the plugin root
  skills/<name>/SKILL.md         read by both hosts (name and description in the frontmatter)
  bin/                           put on the Bash PATH by Claude Code
```

`hooks/hooks.json` has the same wrapper in both hosts: `{"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "...", "timeout": 28, "statusMessage": "..."}]}]}}`. Codex's top level is `deny_unknown_fields` (only `description` and `hooks`). Handler fields: `type` (`command`), `command`, `commandWindows`, `timeout` (seconds), `async`, `statusMessage`, `additionalContextLimit`.

The shared command is `node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/user-prompt-submit.mjs"`: Claude exports only the `CLAUDE_` names to plugin hooks, Codex exports both spellings.

### 2.2 Claude Code

- Install: `claude plugin marketplace add <path>`, then `claude plugin install recall@plugin-recall`; `claude plugin enable|disable|uninstall|update`, `claude plugin marketplace update|remove`; every command takes `--json` and prints one JSON line last with `"outcome": "ok"` on success. Validate with `claude plugin validate <dir>`. State: `<home>/plugins/installed_plugins.json` (`{"version": 2, "plugins": {"recall@plugin-recall": [{"scope": "user", "installPath", "version", ...}]}}`), `<home>/plugins/known_marketplaces.json` (`{"plugin-recall": {"source": {"source": "directory", "path"}, "installLocation"}}`) and `settings.json` (`enabledPlugins`, `extraKnownMarketplaces`). A plugin from a directory marketplace was loaded in place from that directory on 2.1.287; on 2.1.295 `installPath` is a copy in `<home>/plugins/cache/<marketplace>/<plugin>/<version>/`. Either way a change reaches a home only with a new version (or a reinstall), and Recall's installer never edits a version directory in place. `claude plugin marketplace remove` uninstalls the marketplace's plugins and deletes their data; re-adding a marketplace of the same name from another source repoints it and keeps what is installed. With `CLAUDE_CONFIG_DIR` unset the home is `~/.claude` and its `.claude.json` lives beside it in the home folder.
- Homes are profile directories (`CLAUDE_CONFIG_DIR`, default `~/.claude`). The plugin's data directory is `<home>/plugins/data/<id>/`; Recall does not use it (its data is shared by every home, see the README).
- `UserPromptSubmit` input: `{session_id, transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, hook_event_name, prompt}`. Environment: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`.
- Output: `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`. Plain stdout is also taken as context; `{"decision":"block"}` or exit 2 blocks the prompt (Recall never blocks).
- Hooks also run inside sub-agents and inside `claude -p` children with the same input and no field saying "this is a child", so the recursion guard is the environment (`RECALL_CHILD=1`) and `--settings '{"disableAllHooks":true}'` on the child.

### 2.3 Codex

- Install: `codex plugin marketplace add <path>`, then `codex plugin add recall@plugin-recall`; `codex plugin remove`, `codex plugin marketplace remove`; with `--json` the result is a pretty-printed JSON object (stderr may carry "Refusing to create helper binaries under temporary dir", which is not an error). Codex **copies** a plugin to `<home>/plugins/cache/<marketplace>/<plugin>/<version>/` and never refreshes the bytes of a version it has, so only a new version reaches a home. `config.toml` gets `[marketplaces.<name>]` with `source = "<path>"` and `[plugins."<plugin>@<marketplace>"] enabled = true`. A marketplace cannot be re-added from a different source ("already added from a different source; remove it before adding this source"); removing it keeps the `[plugins.*]` entry and the hook trust entry. `codex plugin add` re-enables a disabled plugin and swaps the cached version. Codex refuses a `CODEX_HOME` that does not exist. `[features] hooks` must not be `false`.
- Hooks of a plugin must be **trusted**. The state lives in `config.toml` as `[hooks.state."<plugin>@<marketplace>:hooks/hooks.json:<event>:<group>:<handler>"]` with a `trusted_hash`. The first interactive session asks; `codex exec --dangerously-bypass-hook-trust` skips it for one run. `recall doctor` reports whether a trust entry exists.
- `UserPromptSubmit` input: `{session_id, turn_id, transcript_path | null, cwd, hook_event_name, model, permission_mode, prompt, agent_id?, agent_type?}`. `agent_id` appears only for sub-agent turns. `transcript_path` is null under `--ephemeral`.
- Output: `{"continue":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`; plain non-JSON stdout is also context; anything that starts like JSON but is invalid marks the hook failed. Context over about 2500 tokens (`additionalContextLimit`) is spilled to a temp file and replaced by a preview, so the injected block stays short.
- Workers: `codex exec --disable hooks` suppresses hooks entirely (`--ignore-user-config` alone does not: inline `-c` hooks still run), so a Recall worker passes `--disable hooks` and the `RECALL_CHILD=1` environment flag.

### 2.4 Every Code

No plugin loader. Hooks are project config in `~/.code/config.toml`:

```toml
[[projects."/abs/path".hooks]]
event = "user.prompt_submit"
run = ["node", "/abs/path/to/recall/scripts/user-prompt-submit.mjs"]
timeout_ms = 28000
```

The payload arrives in the environment variable `CODE_HOOK_PAYLOAD` (JSON with `event, session_id, turn_id, transcript_path, cwd, model, prompt`; also `CODE_HOOK_EVENT`, `CODE_SESSION_CWD`). Output is not JSON: non-empty **stdout** of `user.prompt_submit` is injected raw as developer context, and exit 2 with stderr blocks. Rollouts live in `~/.code/sessions/YYYY/MM/DD/rollout-*.jsonl`, with the same record shapes as Codex. `scripts/user-prompt-submit.mjs` handles this payload; the adapter is unit-tested, not run inside `coder`.

### 2.5 What the installer runs in each home

`npx -y @just-every/plugin-recall` copies the running package into `<data>/marketplace/plugins/recall-<version>/` and writes both marketplace files there (`.claude-plugin/marketplace.json` with `source: "./plugins/recall-<version>"`, `.agents/plugins/marketplace.json` with `{"source": "local", "path": ...}`), then runs each home's own CLI, four homes at a time, each with only its home variable set (`CLAUDE_CONFIG_DIR=<home>`, left unset for `~/.claude`; `CODEX_HOME=<home>`) and no API key or token in the environment:

| Home's state | Claude Code | Codex |
|---|---|---|
| new | `marketplace add <M>`, `install recall@plugin-recall` | `marketplace add <M>`, `add recall@plugin-recall` (a missing `~/.codex` is created 0700 first) |
| older version | `marketplace update plugin-recall`, `update recall@plugin-recall` | `add recall@plugin-recall` |
| this version from another marketplace | `marketplace add <M>`, `marketplace update plugin-recall`, `update recall@plugin-recall` | `marketplace remove plugin-recall`, `marketplace add <M>` (and `add` when the cache lacks this version) |
| disabled | `install recall@plugin-recall` | `add recall@plugin-recall` |
| up to date | nothing | nothing |
| another `recall@<x>` installed | nothing; the home is left alone | nothing; the home is left alone |

After the commands it reads the host's files again and fails that home (only that home) unless they show this version, enabled, from `<M>` (for Codex: the cache directory of this version). It never writes hook trust: the summary asks the person to approve the hook once per Codex home. `recall uninstall` runs `uninstall` (Claude) or `remove` (Codex) and then `marketplace remove plugin-recall` in each home that has Recall's copy or marketplace. After that it removes `<home>/plugins/cache/plugin-recall` when the host left it holding only empty folders (Codex does), or, for Claude Code, when every version folder in it carries `.orphaned_at` (Claude Code marks a replaced or removed plugin's cached copy that way and deletes it itself later). A Claude Code cache with an unmarked copy is left to the host, and the uninstall summary says so.

### 2.6 Trying the plugin in one session without installing

```bash
# Claude Code: for this session only; nothing is installed
RECALL_ALLOW_HEADLESS=1 claude -p --plugin-dir /path/to/plugin-recall --no-session-persistence --model haiku 'prompt' < /dev/null

# Codex: plugins load only from the plugin cache, so use inline hooks for a one-process test
RECALL_ALLOW_HEADLESS=1 codex exec --ephemeral --dangerously-bypass-hook-trust \
  -c 'hooks.UserPromptSubmit=[{hooks=[{type="command",command="node /path/to/plugin-recall/scripts/user-prompt-submit.mjs",timeout=30}]}]' 'prompt' < /dev/null
```

Not testable this way: Codex plugin discovery, the trust flow, the loader's `${PLUGIN_ROOT}` expansion and `.codex-plugin/plugin.json` parsing. Those need a real `codex plugin add`.

## 3. Transcript formats

Recall reads transcripts as streams (never slurping a file: a Codex rollout reaches hundreds of megabytes with single lines of several megabytes), skips dot-directories, never follows a symlink out, and never opens a path that names credentials (`secrets`, `.ssh`, `auth.json`, `.credentials.json`, `.env`, anything containing `token`).

### 3.1 Claude Code: `<home>/projects/<cwd, every character but a letter or a digit as "-">/<session-uuid>.jsonl`

Record `type` values seen: `user`, `assistant`, `attachment`, `system`, `queue-operation`, `custom-title`, `last-prompt`, `agent-name`, `file-history-*`. Sub-agent transcripts are separate files (`<session>/subagents/agent-<id>.jsonl`) whose records carry `isSidechain:true` and `agentId`; their first `user` record is the parent's brief.

`type:"user"` records by discriminator (Claude 2.1.28x):

| Case | Signals | Typed by a person? |
|---|---|---|
| typed message | `message.content` a string (or `[image, text]`), `origin:{"kind":"human"}`, `turnOrigin:"human"` | yes |
| tool result | `content` list containing `tool_result` | no (the largest class) |
| task notification | string starting `<task-notification>`, `origin.kind:"task-notification"`, `promptSource:"system"` | no |
| peer agent message | `origin.kind:"peer"`, `isMeta:true` | no |
| skill body or slash expansion | `isMeta:true`, `<command-message>` or "Base directory for this skill:" | no (but `<command-args>` carries the typed text) |
| programmatic `claude -p` prompt | `origin` absent, `promptSource:"sdk"`, `entrypoint:"sdk-cli"` | no |
| compaction summary | `isCompactSummary:true`, "This session is being continued from a previous conversation" | no |
| interrupt marker | "[Request interrupted by user]" | no |

So the clean rule is `type==="user" && !isSidechain && !isMeta && origin.kind==="human"`, then the text filter peels `<system-reminder>` and the like. The Claude desktop app sends a reply to a passage of an earlier message as a typed turn that starts with `<!-- reply -->` (`<!-- reply 2 -->`; `<!-- attach -->` for an attached passage), the passage as `>` quoted lines, a blank line, then what was typed; one turn can carry several. The markers and the quoted lines are peeled and the other lines kept (`scripts/lib/text-filter/desktop.mjs`); any other turn that starts with `<!--` is still dropped as harness. Older transcripts lack `origin`; the text rules decide those. A message typed while the agent is working is `{"type":"attachment","attachment":{"type":"queued_command","prompt":"...","origin":{"kind":"human"},"humanTurn":true}}` and is read too. A session whose working directory is a temp directory (`/private/var/folders/...`, `/tmp/...`) is a program's worker, not a person.

### 3.2 Codex: `<home>/sessions/YYYY/MM/DD/rollout-<ts>-<thread uuid>.jsonl[.zst]` and `<home>/archived_sessions/`

Records are `{timestamp, ordinal?, type, payload}`. Types: `session_meta` (line 1: `id`, `cwd`, `originator`, `cli_version`, `source`, `thread_source`, git info), `turn_context`, `response_item` (payload types `message`, `reasoning`, `function_call*`), `event_msg` (payload types `item_completed`, `task_started`, `task_complete`, `token_count`, ...), `compacted`, `world_state`.

- `response_item` `message` with `role:"user"` is polluted: it carries `# AGENTS.md instructions ...`, `<environment_context>`, `<recommended_plugins>`, `<user_instructions>`, `<skill>`, `<image ...>`, `## My request:` envelopes and `<realtime_delegation>` wrappers.
- **The clean signal** is `event_msg` with `payload.type:"item_completed"` and `payload.item.type:"UserMessage"` (`item.content[]` of `{type:"text",text}`): what the UI treats as a user turn. Recall uses it when a rollout has any, and falls back to the `response_item` copies (peeled by the text filter) for older rollouts that have none.
- **Whose session it is** is in `session_meta`: `thread_source:"user"` with `source` `cli` or `vscode` is an interactive session; `source:"exec"` or `originator:"codex_exec"` is `codex exec` (a program's prompt); `thread_source:"subagent"` (with `source` an object) is a spawned sub-agent; `security_scan` is an automated scan. Only interactive sessions are mined.
- Every Code rollouts follow the same `session_meta` / `response_item` shape (`source:"cli"`, `originator:"code_cli_rs"`), wrapped in `event` records.
- **Archived threads.** Archiving a thread moves its rollout, under the same file name, from `sessions/YYYY/MM/DD/` to `<home>/archived_sessions/` (flat). Both directories are read. A statement's id is a hash of host, time and text, never of the path, so a move changes no id and orphans no card (cards are keyed by id). The scan state is keyed by path: a rollout with no state whose name the state still holds at a vanished path of the same home has moved, takes that state over (an unchanged file is not opened, a grown one is read from its offset) and the statements whose `src` names the old path are pointed at the new one. A rollout present in both directories is read once (the copy the state knows, else the larger, else the live one).
- **Legacy rollouts** (Codex CLI of mid 2025) have no `session_meta`. Line 1 is a bare header `{id, timestamp, instructions, cwd?, model?, git?}`; then `{"record_type":"state"}` markers and bare response items (`{"type":"message","role":"user","content":[...]}`, `{"type":"function_call",...}`) with no `payload` wrapper and no timestamp. Nothing in the file says who started it, so the typed-prompt log decides (section 3.3): the TUI appends every prompt submitted at it to `history.jsonl` under the session id and `codex exec` never does, so a legacy rollout whose session a log names is an interactive session and any other one a program's (`legacy-not-typed`). On one archive of 324 legacy rollouts the 275 named by its log held 1,143 of the 1,151 user messages; the 49 others held 8, each a brief a program wrote. Each turn is dated with the header's `timestamp`, the session's start: the records carry no time.
- **The Codex app's envelope.** The desktop app (and the IDE extension) sends a turn as the context it attached, in top-level sections, then its own heading `## My request for Codex:` (`## My request:` in earlier versions) and what was typed under it. The sections seen: `# Files mentioned by the user:` (`## <name>: <path>` per file or screenshot), `# Applications mentioned by the user:` (an `<appshot>` accessibility tree), `# In app browser:` or `# In app browser (IAB):` ("The user has the in-app browser open with 1 tab.", "Current URL: ..."), the same state as an `<in-app-browser-context>` block that says it is not part of the request, `# Selected text:` (`## Selection N`), `# Response annotations:` (a `<response-annotations>` JSON block), `# Review findings:` (`## Finding N (<file>:<lines>)`), and `# Browser comments:` / `# Diff comments:` (`## Comment N` or `## User Comment N` with `File:`, `Lines:`, `Node position:`, `Target:` ... and `Comment:` followed by what was written). The text filter keeps every `Comment:` of the comment sections and the text under the request heading, and drops the rest; an envelope with neither is dropped as `envelope`. The review command's turn (`## Code review guidelines:`, `# Review guidelines:`, `## Output schema ...`, then `## My request for Codex:`) is the app's from end to end: its request was one canned line in 21 of the 22 measured, so the whole turn is dropped as harness.
- **Every Code's own turns.** Its review loop writes user turns into the session: the reviewer's output relayed as `<user_action> <context>User initiated a review task...`, the check `You are evaluating whether the latest fixes resolved the findings ...`, and the handoff `You have permission to commit and push. Repository snapshot: ...`; all three are dropped as harness. Its 2025 multi-agent commands (`/plan`, `/code`, `/solve`) expanded into a long prompt for the agents (`Create a comprehensive plan by leveraging multiple state-of-the-art LLMs ...` ... `Task to plan:`, and likewise `Coding task to perform:`, `Problem to solve:`); only the task after the last heading is kept.

### 3.3 Typed-prompt logs: `<home>/history.jsonl`

Each host appends one row per prompt a person submits at its prompt; a program's prompt (`codex exec`, `claude -p`) is never written there. The log outlives the transcripts: Claude Code deletes transcripts after its retention period, rollouts get archived or deleted, and a copied home may hold the log alone.

| Host | Row |
|---|---|
| Codex, Every Code | `{"session_id", "ts", "text"}`, `ts` in unix seconds; slash commands are rows too (`/status`, `/plan <task>`) |
| Claude Code | `{"display", "pastedContents", "timestamp", "project", "sessionId"}`, `timestamp` in ms, `project` the working directory; `sessionId` is missing in older rows; a paste shows in `display` as `[Pasted text #1 +5 lines]` and its text is `pastedContents["1"].content` |

Recall reads the log after the transcripts and skips a row whenever a transcript already yields it: for Codex and Every Code when its session has a rollout in `sessions/` or `archived_sessions/` of any home read (whatever that rollout's verdict), for Claude Code when an indexed transcript statement of the same project directory has the same normalized text. Everything else goes through the same owner and text rules as a transcript turn (a Claude row in a temp directory is a program's, as a transcript there is). A slash command keeps what was typed after it (as a transcript keeps `<command-args>`), a paste is put back in place. Every Code also records its own notices in the log as if they were typed (`System: access mode changed to ...`, `System: Working directory changed from ...`, `Finalize branch '<branch>' via ...`, `Auto-resolve status check`, `[developer] Background auto-review ...`); they are dropped as harness. The statement's `src` is `<log>:L<line>`, its session the row's, its time the row's; its repo is the Claude row's `project`'s, and a Codex or Every Code row has none. A row younger than 10 minutes waits for the next pass, because its session's transcript may not be on disk yet. A card's context is the previous row of the same session (no assistant reply: `gist_source` `history`), and `recall show` shows the rows of the session around the statement.

## 4. Telling a person from an automated worker

Hook payloads carry no field that says whether a person is at the keyboard, and automated workers (`claude -p`, the Agent SDK, `codex exec`, Every Code exec, Codex's internal memory agent) run through the same homes as interactive sessions. Recall's hook is silent for everything that is not a person (`scripts/lib/headless.mjs`), and demands positive evidence: "cannot tell" is silent too.

**Claude Code: `CLAUDE_CODE_SESSION_ATTENDED`, not the entrypoint.** Transcript records carry `entrypoint`, but `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_CHILD_SESSION` are inherited by child processes: a `claude -p` run from the Bash tool of a desktop session records `claude-desktop` in its own transcript. Claude Code sets `CLAUDE_CODE_SESSION_ATTENDED` in the environment of every process it spawns (hooks included): `1` for an interactive terminal session or an IDE or desktop host that is not itself a child session, `0` for print mode, the Agent SDK and anything started from inside another Claude session. `CLAUDE_CODE_HOST_SCHEDULED_RUN` marks a scheduled run. At the first prompt of a session the transcript file does not exist yet, so the transcript is only a second opinion: the newest user record being a program's prompt (`entrypoint` `sdk-*`, or `turnOrigin:"sdk"` without a human `origin`) silences even an attended environment. Without the variable (an older Claude Code) a human-origin transcript record is required, and the first turn is "unknown".

**Codex: line 1 of the rollout.** The hook payload has `transcript_path`; its first line is `session_meta`. Interactive means `thread_source:"user"`, `source` `cli` or `vscode`, originator not `codex_exec`. `codex exec --ephemeral` and Codex's internal memory-consolidation agent have a null `transcript_path` and so leave no evidence: `unknown:codex-no-rollout`. A Codex hook started from inside a Claude session inherits Claude's variables, so each host's hook reads only that host's evidence.

**Every Code:** the same rule on its rollout (no `thread_source`; `source` `cli` is interactive, `exec` is not); a null rollout is unknown.

Known gaps: a Codex rollout resumed in another mode keeps its first `session_meta`; Every Code's `exec` value was read from its source, not captured.

Every silenced turn is logged (`outcome:"silent"`, `reason:"headless:..."` or `"unknown:..."`, a small `signals` object, no query, no cost). `RECALL_ALLOW_HEADLESS=1` skips the check for a deliberate smoke test.

## 5. Context compaction

A compaction boundary does not mean your earlier words disappeared from the model's context. The hook excludes the statements still visible in the live session (so Recall never recalls the conversation in progress) and lets through those the host really dropped.

- **Codex:** a top-level `type:"compacted"` record whose `payload.replacement_history` lists the response items kept (`type:"message"`, `role:"user"`, text in `content[].text`). The **last** one replaces earlier carry-over. Its user text is whitespace-normalized, passed through the same envelope removal as indexing, and matched to the indexed statements.
- **Claude Code:** `system/compact_boundary` has `compactMetadata.preservedMessages.allUuids`; statements with those UUIDs remain visible even though their records precede the boundary. The paired `user/isCompactSummary` record is recognized by its UUID equalling `preservedMessages.anchorUuid` (its `parentUuid` can be an interstitial attachment), so it does not discard the set. A later boundary, or an unpaired summary, replaces the carry-over. Summary prose is never indexed.
- **Every Code:** the optional replacement-history field exists in its shared `Compacted` schema, but its writers persist none that can be decoded, so no retained set is claimed for it.

Record order wins over timestamps (Claude summaries can precede their boundary in timestamp order). With no boundary, the whole live session stays excluded. Indexed history no longer present in the transcript is located by the boundary timestamp and, for Codex, the retained text. The current prompt is excluded by normalized text even before it is written to the transcript. Read or parse failures are loud.

On one developer's history (about 700 sessions with a boundary and about 8,600 statements before their last boundary), roughly a quarter of the pre-boundary statements were genuinely invisible after compaction and therefore recallable; the rest were still carried in the resumed context.
