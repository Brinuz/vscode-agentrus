# Agentrus

A VS Code sidebar for running multiple Claude Code agents across multiple initiatives without losing track of them.

An **initiative** is a unit of work — "Auth revamp", "Billing migration". Each one gets:

- its own **git worktree** on its own branch, so initiatives never touch each other's files;
- three **agents**, each pinned to a model and to a durable Claude session:

| Agent | Default model |
| --- | --- |
| architect | `fable` |
| dev | `opus` |
| reviewer | `fable` |

Clicking an agent opens a terminal in that initiative's worktree and drops you into that agent's conversation — the same one as last time, with its own history. Close the terminal, come back tomorrow, click again: you land back where you left off.

## How it works

Agentrus mints a UUID per agent and hands it to Claude Code as `--session-id`. On later clicks it passes `--resume <uuid>` instead, so the conversation continues rather than restarting. It decides between the two by looking for the session transcript under `~/.claude/projects`, which means deleting a session outside VS Code does the sane thing rather than leaving a broken link.

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
