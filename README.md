# Agentrus

A VS Code sidebar for running multiple Claude Code agents across multiple initiatives without losing track of them.

An **initiative** is a unit of work — "Auth revamp", "Billing migration". Each one gets its own **git worktree** on its own branch, so initiatives never touch each other's files, and holds three things:

- **Agents** — three Claude sessions, each pinned to a model;
- **Docs** — markdown and other files that belong to the initiative;
- **Shells** — plain terminals in the worktree, no Claude attached.

The agents:

| Agent | Default model |
| --- | --- |
| architect | `fable` |
| dev | `opus` |
| reviewer | `fable` |

Clicking an agent opens a terminal in that initiative's worktree and drops you into that agent's conversation — the same one as last time, with its own history. Close the terminal, come back tomorrow, click again: you land back where you left off.

## How it works

Each agent's conversation is named `{initiative}-{agent}` — `Auth revamp-architect`. Agentrus creates it with `claude --name <name>` and gets back into it with `claude --resume <name>`, so the same name you see in the sidebar is the one in the terminal tab, in Claude's prompt box, and in its `/resume` picker.

The name deliberately leaves out the model, so switching an agent from `fable` to `opus` keeps its conversation instead of renaming it out of reach. "Start fresh" bumps a suffix (`Auth revamp-architect-2`), since a same-named session would otherwise just resume the old one.

Git is the source of truth for worktrees. On startup Agentrus reconciles its list against `git worktree list`, so a worktree you removed by hand disappears from the sidebar instead of lingering as a dead entry.

## Usage

Open a folder that is a git repository, then open the Agentrus view in the activity bar.

- **Create initiative** (`+` in the view title) — asks for a name and a base ref, then creates the branch and worktree.
- **Click an agent** — opens or reveals its terminal, resuming its session.
- **Open all agents** (on an initiative) — brings up all three at once.
- **Open worktree in new window** — for when an initiative deserves its own window.
- **Change model** (on an agent) — takes effect the next time that agent's terminal starts.
- **Start fresh session** (on an agent) — repoints it at a new conversation; the old transcript stays on disk.
- **Remove initiative** — closes the terminals and removes the worktree. It refuses to discard uncommitted work without asking, and keeps the branch unless you ask it not to.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `agentrus.models.architect` | `fable` | Model for new architect agents |
| `agentrus.models.dev` | `opus` | Model for new dev agents |
| `agentrus.models.reviewer` | `fable` | Model for new reviewer agents |
| `agentrus.worktreeRoot` | `../<repo>-worktrees` | Where worktrees are created |
| `agentrus.branchPrefix` | `initiative/` | Prefix for initiative branches |
| `agentrus.claudeCommand` | `claude` | Command used to launch Claude Code |

The initiative list lives in VS Code's workspace state, so it is local to your machine and to this workspace.

## Development

```sh
npm install
npm run watch    # rebuild on change
```

Press `F5` to launch an Extension Development Host with Agentrus loaded.
