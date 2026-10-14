# Recall for Claude Code and Codex

Recall helps your coding agent remember what you told it before. When something you said in an earlier conversation matters for what you are asking now, Recall reminds the agent of it.

[![Recall film: a gold-foil goldfish on a book cover is re-stitched into the word Recall, then the install command npx -y @just-every/plugin-recall appears](https://raw.githubusercontent.com/just-every/plugin-recall/main/media/recall-film.gif)](https://youtu.be/gR-NN552JGo)

*Explainer video (3:24)*

## Install

Paste this into a terminal:

```bash
npx -y @just-every/plugin-recall
```

**You need:**

- **Node.js 22.15 or newer.** The `npx` command comes with it.
- **Claude Code or Codex (or both), installed and logged in.** Recall uses it to write a short summary of each thing you said.
- **An OpenAI API key** from an organisation with access to OpenAI's **Decisions API**. Recall uses OpenAI to search your past messages and to decide which ones matter. Access is per organisation, and not every key has it. If yours does not, setup says so and stops before anything is installed.

Setup asks you at most two things: your OpenAI key (only if it cannot find one), and "Go ahead?" once, after it shows you the whole plan: where it will install, what it will cost and, the first time, what leaves your computer. Nothing is installed and nothing is paid for until you say yes.

When it is done:

- **If you use Codex**, approve Recall once in each Codex home (a home is the folder where an agent keeps its settings and history, such as `~/.codex`): Codex shows a "Hooks need review" screen the next time it starts (or type `/hooks`).
- Setup adds a `recall` command. If your terminal cannot find it, run the line setup prints at the end, which adds `~/.local/bin` to your PATH (the folders your terminal looks in for commands).

To update later, run `npx -y @just-every/plugin-recall@latest`. Every install option is in the [reference](docs/reference.md#install).

## What it does

- Every time you send a message to your agent, Recall looks through what you typed in earlier conversations in Claude Code, Codex and Every Code.
- If something you said before matters for this request, it gives the agent **up to three short memory cards**. When nothing clears its bar, it gives nothing.
- For example, you once told an agent "Never push to main without asking me first." Weeks later, in a different conversation, Recall can bring that rule back to the agent when it matters.
- It remembers **only what you typed**: not the agent's replies and not tool output.
- It only acts when you send a message. Automated sessions (scripts, sub-agents) get nothing.
- It is open source (MIT licence) and works in Claude Code and Codex.

## How it works

1. **It builds an index of what you typed** (a searchable list). Recall reads your past messages from your agents' history on this computer and keeps them in a local folder, `~/.plugin-recall`.
2. **It writes a short card for each one.** Your own Claude Code or Codex writes it: what kind of thing it is (for example a rule, a preference or a decision), whether it is about one project or all of them, and a one-line note about what was going on.
3. **It checks each new message against them.** When you send a message, Recall picks about 200 past statements that look related, then asks OpenAI one narrow question about each: is this important for handling the request right now?
4. **Only clear matches get through.** A statement must pass a high bar, pass a second check that it applies to what the agent is doing right now, come from the right project (or be a rule or preference for all projects), and not have come up already in this conversation.

Each card shows the kind, when you said it, your exact words, and where it came from, so the agent can read the conversation around it if it needs more. A full example is in the [reference](docs/reference.md#memory-cards).

## Everyday use

You do not need to do anything: Recall works in the background. These commands are there when you want them. Use `recall <command>`, or `npx -y @just-every/plugin-recall <command>` if the `recall` command is not on your PATH.

| Command | What it does |
|---|---|
| `recall doctor` | Checks that everything works. |
| `recall monitor` | Starts a live view of what Recall does. Open the address it prints in your browser; it works only on this computer. |
| `recall query "how do I deploy"` | Shows what Recall would bring up for a message (costs about $0.004). |
| `recall logs` | What Recall did today. |
| `recall spend` | What Recall has spent today and in total. |
| `recall pause` / `recall resume` | Turns Recall off and on again, at once, everywhere. |

`recall help --all` lists every command. Details are in the [reference](docs/reference.md#using-it).

## Pause or turn it off

- **Pause:** `npx -y @just-every/plugin-recall pause` (or `recall pause`) stops Recall straight away in every agent home, without removing it. `npx -y @just-every/plugin-recall resume` turns it back on.
- **Remove:** see [Uninstall](#uninstall).

Other ways to switch it off are in the [reference](docs/reference.md#kill-switch).

## Privacy

- **Kept on your computer**, in `~/.plugin-recall`: the messages you typed, the index, the cards, a record of spending and logs of what Recall did. Recall skips files that hold credentials, and it has no telemetry.
- **Sent to OpenAI**, with your API key: each message you typed, once, to build the search index (the first 2,000 characters, with anything that looks like an API key, token or private key removed). Then, each time you send a message: the project name, your new message, your previous one, a short plain-text part of the agent's last reply (up to 400 characters, not cleaned of secrets) and about 200 short excerpts of your past messages.
- **Sent to your own Claude Code or Codex**, under the login it already has: each message with a little context around it, so it can write the card.
- **Delete everything:** `rm -rf ~/.plugin-recall`.

The exact list of what is stored and sent is in the [reference](docs/reference.md#privacy).

## Costs

You pay OpenAI for what Recall uses, on your own API key.

- **The first index:** about $0.014 for 12,000 past messages.
- **Each message you send:** about $0.004, and nothing when the same situation was checked before.
- **The cards:** no API charge from Recall; your own Claude Code or Codex writes them.
- **A daily limit:** by default Recall stops for the day once it has spent $1 (UTC day, across all your agents). To change it, run setup again with a new limit, for example `npx -y @just-every/plugin-recall --daily-cap 2`.

Details are in the [reference](docs/reference.md#costs).

## Uninstall

```bash
npx -y @just-every/plugin-recall uninstall           # remove Recall from every agent home
npx -y @just-every/plugin-recall uninstall --purge   # also delete ~/.plugin-recall
```

Without `--purge`, your index, cards and logs stay in `~/.plugin-recall`, and your OpenAI key stays in `~/.env`. More options are in the [reference](docs/reference.md#uninstall).

## Good to know

- Recall is an experiment. Its measurements come from one developer's history, so expect some cards to be only loosely relevant. See [Limits](docs/reference.md#limits).
- Cards are quotes of old messages. Recall's built-in skill tells the agent to treat them as context, not instructions, and that your current message wins over a card.

## Full technical reference

Everything else, including configuration, how it works with each host, files and logs, the monitor, what happens when something fails, evaluation, limits and upgrading, is in [docs/reference.md](docs/reference.md).

## License

MIT, see [LICENSE](LICENSE). Changes are in [CHANGELOG.md](CHANGELOG.md).
