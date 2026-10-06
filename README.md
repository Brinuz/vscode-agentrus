# Agent"R"Us

A VS Code sidebar for running multiple Claude Code agents across multiple initiatives without losing track of them.

An **initiative** is a unit of work — "Auth revamp", "Billing migration". It holds three things:

- **Agents** — Claude sessions, each pinned to a model and optionally a startup skill;
- **Docs** — notes that belong to the initiative, kept out of the repo;
- **Shells** — plain terminals in the initiative's directory, no Claude attached.

When you create an initiative you choose where it runs: **in the repo you have open**, in **a git worktree of its own** on a new branch, or in a worktree on **a branch you already have** — so that parallel initiatives never touch each other's files. Agent"R"Us only ever deletes a worktree it created.

Every initiative starts with four agents:

| Agent | Default model | |
| --- | --- | --- |
| architect | `fable` | |
| dev | `opus` | |
| reviewer | `fable` | |
| generic | `sonnet` | A little helper — questions, odd jobs, anything that is not the other three |

Those four are always there and cannot be removed. **Add agent** puts more alongside them, each with its own name, icon, model and startup skill; only the ones you added can be removed.

Initiatives created before `generic` existed still have three agents — no migration touches them. **Add agent** notices what a given initiative is missing and offers it as a one-click preset, minted exactly as a new initiative would (built-in icon, `agentrus.models.generic`), so it ends up indistinguishable from one that had it from the start.

Clicking an agent opens a terminal in that initiative's worktree and drops you into that agent's conversation — the same one as last time, with its own history. Close the terminal, come back tomorrow, click again: you land back where you left off.

Initiatives start **collapsed**, except the one whose worktree this window has open — that one is also marked `· this window` on its row, so it stays identifiable once everything is expanded or collapsed again. Drag them to reorder, or use **Move up** / **Move down**.

While an agent's terminal is open, its row says whether it is **working…**, **needs you**, or **idle** — reported by the agent's own process via hooks, so a permission prompt shows up as soon as it appears. See [Working, needs you, or idle](#working-needs-you-or-idle).

## How it works

Each agent's conversation is named `{initiative}-{agent}` — `Auth revamp-architect`. Agent"R"Us creates it with `claude --name <name>` and gets back into it with `claude --resume <name>`, so the same name you see in the sidebar is the one in the terminal tab, in Claude's prompt box, and in its `/resume` picker.

Whether a click creates or resumes is decided by looking at Claude's transcripts on disk: if a conversation with that name exists for that directory, resume it, otherwise create it. Resuming a name with nothing behind it would open Claude's session picker and silently drop the startup skill, so guessing is not an option.

The name deliberately leaves out the model, so switching an agent from `fable` to `opus` keeps its conversation instead of renaming it out of reach. "Start fresh" deletes the conversation's transcript from disk, so the next launch starts over under the same name.

An initiative's name is load-bearing: it names the docs folder (`slugify(name)`) and every agent's conversation. Two initiatives whose names differ only by punctuation would slugify the same and quietly share one docs folder, so **a name that collides with an existing one is refused at creation**, naming the initiative it clashes with.

Git is the source of truth for worktrees. On startup Agent"R"Us reconciles its list against `git worktree list`, so a worktree you removed by hand disappears from the sidebar instead of lingering as a dead entry. Initiatives that just use the repo as-is are never pruned this way.

Creating a worktree also copies over the untracked config files listed in `agentrus.copyToWorktree` (by default `.env`), since `git worktree add` only materializes tracked files.

### Creating a worktree

Nothing is created until you have seen it. Choosing a worktree brings up a review step:

```
$(git-branch) Branch      initiative/auth-revamp
$(folder)     Directory   ~/Workspace/vscode-agentrus-worktrees/auth-revamp
$(git-commit) Base ref    main
──────────────────────────────
$(check) Create worktree
```

Pick a row to change it. The branch and directory start out coupled — renaming the branch moves the directory with it — until you set a directory yourself, after which it stays put.

Two things get a word before they bite:

- a directory that **already exists and is not empty**, which git would refuse anyway;
- a directory **inside the repository**, which git allows without complaint. The result is a whole checkout sitting untracked in your working tree, which `git add -A`, a linter, or the `copyToWorktree` step would all descend into. You can proceed — a gitignored subfolder is a reasonable thing to want — but not by accident.

Starting from **an existing branch** lists your local branches, marking any already checked out in another worktree as unavailable (git allows a branch in one worktree at a time). Remote-only branches are listed too and get a local tracking branch; where a local branch already exists for a remote, only the local one is offered.

### Docs

Docs are **not** stored in your repo — there is nothing to commit and nothing to gitignore. They live in the extension's global storage, one folder per initiative, outside the worktree.

Removing an initiative asks what to do with its docs. **Archive docs** moves the folder into an `archive/` folder next to the docs, with an `ARCHIVE.md` recording the branch, last commit, worktree, agents and their session names, and linked docs. An `INDEX.md` at the archive root lists every archived initiative, so one path is enough to hand an agent. **Delete docs** sends the folder to the trash. Linked files outside the folder are never deleted either way. An initiative with no docs is removed without asking. Run **Agent"R"Us: Open Archived Docs** from the command palette to pick an archived initiative and open one of its files, or **Agent"R"Us: Copy Archive Path** to get the archive's location.

Agents are launched with `--add-dir <that folder>`, so they can read and write the docs even though the docs sit outside the working tree. Use **Reveal Docs Folder** on the Docs group to open it in Finder.

The Docs group mirrors the folder: **every file in it shows up automatically**, the moment it lands there — whether you created it, dropped it in Finder, or an agent wrote it mid-conversation. There is nothing to register; deleting the file removes the entry. Files you **link** from elsewhere are the exception: those are remembered by Agent"R"Us, shown alongside the folder's files, and can be unlinked from the tree without touching the file itself.

Folder-backed docs have no "unlink" — the folder *is* the truth — so their menu offers **Reveal in Finder** and **Delete file**, the latter behind a confirmation and via the trash so it can be undone. Linked docs keep **Remove Doc**, which only forgets the link.

### Working, needs you, or idle

While an agent's terminal is open, Agent"R"Us puts its state on the row:

| | |
| --- | --- |
| red bell · `needs you` | Blocked on you — a permission prompt or a question. This is the row to click |
| yellow spinner · `working…` | Mid-turn, leave it alone |
| green · `idle` | Finished; nothing pending |
| green · `live` | Terminal is open but nothing has reported yet |

Traffic lights: green is clear to take, yellow is busy, red is stopped and waiting on you. A spinning icon is the only animation VS Code gives a tree row, so it goes on *busy* — the rows in motion are the ones to leave alone, which leaves the still red bell as the thing your eye lands on. Agents keep their own icon when they are neither working nor blocked.

The state comes from the agent's own process. Each agent launches with `--settings` pointing at a small hooks file of its own, written into the extension's storage — your `~/.claude/settings.json` is never touched, and because Claude merges hook layers rather than replacing them, your own hooks keep firing alongside these. `UserPromptSubmit` → working, `Stop` → idle, `SessionEnd` clears the state, and `Notification` → `needs you`, unless its message is the after-a-while nudge rather than a real block. Each hook writes to that agent's own status file, so nothing has to map a session id back to a row; the write goes via a temp file and `mv` so the watcher never sees half of one.

Three more — `PreToolUse`, `PostToolUse` and `PostToolUseFailure` — also mean working, and are the only ones running per tool call rather than once a turn. They pay for themselves: **approving a permission prompt fires no event at all**, so tool activity is the only evidence Claude emits that the block cleared. All three are needed because none covers every tool call on its own: a tool refused by a permission rule fires only `PreToolUse`, and a tool that *fails* fires `PostToolUseFailure` **instead of** `PostToolUse`, not alongside it.

One gap is structural rather than an oversight: `PreToolUse` fires *before* the permission gate, so between approving a prompt and the tool finishing, Claude emits nothing. A tool that runs for minutes leaves the row saying `needs you` until it completes.

`needs you` is why hooks are needed at all rather than more transcript reading: a tool that is running and a tool stopped at a permission prompt are the same thing in a transcript — a `tool_use` with no result — so the difference simply is not written down anywhere.

**The transcript fallback.** Agents whose conversation started before hooks existed, or whose status file is gone, still get working-vs-idle read from the transcript. That verdict comes from the shape of the last message: an assistant message that stopped for a tool call is waiting on that tool, and while the tool runs nothing is written at all — so a ten-minute test suite would look exactly like an idle agent if timestamps were all we had. Trailing metadata records (titles, modes, attachments) are skipped to find the last real message, and an `[Request interrupted by user]` marker — what Esc leaves behind — means stopped, whatever its age.

Staleness is a sanity check on top, measured from the **message's own timestamp**, not the file's. Those differ by a lot: Claude appends metadata records for hours after a conversation ends, which drags the file's timestamp forward while nothing is being said. The two windows — 2 minutes while generating a reply, 30 minutes while waiting on a tool — were measured against real transcripts, where the 99th percentile of each gap is 65 seconds and 220 seconds respectively.

Only agents whose terminal is open **in this window** are watched, and polling stops entirely when none are — hook-backed agents are never polled at all, since their state arrives as it happens. Terminals are per-window, so an agent working in a worktree window shows no state in the repo window. `agentrus.activityPollSeconds` sets the fallback interval; `0` switches it off, leaving hook-backed agents reporting and everything else on `live`.

### Startup skills

An agent can be given a **startup skill** — the name of a Claude Code skill (from `~/.claude/skills/` or the repo's `.claude/skills/`) that defines how that agent behaves: its role, its process, where to put things.

When set, every launch of that agent — first start and resume alike — begins by sending

```
/<skill> docs-dir: <the initiative's docs folder>
```

as the first message. The skill loads its instructions into the conversation, and the initiative's docs folder rides along as its argument, so a skill that honors `docs-dir` writes its plans, notes and findings into the initiative's shared docs instead of the repo. Re-sending it on resume re-briefs the agent after long sessions; the cost is that reopening a closed terminal always triggers a turn.

An agent with no skill set is **asked once**, the first time you launch it. Answering "No skill" counts as an answer, so it never asks that agent again — change it later with **Change startup skill**. Set `agentrus.skills.*` and new agents are never asked at all.

Dismissing that prompt cancels the launch. During **Open all agents** it cancels the whole batch, so one Esc backs out rather than one per agent.

The skill itself is yours to write — Agent"R"Us only sends the invocation.

## Usage

Open a folder that is a git repository, then open the Agent"R"Us view in the activity bar.

Every row's **cog** opens the same actions its right-click menu offers — the two never disagree about what is available, so it does not matter which one you reach for. The cog is a menu of the lot; right-click lists them individually.

- **Create initiative** (`+` in the view title) — asks for a name and where it runs: the repo you have open, a new worktree, or a worktree on an existing branch. See [Creating a worktree](#creating-a-worktree).
- **Click an agent** — opens or reveals its terminal, resuming its session.
- **Open all agents** (on an initiative or its Agents group) — brings up all of them at once; Esc during a skill prompt backs out of the whole batch.
- **Add agent** — a missing default as a one-click preset, or a new agent you name, icon, model and skill yourself.
- **Remove agent** — only for agents you added. Its transcript stays on disk, so adding the same name back later resumes that conversation; run **Start fresh session** first if you want it gone for good.
- **Open worktree in this window** — switches the window to the worktree so the Explorer shows the initiative's real files. The sidebar shows the same initiatives there: they are keyed to the repo, not to the folder you happen to have open. Terminals do not survive the switch, but conversations resume on the next click — and the initiative you switched to is the one that comes up expanded.
- **Open worktree in new window** — for when an initiative deserves its own window.
- **Change model** (on an agent) — takes effect the next time that agent's terminal starts.
- **Change startup skill** (on an agent) — pick from the skills found in `~/.claude/skills/` and the repo's `.claude/skills/`, type a name, or choose "No skill". Same timing as model changes.
- **Add doc** — a new markdown file in the docs folder, or a link to an existing file anywhere on disk. Docs themselves offer **Reveal in Finder**, plus **Delete file** for the folder-backed ones and **Remove Doc** for linked ones.
- **New shell** / **Rename shell** / **Remove shell** — plain terminals in the initiative's directory. Renaming relabels the running terminal's tab as well as the tree row.
- **Add default shells** (on the Shells group) — gives an existing initiative whatever `agentrus.defaultShells` lists, skipping any it already has.
- **Move up** / **Move down**, or drag a row — reorders the initiative list; the order is remembered. Dropping onto any row of another initiative places it there, so you need not hit the initiative row exactly.
- **Start fresh session** (on an agent) — deletes the conversation's transcript from disk and starts over under the same name.
- **Remove initiative** — closes the terminals and removes the worktree. It refuses to discard uncommitted work without asking, and keeps the branch unless you ask it not to.
- **Extension settings** (in an initiative's cog) — jumps straight to the Agent"R"Us settings.

Agent and shell terminals open in the panel by default; set `agentrus.terminalLocation` to `editor` to get them as editor tabs instead. It applies to the next terminal opened, not to ones already running.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `agentrus.models.architect` | `fable` | Model for new architect agents |
| `agentrus.models.dev` | `opus` | Model for new dev agents |
| `agentrus.models.reviewer` | `fable` | Model for new reviewer agents |
| `agentrus.models.generic` | `sonnet` | Model for new generic agents |
| `agentrus.skills.architect` | — | Startup skill for new architect agents |
| `agentrus.skills.dev` | — | Startup skill for new dev agents |
| `agentrus.skills.reviewer` | — | Startup skill for new reviewer agents |
| `agentrus.skills.generic` | — | Startup skill for new generic agents |
| `agentrus.defaultShells` | `[]` | Shells every new initiative starts with, e.g. `["dev", "logs"]` |
| `agentrus.terminalLocation` | `panel` | `panel` or `editor` — where agent and shell terminals open |
| `agentrus.activityPollSeconds` | `3` | How often to check the transcript of an open agent that has no hook state; `0` disables |
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
