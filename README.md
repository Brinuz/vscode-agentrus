# Agent"R"Us

A VS Code sidebar for running multiple Claude Code agents across multiple initiatives without losing track of them.

An **initiative** is a unit of work — "Auth revamp", "Billing migration". It holds three things:

- **Agents** — three Claude sessions, each pinned to a model and optionally a startup skill;
- **Docs** — notes that belong to the initiative, kept out of the repo;
- **Shells** — plain terminals in the initiative's directory, no Claude attached.

When you create an initiative you choose where it runs: **in the repo you have open**, or in **a git worktree of its own** on a new branch, so that parallel initiatives never touch each other's files. Agent"R"Us only ever deletes a worktree it created.

The agents:

| Agent | Default model |
| --- | --- |
| architect | `fable` |
| dev | `opus` |
| reviewer | `fable` |

Clicking an agent opens a terminal in that initiative's worktree and drops you into that agent's conversation — the same one as last time, with its own history. Close the terminal, come back tomorrow, click again: you land back where you left off.

## How it works

Each agent's conversation is named `{initiative}-{agent}` — `Auth revamp-architect`. Agent"R"Us creates it with `claude --name <name>` and gets back into it with `claude --resume <name>`, so the same name you see in the sidebar is the one in the terminal tab, in Claude's prompt box, and in its `/resume` picker.

Whether a click creates or resumes is decided by looking at Claude's transcripts on disk: if a conversation with that name exists for that directory, resume it, otherwise create it. Resuming a name with nothing behind it would open Claude's session picker and silently drop the startup skill, so guessing is not an option.

The name deliberately leaves out the model, so switching an agent from `fable` to `opus` keeps its conversation instead of renaming it out of reach. "Start fresh" deletes the conversation's transcript from disk, so the next launch starts over under the same name.

Git is the source of truth for worktrees. On startup Agent"R"Us reconciles its list against `git worktree list`, so a worktree you removed by hand disappears from the sidebar instead of lingering as a dead entry. Initiatives that just use the repo as-is are never pruned this way.

Creating a worktree also copies over the untracked config files listed in `agentrus.copyToWorktree` (by default `.env`), since `git worktree add` only materializes tracked files.

### Docs

Docs are **not** stored in your repo — there is nothing to commit and nothing to gitignore. They live in the extension's global storage, one folder per initiative, so they also survive the initiative's worktree being deleted.

Agents are launched with `--add-dir <that folder>`, so they can read and write the docs even though the docs sit outside the working tree. Use **Reveal Docs Folder** on the Docs group to open it in Finder.

The Docs group mirrors the folder: **every file in it shows up automatically**, the moment it lands there — whether you created it, dropped it in Finder, or an agent wrote it mid-conversation. There is nothing to register; deleting the file removes the entry. Files you **link** from elsewhere are the exception: those are remembered by Agent"R"Us, shown alongside the folder's files, and can be unlinked from the tree without touching the file itself.

### Startup skills

An agent can be given a **startup skill** — the name of a Claude Code skill (from `~/.claude/skills/` or the repo's `.claude/skills/`) that defines how that agent behaves: its role, its process, where to put things.

When set, every launch of that agent — first start and resume alike — begins by sending

```
/<skill> docs-dir: <the initiative's docs folder>
```

as the first message. The skill loads its instructions into the conversation, and the initiative's docs folder rides along as its argument, so a skill that honors `docs-dir` writes its plans, notes and findings into the initiative's shared docs instead of the repo. Re-sending it on resume re-briefs the agent after long sessions; the cost is that reopening a closed terminal always triggers a turn.

The skill itself is yours to write — Agent"R"Us only sends the invocation.

## Usage

Open a folder that is a git repository, then open the Agent"R"Us view in the activity bar.

- **Create initiative** (`+` in the view title) — asks for a name and where it runs: the repo you have open, or a new worktree branched off a ref you choose.
- **Click an agent** — opens or reveals its terminal, resuming its session.
- **Open all agents** (on an initiative) — brings up all three at once.
- **Open worktree in this window** — switches the window to the worktree so the Explorer shows the initiative's real files. The sidebar shows the same initiatives there: they are keyed to the repo, not to the folder you happen to have open. Terminals do not survive the switch, but conversations resume on the next click.
- **Open worktree in new window** (context menu) — for when an initiative deserves its own window.
- **Change model** (on an agent) — takes effect the next time that agent's terminal starts.
- **Change startup skill** (on an agent) — pick from the skills found in `~/.claude/skills/` and the repo's `.claude/skills/`, type a name, or choose "No skill". Same timing as model changes.
- **Add doc** (on the Docs group) — a new markdown file in the docs folder, or a link to an existing file anywhere on disk.
- **Start fresh session** (on an agent) — deletes the conversation's transcript from disk and starts over under the same name.
- **Remove initiative** — closes the terminals and removes the worktree. It refuses to discard uncommitted work without asking, and keeps the branch unless you ask it not to.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `agentrus.models.architect` | `fable` | Model for new architect agents |
| `agentrus.models.dev` | `opus` | Model for new dev agents |
| `agentrus.models.reviewer` | `fable` | Model for new reviewer agents |
| `agentrus.skills.architect` | — | Startup skill for new architect agents |
| `agentrus.skills.dev` | — | Startup skill for new dev agents |
| `agentrus.skills.reviewer` | — | Startup skill for new reviewer agents |
| `agentrus.worktreeRoot` | `../<repo>-worktrees` | Where worktrees are created |
| `agentrus.copyToWorktree` | `[".env"]` | Untracked files copied into each new worktree; `**/name` matches recursively |
| `agentrus.branchPrefix` | `initiative/` | Prefix for initiative branches |
| `agentrus.claudeCommand` | `claude` | Command used to launch Claude Code |

The initiative list is stored per repository, keyed by the main repo's root — a window on the repo and a window on any of its worktrees see the same initiatives. It stays local to your machine.

## Development

```sh
npm install
npm run watch    # rebuild on change
```

Press `F5` to launch an Extension Development Host with Agent"R"Us loaded.
