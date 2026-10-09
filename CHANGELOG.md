# Changelog

## 0.5.1

### Fixed
- The installer, the uninstaller and `recall doctor` no longer run `claude` and `codex` in the folder you started them from. Both hosts read their working directory as a project: Codex treats `<cwd>/.codex/config.toml` as a project config, so from your home folder `~/.codex/config.toml` made `CODEX_HOME=~/.codex_other` installs fail with "marketplace `plugin-recall` is configured in project (~/.codex/config.toml); remove it from that configuration source instead"; Claude Code treats `<cwd>/.claude/settings.json` as project settings, and `claude plugin marketplace remove` run from your home folder also edited `~/.claude/settings.json`, another home's file. Every host command now runs in a private empty temp directory (removed when `recall` exits), whatever the directory `npx -y @just-every/plugin-recall` was run from. The background summary writer setup starts runs from `~/.plugin-recall`.

### Changed
- The publish-readiness test scans `docs/examples/fleet-config.json` like every other tracked file (the example is generic).

## 0.5.0

One-line setup: `npx -y @just-every/plugin-recall` installs Recall into every agent home on the machine.

### Added
- `recall` (also `recall setup`, `recall install`) finds Claude Code and Codex and whether each is logged in (`claude auth status`, `codex login status`), lists every installable home (`~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, and sibling homes that carry the host's marker file), finds the OpenAI key in the environment or `~/.env` or asks for it with hidden input, checks it for free, shows one plan (the key it found, masked with its source, and saving it to `~/.env` included) and asks once. It asks at most two things: the key, only when none is found or with `--new-key`, and the go-ahead. Home numbers typed at the go-ahead leave those homes out; a left-out default home is still read for memory and the table says so, and a line under the table gives the `--homes` command that adds a left-out home back. The table also lists the homes that are only read (`~/.code`, or a host whose CLI is not installed).
- The Decisions API access check: one tiny request (less than $0.0001) before anything is installed; a key without access stops setup with nothing installed. Recorded by key fingerprint in `state/provider-checks.json`, shown by `recall doctor`.
- The key is saved to `~/.env` as part of the plan (the line is replaced or appended, every other byte kept, a symlink kept, mode kept or 0600), a key found only in the environment included, since hooks started by a desktop app do not see the shell's environment. Only `--no-save-key` leaves the file alone, and it is recorded (`state/key-choices.json`) so later runs keep leaving it alone; `--new-key` asks for a different key with hidden input and saves it in place of the one there.
- Installs go through each host's own CLI from a versioned copy of the running package in `~/.plugin-recall/marketplace` (`plugins/recall-<version>/` plus both marketplace files), so the installed plugin is exactly the version that was run, offline. A re-run with everything current asks nothing and writes nothing; a newer release updates every home in place; the previous copy is kept and older ones are removed.
- `~/.local/bin/recall`, a link to the installed copy's `bin/recall`.
- `recall uninstall [--yes] [--purge]` removes Recall from every home, then its copy and the command.
- Setup options `--homes`, `--exclude` (recorded in `state/installs.json`), `--new-key`, `--no-index`, `--skip-key`, `--no-save-key`, `--dry-run`; `--help` (also through npx, and `recall help`) prints the setup options and the everyday commands, every hint in the `npx -y @just-every/plugin-recall` form; `recall help --all` lists every everyday command with its options, wrapped at the terminal's width (the evaluation and research commands only with `RECALL_DEVELOPER=1`); `recall --version`.
- `scripts/lib/providers/`: the one place a model provider is declared (key name, how to check it, where to get one, the paid access check). OpenAI is the only entry.

### Changed
- The first index is built in the foreground with a progress line; the cards are written in the background (`logs/setup-enrich.log`) by the logged-in CLI, codex when claude is logged out.
- `--daily-cap` on a later run changes the cap (it was asked for and then ignored).
- `recall doctor` shows the key masked, the login of each CLI, whether the key's access was checked, homes left out at setup and other copies of Recall, with `~` paths everywhere and the same ✓ ! ✗ · markers as setup (coloured on a terminal); the Decisions access note is gone.
- Setup, doctor and the summary say what each step does rather than naming the mechanism ("Index what you typed", "Write short summaries with your claude CLI", "Check once that your key can pick what to bring back"); the Decisions API is named only where a key has no access to it. The summary has one doctor line, and gives the exact line that puts `~/.local/bin` on the PATH of the person's shell.
- A stop at the access check removes the folders the check made in `~/.plugin-recall`, so nothing is left behind.
- Setup's prose wraps at the terminal's width when it is narrower than 100 columns; a long path in a table gets its own line.
- The background card writer is not given `OPENAI_API_KEY`; it uses only its CLI's own login.
- Uninstall also removes the empty host cache folders of the `plugin-recall` marketplace, Claude Code's cached copies once every one is marked orphaned (else it says Claude Code deletes them), and the `~/.local/bin` it made; run when nothing is installed, it says where the data still is.
- Usage errors of setup, uninstall and doctor exit 2; `recall` with no command runs setup instead of printing the usage.

- Polish pass: a pasted key loses its quotes and `OPENAI_API_KEY=` before the shape check, and a key that starts with sk- but is too short is called a partial key; a rejected key is told without the HTTP code (which only `recall doctor` keeps), and when it is the key exported in the shell, setup says that variable wins over `~/.env` and must be removed, again in the Done block; the key step says it needs a key with Decisions API access, and a key without it gets one line on how to get access; the `--new-key` hint appears only after a key was rejected; "What leaves this machine" is shown the first time a key is used for sending (a `--skip-key` run says nothing leaves until a key is added); home numbers typed at the go-ahead leave those homes out and setup goes on without asking again; a partial failure prints the exact retry command; `recall pause` and `recall resume` replace hand-editing `config.json`; `recall uninstall --homes <list>` removes Recall from only those homes; uninstall names a missing CLI and how to install it; "cards" is gone from the stop messages, the plugin descriptions and the indexing progress line ("Indexing: N/N statements").

### Removed
- `recall setup --source` and the GitHub install commands.

### Index quality (from the 0.4.0 re-gate)

#### Changed
- An upgrade judges again every line that already holds a statement. When the backfill reads a file again, a statement the current rules reject is retired: taken out of `statements.jsonl` and written to `retired.jsonl` with the reason (its card stays in `cards.jsonl` but is never attached again). A statement the current rules read to another text is rewritten in place under its id, so its card survives, and its new text is embedded. The rules that judge a line by another source apply too (a Claude typed-prompt log row whose project's transcript holds its text is retired). The peel version is 2, so an index built by 0.4.0 gets this once (`rejudged` in the index report). A file whose backfill stops before a turn that must wait is backfilled again until it is read to the end. A file the scanner now rejects whole (a session that is not yours) has its statements retired with that verdict. When a pass reads a copy of a turn before the file whose statement holds it, the copy's new statement gives way, so the turn keeps its older id and card. The changes are written before the scan state, so a pass that dies in between judges the file again next time.
- One turn, one id, whatever the file is called: a Codex or Every Code rollout turn is the same turn when it has the same host, session and time (to the millisecond) and the same place among the turns of its file that share that time (messages queued while the agent worked are written under one time: statements carry it as `ts_seq`), so a resumed session written to a second rollout name and a `.jsonl.zst` copy in another home add no second id. Legacy rollouts and typed-prompt logs, whose times are coarse, still key on the line too.
- An Every Code Auto Drive run of 2025 ends at an idle gap of 3 hours: a typed row 3 hours or more after its session's previous row, and the session's rows after it, are yours again, up to its next `/auto` (a slash command after the gap is kept, but the run can go on after it, so it does not end the run). A row inside a run that carries an attached image (`[image: ...]`) is yours too. Known limit: the other interjections you typed during a run, minutes after the row before, cannot be told from the coordinator's prompts by time, and stay out (on one log, about 1 in 5 of the run rows still left out read as yours).
- The goal typed after `/auto` is indexed from the typed-prompt log when the session's rollout holds only Auto Drive's "Primary Goal:" wrapper, and skipped when a rollout statement already has its text.
- The context of a card for an Every Code rollout statement takes as the previous owner message only a turn the person typed (the same typed-row rule as the indexer), never an Auto Drive prompt or a host's canned request.
- A CLI worker is never placed on a home that `homes` lists as `{path, kind}`, even when it is pinned (`claudeHome`, `codexHome`) or is also a standard home.

#### Fixed
- Host prompts are not indexed as yours: Claude Desktop's auto-resume (the whole message "I hit my usage limit while you were working ... Please continue from where you left off." and its siblings), the `/init` prompt ("Generate a file named AGENTS.md that serves as a contributor guide ..."), Every Code's "command is not yet fully implemented" notice, and a row left with only a slash command after Every Code's `[branch created]` marker.
- `docs/examples/fleet-config.json` uses placeholder paths, names and addresses.

## 0.4.0

### Added
- Typed-prompt logs are indexed: `history.jsonl` in Codex and Every Code homes and in Claude homes. A row is skipped when the same session already yields the statement from a transcript. The source is the log's path:line, a card's context is the earlier rows of the same session, and `recall show` lists the neighbouring rows.
- Codex and Every Code `archived_sessions/` are read. A rollout that moves there keeps its scan state, ids and cards.
- Old Codex rollouts without a `session_meta` line are read. One counts as typed only when a `history.jsonl` names its session.
- Codex desktop-app envelopes ("## My request for Codex:") and Claude Desktop quote-replies (`<!-- attach -->`, `<!-- reply -->`) are peeled, so the owner's own text is kept instead of dropped.
- `homes` in config.json also takes `{path, kind}` entries. These are read for indexing only, and the CLI router never uses them.
- An index built by an earlier version gets the new peels once: a file whose scan state has no peel version is read again from the start, and only lines that hold no statement yet are admitted (`backfilled`, `backfillLinesKept` in the index report). A later change to the text rules bumps the version.

### Fixed
- Every Code's Auto Drive prompts are not indexed as yours. In `~/.code/history.jsonl`, the rows of a session after its `/auto` row and dated before 2025-10-23 (when Every Code stopped writing them there) are dropped (`auto-drive`). In an Every Code rollout, a turn of a session a typed-prompt log names is kept only when it is one of the session's typed rows (`code-turn-not-typed`); a session no log names is dropped when its home's log was being written before and after the turn (`code-session-not-typed`).
- Every Code's canned auto-resolve request ("Is this a real issue introduced by our changes? If so, please fix and resolve all similar issues.") and its rollout preface are harness text; a row that is only an `[image: ...]` placeholder is dropped (`image-only`). With the `fleet` profile, a supervising agent's wake relay that points a session back at its standing orders is dropped.
- One turn, one id: a candidate whose turn (host, session, time, line of the same-named file) already has a statement under another id is skipped (`sameTurnOtherId` in the index report), so a same-named rollout copy in a backup home, a changed `.zst` rollout or a shrunk file never adds a second id for a turn an earlier version read differently.

## 0.3.2

### Added
- The apply gate, on by default (`applyGate`, `applyThreshold` 0.2; README "The apply gate"): after the judge and every eligibility rule, one more Decisions question per surviving statement ("Does this past owner statement apply to the task the assistant is doing right now, not just the same topic?", the statement shown with its card gist), asked in one request. The survivors are reranked by that probability and the first `k` at 0.2 or more are injected. A refused or unanswered question cannot pass; if the deadline, the cap or the API stops the gate, nothing is injected (`apply-gate-failed`). Switch it off with `applyGate: false` for the previous behaviour exactly.
- The turn log records each survivor's apply probability and verdict (`applyGate`) and the settings (`apply`); `recall logs` counts the gate's runs and the monitor's detail view shows its table.

### Changed
- `V1_ENV` (`recall eval --v1`, the tests) also switches the gate off; `V2_ENV` sets it explicitly. `needsCards` is true when the gate is on.

## 0.3.1

### Added
- Precision rules, on by default: four eligibility rules that keep out the statements a live audit found most often misleading (38% of injected cards): a card with the new-session placeholder gist (`excludeNewSessionGist`), a statement that cites a URL, a local port or a file path (`excludeCitations`), a cross-repo statement of 300 characters or more (`crossRepoMaxChars`), a rule or preference of 500 characters or more (`ruleMaxChars`). Offline over 274 labelled messages: messages carrying a misleading card -10.2 points (95% interval -15.0 to -5.5), messages with a useful card -0.7 (-4.4 to +2.6). They are applied with `excludeKinds` and the scope filter before ranking, so the next eligible statement takes the slot. Switch them off with the four settings above (`false` / `0`).
- The turn log records, per reason (`gist-placeholder`, `cites-location`, `cross-repo-long`, `long-directive`), how many statements the rules kept out of the history and the newest 50 ids (`excluded`), and their settings (`precision`). `recall logs` and the monitor show them.

### Changed
- `recall query --any-repo` also lifts the cross-repo length limit.

## 0.3.0

Publishable and general: any Claude Code or Codex user can install Recall and get the same behaviour, with nothing tied to the machine or the fleet it was built on.

### Added
- `recall setup` (guided first run: what leaves the machine and consent, cost estimate, `config.json` with a daily cap, first index and cards, host install commands and the Codex hook-trust step; `--yes` accepts every step) and `recall doctor` (Node, OpenAI key, API reachability, claude and codex CLIs, homes and transcripts, data directory, plugin install state per host).
- `recall index --dry-run`: scans every transcript from scratch in memory and reports what an index would hold, what it would cost to embed and how it differs from the index on disk. Writes nothing.
- `recall query "<text>"` takes the text as an argument, and `--kind rule,preference,...` and `--any-repo` filters.
- `recall show <statement-id>`: the conversation around a recalled statement, read from its transcript (reads only; Claude, Codex and Every Code, `.jsonl` and `.jsonl.zst`). Each injected card now ends with a `source:` line (the transcript and line, `~` for the home directory) and the `context:` command that runs `recall show` from the plugin root the hook is running from; the block header gains one sentence about it. The monitor shows each candidate's source and an "Agent looked up context" panel of `recall show` runs (`event:"show"` lines in the turn log).
- A bundled skill (`skills/recall/SKILL.md`, for both hosts) that explains the injected `<recall-context>` cards and when and how to look things up on demand.
- Config keys `ownerNames`, `ownerEmails`, `filterProfiles`, `dropPatterns`; `homes` is now a list that adds to the standard homes.
- `LICENSE` (MIT), this changelog, a Privacy section in the README, marketplace manifests that install from a GitHub repository path.

### Changed
- Agent homes: by default Recall reads `~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME` and `~/.code` (when present) plus the homes listed in `homes`. The fleet roster file (`homesRoster`) is optional and off by default; a roster that cannot be read is an error, not a silent fall back.
- Worker routing: `claude -p --model haiku` and `codex exec` run under the current host's own home and environment, and no `usage` command is required. Usage-based routing across homes is the optional `usageCmd` setting.
- The two text rules that need to know who you are (agent-delivered messages from other senders; other people's email addresses) use `ownerNames` and `ownerEmails`, empty by default, and then do nothing.
- Filters for turns written by agent orchestration tooling (briefs, relays, dispatch headers, probes, selected-element dumps, record labels) moved into the opt-in `fleet` filter profile. The generic harness filters (task notifications, system reminders, tool output, sub-agent sidechains, skill bodies, compaction summaries, headless and exec sessions, the Codex `<INSTRUCTIONS>` wrapper) stay on for everyone.
- Marketplace name is `plugin-recall` (was `recall-local`): reinstall in homes that installed from a local checkout.
- Test fixtures are synthetic, structure-faithful lines (see `test/fixtures/README.md`); the documentation was rewritten without data from any one person's history.

### Fixed
- `recall` started through npm's symlinked bin (`npm install -g`, `npx`) could not find its script: `bin/recall` is now a node file whose import resolves from its real path. Tests install the packed tarball and run it through a symlink.
- Test fixtures and tests carried lightly reworded real messages with their real timestamps; all are now invented text with invented timestamps and ordinals. An opt-in test (`RECALL_PRIVACY_STATEMENTS=<statements.jsonl> npm test`) scans the tests against a real history.
- A Claude hook payload without `prompt_id` and `scratchpad_dir` is classified by where its transcript lives (`<home>/projects/<slug>/<session>.jsonl`, or Codex's `rollout-*.jsonl`) instead of failing.
- Setup wording for an embedding cost under $0.0001, and a note in `recall doctor`, `recall setup` and the README on proving Decisions API access.

### Removed
- Research and replay tooling that depended on a private lab checkout (`scripts/validate`, `scripts/refit`, answer and asset importers, cold-start and compaction-census scripts) and the evidence files they wrote.
- `ownerEmail` (single address) and the hard-coded default roster path.

### Upgrading from 0.2.x
- Replace `ownerEmail` in `config.json` by `ownerEmails` (a list). A file that still has `ownerEmail` is invalid and the hook stays silent until it is removed.
- If you relied on the roster, set `homesRoster` (and `usageCmd` for usage-based routing, `ownerNames` and `filterProfiles: ["fleet"]` for the filters). `docs/examples/fleet-config.json` is a complete example.
- Reinstall the plugin in each home (the marketplace was renamed).

## 0.2.1

Prompt hook only; typed memory cards; same-repo first with a tight global channel; hub suppression; conversation-aware search; the Stop hook removed.
