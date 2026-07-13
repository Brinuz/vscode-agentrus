import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as vscode from "vscode";
import { addWorktree, currentRef, deleteBranch, removeWorktree, repoRoot } from "./git";
import { agentKey, Initiative, ROLE_ICONS, shellKey } from "./model";
import { launchCommand, sessionName } from "./sessions";
import { Store } from "./store";
import { Terminals } from "./terminals";
import { AgentItem, DocItem, GroupItem, InitiativeItem, InitiativeTree, ShellItem } from "./tree";

const KNOWN_MODELS = ["fable", "opus", "sonnet", "haiku"];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new Store(context);
  const terminals = new Terminals();
  const tree = new InitiativeTree(store, terminals);

  context.subscriptions.push(
    terminals,
    terminals.onDidChange(() => tree.refresh()),
    vscode.window.createTreeView("agentrus.initiatives", { treeDataProvider: tree }),
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
      vscode.window.showErrorMessage("Agentrus needs an open folder that is a git repository.");
    }
    return current;
  };

  const openAgent = async (item: AgentItem): Promise<void> => {
    const claudeCommand = vscode.workspace
      .getConfiguration("agentrus")
      .get<string>("claudeCommand", "claude");

    const started = item.agent.started ?? false;
    const created = terminals.open(item.initiative, {
      key: agentKey(item.agent),
      name: sessionName(item.initiative, item.agent),
      icon: ROLE_ICONS[item.agent.role],
      command: launchCommand(claudeCommand, item.initiative, item.agent, started),
    });

    // The id is claimed the moment we launch: from here on, `--session-id`
    // would fail with "already in use" and we must resume instead.
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

    vscode.commands.registerCommand("agentrus.resetSession", async (item: AgentItem) => {
      const confirmed = await vscode.window.showWarningMessage(
        `Start a fresh session for ${item.agent.role} on "${item.initiative.name}"?`,
        {
          modal: true,
          detail:
            "This agent will point at a brand new conversation. The existing one is left alone, but Agentrus will no longer link to it.",
        },
        "Start fresh",
      );
      if (confirmed !== "Start fresh") {
        return;
      }
      terminals.disposeKey(item.initiative, agentKey(item.agent));
      // A same-named session would just resume the old conversation, so the
      // new one needs a name of its own.
      await store.updateAgent(item.initiative.id, item.agent.role, {
        generation: (item.agent.generation ?? 1) + 1,
        started: false,
      });
      tree.refresh();
    }),

    vscode.commands.registerCommand(
      "agentrus.newShell",
      async (item: InitiativeItem | GroupItem) => {
        const name = await vscode.window.showInputBox({
          title: `New shell — ${item.initiative.name}`,
          prompt: "A plain terminal in this initiative's worktree.",
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
        await addDoc(item.initiative, store, tree);
      },
    ),

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

async function addDoc(initiative: Initiative, store: Store, tree: InitiativeTree): Promise<void> {
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
    const rel = relative(initiative.worktreePath, file.fsPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      vscode.window.showErrorMessage("Pick a file inside the initiative's worktree.");
      return;
    }
    await store.addDoc(initiative.id, basename(file.fsPath), rel);
    tree.refresh();
    await vscode.commands.executeCommand("vscode.open", file);
    return;
  }

  const name = await vscode.window.showInputBox({
    title: `New doc — ${initiative.name}`,
    prompt: "Created under docs/ in the initiative's worktree.",
    placeHolder: "Design notes",
    validateInput: (value) => (slugify(value) ? undefined : "Give it a name with some letters or digits."),
  });
  if (!name) {
    return;
  }

  const rel = join("docs", `${slugify(name)}.md`);
  const uri = vscode.Uri.file(join(initiative.worktreePath, rel));
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    // Does not exist yet, so seed it rather than opening a phantom file.
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`# ${name}\n`, "utf8"));
  }

  await store.addDoc(initiative.id, name, rel);
  tree.refresh();
  await vscode.commands.executeCommand("vscode.open", uri);
}

async function createInitiative(root: string, store: Store, tree: InitiativeTree): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "New initiative",
    prompt: "Name this initiative — it gets its own branch, worktree, and three agents.",
    placeHolder: "Auth revamp",
    validateInput: (value) => (slugify(value) ? undefined : "Give it a name with some letters or digits."),
  });
  if (!name) {
    return;
  }

  const config = vscode.workspace.getConfiguration("agentrus");
  const slug = slugify(name);
  const branch = `${config.get<string>("branchPrefix", "initiative/")}${slug}`;
  const worktreePath = join(worktreeRoot(root, config.get<string>("worktreeRoot", "")), slug);

  const baseRef = await vscode.window.showInputBox({
    title: "Branch this initiative off which ref?",
    value: await currentRef(root),
    prompt: `Creates branch "${branch}" and a worktree at ${worktreePath}`,
  });
  if (!baseRef) {
    return;
  }

  let created: string;
  try {
    created = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating worktree for "${name}"…` },
      () => addWorktree(root, worktreePath, branch, baseRef),
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Could not create the worktree: ${message(error)}`);
    return;
  }

  await store.add(name, branch, created);
  tree.refresh();
}

async function removeInitiative(
  root: string,
  initiative: Initiative,
  store: Store,
  terminals: Terminals,
  tree: InitiativeTree,
): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    `Remove initiative "${initiative.name}"?`,
    {
      modal: true,
      detail: `This deletes the worktree at ${initiative.worktreePath} and closes its terminals. The branch "${initiative.branch}" is kept unless you choose otherwise.`,
    },
    "Remove worktree",
    "Remove worktree and branch",
  );
  if (!confirmed) {
    return;
  }

  terminals.disposeInitiative(initiative);

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

  if (confirmed === "Remove worktree and branch") {
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

function worktreeRoot(root: string, configured: string): string {
  if (!configured) {
    return join(dirname(root), `${basename(root)}-worktrees`);
  }
  return isAbsolute(configured) ? configured : resolve(root, configured);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function message(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr: unknown }).stderr).trim();
    if (stderr) {
      return stderr;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
