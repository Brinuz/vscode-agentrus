import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";
import { ensureDocsDir, listDocFiles } from "./docs";
import { addWorktree, currentRef, deleteBranch, removeWorktree, repoRoot } from "./git";
import { agentKey, Initiative, ROLE_ICONS, shellKey } from "./model";
import { deleteSessions, launchCommand, sessionExists, sessionName } from "./sessions";
import { Store } from "./store";
import { Terminals } from "./terminals";
import { AgentItem, DocItem, GroupItem, InitiativeItem, InitiativeTree, ShellItem } from "./tree";
import { message, slugify } from "./util";

const KNOWN_MODELS = ["fable", "opus", "sonnet", "haiku"];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new Store(context);
  const terminals = new Terminals();
  const tree = new InitiativeTree(store, terminals, (initiative) =>
    listDocFiles(context, initiative),
  );

  // A file landing in any initiative's docs folder — usually written by an
  // agent — shows up in the tree by itself, without a manual refresh.
  const docsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.joinPath(context.globalStorageUri, "docs"), "**"),
  );

  context.subscriptions.push(
    terminals,
    terminals.onDidChange(() => tree.refresh()),
    vscode.window.createTreeView("agentrus.initiatives", { treeDataProvider: tree }),
    docsWatcher,
    docsWatcher.onDidCreate(() => tree.refresh()),
    docsWatcher.onDidDelete(() => tree.refresh()),
  );

  const root = await findRepoRoot();
  await vscode.commands.executeCommand("setContext", "agentrus.hasRepo", root !== undefined);

  if (root) {
    await store.reconcile(root);
    tree.refresh();
  }

  const requireRoot = async (): Promise<string | undefined> => {
    const current = await findRepoRoot();
    if (!current) {
      vscode.window.showErrorMessage('Agent"R"Us needs an open folder that is a git repository.');
    }
    return current;
  };

  const openAgent = async (item: AgentItem): Promise<void> => {
    const claudeCommand = vscode.workspace
      .getConfiguration("agentrus")
      .get<string>("claudeCommand", "claude");

    // Claude refuses to --add-dir a directory that does not exist yet.
    const docs = await ensureDocsDir(context, item.initiative);

    // Disk is the source of truth for create-vs-resume: resuming a name with
    // no session behind it opens claude's picker and eats any queued prompt,
    // so the `started` flag alone (stale after a terminal closed before its
    // first message) is not enough to decide.
    const name = sessionName(item.initiative, item.agent);
    const started = item.agent.started ?? false;
    const resume = (await sessionExists(item.initiative.worktreePath, name)) ?? started;

    const created = terminals.open(item.initiative, {
      key: agentKey(item.agent),
      name,
      icon: ROLE_ICONS[item.agent.role],
      command: launchCommand(claudeCommand, item.initiative, item.agent, resume, docs),
    });

    // The conversation exists the moment we launch: from here on we resume it.
    if (created && !started) {
      await store.updateAgent(item.initiative.id, item.agent.role, { started: true });
      tree.refresh();
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("agentrus.refresh", async () => {
      const current = await findRepoRoot();
      if (current) {
        await store.reconcile(current);
      }
      tree.refresh();
    }),

    vscode.commands.registerCommand("agentrus.createInitiative", async () => {
      const current = await requireRoot();
      if (current) {
        await createInitiative(current, store, tree);
      }
    }),

    vscode.commands.registerCommand("agentrus.openAgent", openAgent),

    vscode.commands.registerCommand(
      "agentrus.openAllAgents",
      async (item: InitiativeItem | GroupItem) => {
        for (const agent of item.initiative.agents) {
          await openAgent(new AgentItem(item.initiative, agent, false));
        }
      },
    ),

    vscode.commands.registerCommand("agentrus.openWorktreeWindow", async (item: InitiativeItem) => {
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(item.initiative.worktreePath),
        { forceNewWindow: true },
      );
    }),

    vscode.commands.registerCommand("agentrus.changeModel", async (item: AgentItem) => {
      const picked = await vscode.window.showQuickPick(
        KNOWN_MODELS.map((model) => ({
          label: model,
          description: model === item.agent.model ? "current" : undefined,
        })),
        { title: `Model for ${item.agent.role} — ${item.initiative.name}` },
      );
      if (!picked || picked.label === item.agent.model) {
        return;
      }
      await store.updateAgent(item.initiative.id, item.agent.role, { model: picked.label });
      tree.refresh();

      if (terminals.isRunning(item.initiative, agentKey(item.agent))) {
        vscode.window.showInformationMessage(
          `${item.agent.role} will use ${picked.label} next time its terminal starts. Close the running terminal to switch now.`,
        );
      }
    }),

    vscode.commands.registerCommand("agentrus.changeSkill", async (item: AgentItem) => {
      const current = item.agent.skill ?? "";
      const found = await availableSkills(item.initiative.worktreePath);
      const picked = await vscode.window.showQuickPick(
        [
          { label: "$(close) No skill", id: "none" as const },
          ...found.map((name) => ({
            label: name,
            description: name === current ? "current" : undefined,
            id: "skill" as const,
          })),
          { label: "$(edit) Type a name…", id: "custom" as const },
        ],
        {
          title: `Startup skill for ${item.agent.role} — ${item.initiative.name}`,
          placeHolder:
            "Sent as the first message every time this agent's terminal starts, with the docs directory as its argument.",
        },
      );
      if (!picked) {
        return;
      }

      let skill: string;
      if (picked.id === "none") {
        skill = "";
      } else if (picked.id === "custom") {
        const entered = await vscode.window.showInputBox({
          title: `Startup skill for ${item.agent.role} — ${item.initiative.name}`,
          value: current,
          placeHolder: "my-architect-skill",
        });
        if (entered === undefined) {
          return;
        }
        skill = entered.trim().replace(/^\/+/, "");
      } else {
        skill = picked.label;
      }
      if (skill === current) {
        return;
      }
      await store.updateAgent(item.initiative.id, item.agent.role, {
        skill: skill || undefined,
      });
      tree.refresh();

      if (terminals.isRunning(item.initiative, agentKey(item.agent))) {
        vscode.window.showInformationMessage(
          `${item.agent.role} will ${skill ? `load /${skill}` : "load no skill"} next time its terminal starts. Close the running terminal to switch now.`,
        );
      }
    }),

    vscode.commands.registerCommand("agentrus.resetSession", async (item: AgentItem) => {
      const confirmed = await vscode.window.showWarningMessage(
        `Start a fresh session for ${item.agent.role} on "${item.initiative.name}"?`,
        {
          modal: true,
          detail:
            "The current conversation's transcript is deleted from disk; the next launch starts a brand new conversation under the same name.",
        },
        "Delete and start fresh",
      );
      if (confirmed !== "Delete and start fresh") {
        return;
      }
      terminals.disposeKey(item.initiative, agentKey(item.agent));
      // Give a just-killed claude a beat to finish writing before its
      // transcript is deleted, so a dying flush cannot resurrect the session.
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await deleteSessions(item.initiative.worktreePath, sessionName(item.initiative, item.agent));
      } catch (error) {
        vscode.window.showErrorMessage(`Could not delete the conversation: ${message(error)}`);
        return;
      }
      await store.updateAgent(item.initiative.id, item.agent.role, { started: false });
      tree.refresh();
    }),

    vscode.commands.registerCommand(
      "agentrus.newShell",
      async (item: InitiativeItem | GroupItem) => {
        const name = await vscode.window.showInputBox({
          title: `New shell — ${item.initiative.name}`,
          prompt: "A plain terminal in this initiative's directory.",
          value: `shell ${item.initiative.shells.length + 1}`,
        });
        if (!name) {
          return;
        }
        const shell = await store.addShell(item.initiative.id, name);
        if (!shell) {
          return;
        }
        tree.refresh();
        terminals.open(item.initiative, {
          key: shellKey(shell),
          name: `${item.initiative.name}-${shell.name}`,
          icon: "terminal",
        });
      },
    ),

    vscode.commands.registerCommand("agentrus.openShell", (item: ShellItem) => {
      terminals.open(item.initiative, {
        key: shellKey(item.shell),
        name: `${item.initiative.name}-${item.shell.name}`,
        icon: "terminal",
      });
    }),

    vscode.commands.registerCommand("agentrus.removeShell", async (item: ShellItem) => {
      terminals.disposeKey(item.initiative, shellKey(item.shell));
      await store.removeShell(item.initiative.id, item.shell.id);
      tree.refresh();
    }),

    vscode.commands.registerCommand(
      "agentrus.addDoc",
      async (item: InitiativeItem | GroupItem) => {
        await addDoc(context, item.initiative, store, tree);
      },
    ),

    vscode.commands.registerCommand("agentrus.revealDocsFolder", async (item: GroupItem) => {
      const dir = await ensureDocsDir(context, item.initiative);
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
    }),

    vscode.commands.registerCommand("agentrus.removeDoc", async (item: DocItem) => {
      // Unlink only. Deleting the user's file because they tidied a tree entry
      // would be a nasty surprise.
      await store.removeDoc(item.initiative.id, item.doc.id);
      tree.refresh();
    }),

    vscode.commands.registerCommand("agentrus.removeInitiative", async (item: InitiativeItem) => {
      const current = await requireRoot();
      if (current) {
        await removeInitiative(current, item.initiative, store, terminals, tree);
      }
    }),
  );
}

export function deactivate(): void {
  // Terminals and views are disposed through context.subscriptions.
}

async function findRepoRoot(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") {
    return undefined;
  }
  return repoRoot(folder.uri.fsPath);
}

async function createInitiative(root: string, store: Store, tree: InitiativeTree): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "New initiative",
    prompt: "Name this initiative — it gets an architect, a dev and a reviewer agent.",
    placeHolder: "Auth revamp",
    validateInput: (value) => (slugify(value) ? undefined : "Give it a name with some letters or digits."),
  });
  if (!name) {
    return;
  }

  const config = vscode.workspace.getConfiguration("agentrus");
  const slug = slugify(name);
  const branch = `${config.get<string>("branchPrefix", "initiative/")}${slug}`;
  const proposed = join(worktreeRoot(root, config.get<string>("worktreeRoot", "")), slug);

  const where = await vscode.window.showQuickPick(
    [
      {
        label: "$(repo) Work in this repo",
        detail: root,
        description: "No worktree — agents run in the folder you have open",
        id: "repo" as const,
      },
      {
        label: "$(git-branch) Create a git worktree",
        detail: proposed,
        description: `Isolated checkout on a new branch "${branch}"`,
        id: "worktree" as const,
      },
    ],
    { title: `Where should "${name}" run?` },
  );
  if (!where) {
    return;
  }

  if (where.id === "repo") {
    await store.add(name, root, await currentRef(root), false);
    tree.refresh();
    return;
  }

  const baseRef = await vscode.window.showInputBox({
    title: "Branch this initiative off which ref?",
    value: await currentRef(root),
    prompt: `Creates branch "${branch}" and a worktree at ${proposed}`,
  });
  if (!baseRef) {
    return;
  }

  let created: string;
  try {
    created = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating worktree for "${name}"…` },
      () => addWorktree(root, proposed, branch, baseRef),
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Could not create the worktree: ${message(error)}`);
    return;
  }

  await store.add(name, created, branch, true);
  tree.refresh();
}

async function addDoc(
  context: vscode.ExtensionContext,
  initiative: Initiative,
  store: Store,
  tree: InitiativeTree,
): Promise<void> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "$(new-file) New markdown file", id: "new" as const },
      { label: "$(link) Link an existing file", id: "link" as const },
    ],
    { title: `Add a doc to "${initiative.name}"` },
  );
  if (!choice) {
    return;
  }

  if (choice.id === "link") {
    const picked = await vscode.window.showOpenDialog({
      title: "Link a file to this initiative",
      defaultUri: vscode.Uri.file(initiative.worktreePath),
      canSelectMany: false,
    });
    const file = picked?.[0];
    if (!file) {
      return;
    }
    await store.addDoc(initiative.id, basename(file.fsPath), file.fsPath);
    tree.refresh();
    await vscode.commands.executeCommand("vscode.open", file);
    return;
  }

  const name = await vscode.window.showInputBox({
    title: `New doc — ${initiative.name}`,
    prompt: "Kept outside the repo, so it is never committed.",
    placeHolder: "Design notes",
    validateInput: (value) => (slugify(value) ? undefined : "Give it a name with some letters or digits."),
  });
  if (!name) {
    return;
  }

  const dir = await ensureDocsDir(context, initiative);
  const uri = vscode.Uri.file(join(dir, `${slugify(name)}.md`));
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    // Does not exist yet, so seed it rather than opening a phantom file.
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`# ${name}\n`, "utf8"));
  }

  // No store entry: it lives in the docs folder, so the tree lists it by
  // itself. Only linked files outside the folder need remembering.
  tree.refresh();
  await vscode.commands.executeCommand("vscode.open", uri);
}

async function removeInitiative(
  root: string,
  initiative: Initiative,
  store: Store,
  terminals: Terminals,
  tree: InitiativeTree,
): Promise<void> {
  terminals.disposeInitiative(initiative);

  // Nothing on disk is ours to delete: the initiative just pointed at a repo
  // the user already had.
  if (!initiative.managed) {
    const confirmed = await vscode.window.showWarningMessage(
      `Remove initiative "${initiative.name}"?`,
      {
        modal: true,
        detail: "Its agents and shells are forgotten. No files are deleted — this initiative has no worktree of its own, and its docs stay where they are.",
      },
      "Remove",
    );
    if (confirmed !== "Remove") {
      return;
    }
    await store.remove(initiative.id);
    tree.refresh();
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Remove initiative "${initiative.name}"?`,
    {
      modal: true,
      detail: `This deletes the worktree at ${initiative.worktreePath}. The branch "${initiative.branch}" is kept unless you choose otherwise, and the initiative's docs are kept either way.`,
    },
    "Remove worktree",
    "Remove worktree and branch",
  );
  if (!confirmed) {
    return;
  }

  try {
    await removeWorktree(root, initiative.worktreePath, false);
  } catch (error) {
    // Git refuses to drop a worktree with uncommitted work, which is exactly
    // the case where the user deserves a second look before losing it.
    const force = await vscode.window.showWarningMessage(
      `The worktree for "${initiative.name}" has uncommitted changes or untracked files.`,
      { modal: true, detail: `Git said: ${message(error)}` },
      "Discard them and remove",
    );
    if (force !== "Discard them and remove") {
      return;
    }
    try {
      await removeWorktree(root, initiative.worktreePath, true);
    } catch (forceError) {
      vscode.window.showErrorMessage(`Could not remove the worktree: ${message(forceError)}`);
      return;
    }
  }

  if (confirmed === "Remove worktree and branch" && initiative.branch) {
    try {
      await deleteBranch(root, initiative.branch, true);
    } catch (error) {
      vscode.window.showWarningMessage(
        `Worktree removed, but the branch "${initiative.branch}" is still there: ${message(error)}`,
      );
    }
  }

  await store.remove(initiative.id);
  tree.refresh();
}

/**
 * Skills claude can actually invoke here: the user's own and the repo's.
 * Plugin-provided skills are not enumerated; those can still be typed in.
 */
async function availableSkills(worktreePath: string): Promise<string[]> {
  const names = new Set<string>();
  for (const dir of [
    join(homedir(), ".claude", "skills"),
    join(worktreePath, ".claude", "skills"),
  ]) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        await stat(join(dir, entry, "SKILL.md"));
        names.add(entry);
      } catch {
        // Not a skill folder.
      }
    }
  }
  return [...names].sort();
}

function worktreeRoot(root: string, configured: string): string {
  if (!configured) {
    return join(dirname(root), `${basename(root)}-worktrees`);
  }
  return isAbsolute(configured) ? configured : resolve(root, configured);
}
