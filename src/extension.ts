import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";
import { addWorktree, currentRef, deleteBranch, removeWorktree, repoRoot } from "./git";
import { Store } from "./store";
import { Terminals } from "./terminals";
import { AgentItem, InitiativeItem, InitiativeTree } from "./tree";

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
      if (!current) {
        return;
      }
      await createInitiative(current, store, tree);
    }),

    vscode.commands.registerCommand("agentrus.openAgent", async (item: AgentItem) => {
      await terminals.open(item.initiative, item.agent);
    }),

    vscode.commands.registerCommand("agentrus.openAllAgents", async (item: InitiativeItem) => {
      for (const agent of item.initiative.agents) {
        await terminals.open(item.initiative, agent);
      }
    }),

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

      if (terminals.isRunning(item.initiative, item.agent)) {
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
            "This agent will point at a brand new conversation. The existing transcript stays on disk but Agentrus will no longer link to it.",
        },
        "Start fresh",
      );
      if (confirmed !== "Start fresh") {
        return;
      }
      terminals.disposeAgent(item.initiative, item.agent);
      await store.updateAgent(item.initiative.id, item.agent.role, { sessionId: randomUUID() });
      tree.refresh();
    }),

    vscode.commands.registerCommand("agentrus.removeInitiative", async (item: InitiativeItem) => {
      const current = await requireRoot();
      if (!current) {
        return;
      }
      await removeInitiative(current, item.initiative, store, terminals, tree);
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
  initiative: ReturnType<Store["all"]>[number],
  store: Store,
  terminals: Terminals,
  tree: InitiativeTree,
): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    `Remove initiative "${initiative.name}"?`,
    {
      modal: true,
      detail: `This deletes the worktree at ${initiative.worktreePath} and closes its agent terminals. The branch "${initiative.branch}" is kept unless you choose otherwise.`,
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
