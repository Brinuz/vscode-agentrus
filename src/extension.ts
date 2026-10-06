import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as vscode from "vscode";
import {
  archiveDocs,
  archiveRoot,
  docsDir,
  ensureArchiveRoot,
  ensureDocsDir,
  hasDocs,
  listArchives,
  listDocFiles,
  MANIFEST,
  trashDocs,
} from "./docs";
import {
  ensureHookSettings,
  ensureStatusDir,
  removeHookFiles,
  removeInitiativeHookFiles,
} from "./hooks";
import {
  addWorktree,
  canonical,
  currentRef,
  deleteBranch,
  headSha,
  listBranches,
  listRemoteBranches,
  mainRepoRoot,
  removeWorktree,
} from "./git";
import {
  Agent,
  AGENT_ICONS,
  agentIcon,
  agentKey,
  DEFAULT_AGENTS,
  Doc,
  Initiative,
  Shell,
  shellKey,
} from "./model";
import { seedWorktree } from "./seed";
import { deleteSessions, launchCommand, sessionExists, sessionName } from "./sessions";
import { Payload } from "./snapshot";
import { ActivityMonitor } from "./status";
import { defaultModel, defaultShells, defaultSkill, Store } from "./store";
import { Terminals } from "./terminals";
import { message, slugify } from "./util";
import { InitiativesViewProvider } from "./view";

const KNOWN_MODELS = ["fable", "opus", "sonnet", "haiku"];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const root = await findRepoRoot();
  const store = new Store(context, root);
  const terminals = new Terminals();
  // Before the monitor, which starts watching this folder the moment it exists.
  await ensureStatusDir(context);
  const activity = new ActivityMonitor(context, store, terminals);

  // The initiative this window is open on. Resolved asynchronously (matching a
  // worktree means canonicalizing paths) and handed to the tree as a plain id.
  let currentId: string | undefined;
  const resolveCurrent = async (): Promise<void> => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== "file") {
      currentId = undefined;
      return;
    }
    // The open FOLDER, not the main repo root: in a worktree window those
    // differ, and it is the worktree that should be expanded.
    const open = await canonical(folder.uri.fsPath);
    const paths = await Promise.all(
      store.all().map(async (i) => ({ id: i.id, path: await canonical(i.worktreePath) })),
    );
    currentId = paths.find((entry) => entry.path === open)?.id;
  };
  await resolveCurrent();

  const view = new InitiativesViewProvider(
    context.extensionUri,
    store,
    terminals,
    (initiative) => listDocFiles(context, initiative),
    activity,
    () => currentId,
    root !== undefined,
  );

  // A file landing in any initiative's docs folder — usually written by an
  // agent — shows up in the view by itself, without a manual refresh.
  const docsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.joinPath(context.globalStorageUri, "docs"), "**"),
  );

  context.subscriptions.push(
    terminals,
    activity,
    terminals.onDidChange(() => {
      // Terminals coming and going is also what starts and stops polling.
      activity.sync();
      view.refresh();
    }),
    activity.onDidChange(() => view.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("agentrus.activityPollSeconds")) {
        activity.sync();
      }
    }),
    vscode.window.registerWebviewViewProvider("agentrus.initiatives", view),
    docsWatcher,
    docsWatcher.onDidCreate(() => view.refresh()),
    docsWatcher.onDidDelete(() => view.refresh()),
  );

  await vscode.commands.executeCommand("setContext", "agentrus.hasRepo", root !== undefined);

  if (root) {
    await store.reconcile(root);
    await resolveCurrent();
    view.refresh();
  }

  /**
   * A payload naming something that is gone is ignored — the webview can be a
   * snapshot behind — and the caller pushes a fresh snapshot instead.
   */
  const initiativeOf = (payload: Payload): Initiative | undefined => {
    const initiative = store.find(payload.initiativeId);
    if (!initiative) {
      view.refresh();
    }
    return initiative;
  };

  const agentOf = (payload: Payload): { initiative: Initiative; agent: Agent } | undefined => {
    const initiative = initiativeOf(payload);
    if (!initiative) {
      return undefined;
    }
    const agent = initiative.agents.find((a) => a.role === payload.role);
    if (!agent) {
      view.refresh();
      return undefined;
    }
    return { initiative, agent };
  };

  const shellOf = (payload: Payload): { initiative: Initiative; shell: Shell } | undefined => {
    const initiative = initiativeOf(payload);
    if (!initiative) {
      return undefined;
    }
    const shell = initiative.shells.find((s) => s.id === payload.shellId);
    if (!shell) {
      view.refresh();
      return undefined;
    }
    return { initiative, shell };
  };

  /**
   * Docs are resolved by path against the same two sources the snapshot uses:
   * the docs folder first, then the initiative's linked files.
   */
  const docOf = async (
    payload: Payload,
  ): Promise<{ initiative: Initiative; doc: Doc } | undefined> => {
    const initiative = initiativeOf(payload);
    if (!initiative) {
      return undefined;
    }
    const files = await listDocFiles(context, initiative);
    const doc =
      files.find((d) => d.path === payload.docPath) ??
      initiative.docs.find((d) => d.path === payload.docPath);
    if (!doc) {
      view.refresh();
      return undefined;
    }
    return { initiative, doc };
  };

  const requireRoot = async (): Promise<string | undefined> => {
    const current = await findRepoRoot();
    if (!current) {
      vscode.window.showErrorMessage('Agent"R"Us needs an open folder that is a git repository.');
    }
    return current;
  };

  /** False when the user dismissed the skill prompt, i.e. nothing was opened. */
  const openAgent = async (initiative: Initiative, chosen: Agent): Promise<boolean> => {
    const claudeCommand = vscode.workspace
      .getConfiguration("agentrus")
      .get<string>("claudeCommand", "claude");

    // Claude refuses to --add-dir a directory that does not exist yet.
    const docs = await ensureDocsDir(context, initiative);

    // Rewritten on every launch, so an agent whose conversation predates the
    // status hooks starts reporting as soon as it is next opened.
    const settings = await ensureHookSettings(context, initiative, chosen);

    // An agent with no skill gets asked once, on its first launch — including
    // when the answer is "none", so it is never asked twice.
    if (!chosen.skill && !chosen.skillChosen) {
      const skill = await pickSkill(
        initiative.worktreePath,
        chosen.skill ?? "",
        `Startup skill for ${chosen.role} — ${initiative.name}`,
      );
      if (skill === undefined) {
        return false;
      }
      await store.updateAgent(initiative.id, chosen.role, {
        skill: skill || undefined,
        skillChosen: true,
      });
      view.refresh();
    }

    // updateAgent mutates the stored agent in place, and the caller holds that
    // same object — but read it back rather than rely on that.
    const agent = store.find(initiative.id)?.agents.find((a) => a.role === chosen.role) ?? chosen;

    // Disk is the source of truth for create-vs-resume: resuming a name with
    // no session behind it opens claude's picker and eats any queued prompt,
    // so the `started` flag alone (stale after a terminal closed before its
    // first message) is not enough to decide.
    const name = sessionName(initiative, agent);
    const started = agent.started ?? false;
    const resume = (await sessionExists(initiative.worktreePath, name)) ?? started;

    const created = terminals.open(initiative, {
      key: agentKey(agent),
      name,
      icon: agentIcon(agent),
      command: launchCommand(claudeCommand, initiative, agent, resume, docs, settings),
    });

    // The conversation exists the moment we launch: from here on we resume it.
    if (created && !started) {
      await store.updateAgent(initiative.id, agent.role, { started: true });
      view.refresh();
    }
    return true;
  };

  /** Runs one of a hub's rows on whatever the hub was opened on. */
  const hub = async (title: string, payload: Payload, rows: HubRow[]): Promise<void> => {
    const picked = await vscode.window.showQuickPick(rows, {
      title,
      placeHolder: "Everything here is also on the right-click menu.",
    });
    if (picked) {
      await vscode.commands.executeCommand(picked.command, payload);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("agentrus.refresh", async () => {
      const current = await findRepoRoot();
      if (current) {
        await store.reconcile(current);
      }
      await resolveCurrent();
      view.refresh();
    }),

    vscode.commands.registerCommand("agentrus.createInitiative", async () => {
      const current = await requireRoot();
      if (current) {
        await createInitiative(current, store, view);
        await resolveCurrent();
        view.refresh();
      }
    }),

    vscode.commands.registerCommand("agentrus.openAgent", async (payload: Payload) => {
      const found = agentOf(payload);
      if (found) {
        await openAgent(found.initiative, found.agent);
      }
    }),

    vscode.commands.registerCommand("agentrus.openAllAgents", async (payload: Payload) => {
      const initiative = initiativeOf(payload);
      if (!initiative) {
        return;
      }
      for (const agent of initiative.agents) {
        // Dismissing an agent's skill prompt stops the whole batch. Skipping to
        // the next one instead would mean pressing Esc once per agent, and
        // still ending up with terminals for the ones already past.
        if (!(await openAgent(initiative, agent))) {
          return;
        }
      }
    }),

    vscode.commands.registerCommand("agentrus.openWorktreeWindow", async (payload: Payload) => {
      const initiative = initiativeOf(payload);
      if (initiative) {
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          vscode.Uri.file(initiative.worktreePath),
          { forceNewWindow: true },
        );
      }
    }),

    vscode.commands.registerCommand("agentrus.openWorktreeHere", async (payload: Payload) => {
      const initiative = initiativeOf(payload);
      if (initiative) {
        // Reloads the window onto the worktree. Terminals do not survive that,
        // but conversations do: the disk check resumes them on the next click.
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          vscode.Uri.file(initiative.worktreePath),
          { forceNewWindow: false },
        );
      }
    }),

    vscode.commands.registerCommand("agentrus.openSettings", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:bmonteiro.agentrus");
    }),

    // Cog on an initiative. Every row is also a right-click entry, so the two
    // paths never disagree about what is available.
    vscode.commands.registerCommand("agentrus.configureInitiative", async (payload: Payload) => {
      const initiative = initiativeOf(payload);
      if (!initiative) {
        return;
      }
      await hub(initiative.name, payload, [
        { label: "$(run-all) Open all agents", command: "agentrus.openAllAgents" },
        { label: "$(person-add) Add agent", command: "agentrus.addAgent" },
        { label: "$(add) New shell", command: "agentrus.newShell" },
        { label: "$(new-file) Add doc", command: "agentrus.addDoc" },
        { label: "$(folder-opened) Reveal docs folder", command: "agentrus.revealDocsFolder" },
        {
          label: "$(arrow-swap) Open worktree in this window",
          description: initiative.worktreePath,
          command: "agentrus.openWorktreeHere",
        },
        {
          label: "$(empty-window) Open worktree in new window",
          command: "agentrus.openWorktreeWindow",
        },
        { label: "$(arrow-up) Move up", command: "agentrus.moveInitiativeUp" },
        { label: "$(arrow-down) Move down", command: "agentrus.moveInitiativeDown" },
        { label: "$(trash) Remove initiative", command: "agentrus.removeInitiative" },
        { label: "$(gear) Extension settings", command: "agentrus.openSettings" },
      ]);
    }),

    vscode.commands.registerCommand("agentrus.configureAgent", async (payload: Payload) => {
      const found = agentOf(payload);
      if (!found) {
        return;
      }
      const { initiative, agent } = found;
      await hub(`${agent.role} — ${initiative.name}`, payload, [
        {
          label: "$(settings-gear) Model",
          description: agent.model,
          command: "agentrus.changeModel",
        },
        {
          label: "$(sparkle) Startup skill",
          description: agent.skill ? `/${agent.skill}` : "none",
          command: "agentrus.changeSkill",
        },
        { label: "$(debug-restart) Start fresh session", command: "agentrus.resetSession" },
        ...(agent.custom
          ? [{ label: "$(trash) Remove agent", command: "agentrus.removeAgent" }]
          : []),
      ]);
    }),

    vscode.commands.registerCommand("agentrus.configureShell", async (payload: Payload) => {
      const found = shellOf(payload);
      if (!found) {
        return;
      }
      await hub(`${found.shell.name} — ${found.initiative.name}`, payload, [
        { label: "$(edit) Rename shell", command: "agentrus.renameShell" },
        { label: "$(trash) Remove shell", command: "agentrus.removeShell" },
      ]);
    }),

    vscode.commands.registerCommand("agentrus.moveInitiativeUp", async (payload: Payload) => {
      if (await store.moveInitiative(payload.initiativeId, -1)) {
        view.refresh();
      }
    }),

    vscode.commands.registerCommand("agentrus.moveInitiativeDown", async (payload: Payload) => {
      if (await store.moveInitiative(payload.initiativeId, 1)) {
        view.refresh();
      }
    }),

    vscode.commands.registerCommand("agentrus.changeModel", async (payload: Payload) => {
      const found = agentOf(payload);
      if (!found) {
        return;
      }
      const { initiative, agent } = found;
      const picked = await vscode.window.showQuickPick(
        KNOWN_MODELS.map((model) => ({
          label: model,
          description: model === agent.model ? "current" : undefined,
        })),
        { title: `Model for ${agent.role} — ${initiative.name}` },
      );
      if (!picked || picked.label === agent.model) {
        return;
      }
      await store.updateAgent(initiative.id, agent.role, { model: picked.label });
      view.refresh();

      if (terminals.isRunning(initiative, agentKey(agent))) {
        vscode.window.showInformationMessage(
          `${agent.role} will use ${picked.label} next time its terminal starts. Close the running terminal to switch now.`,
        );
      }
    }),

    vscode.commands.registerCommand("agentrus.changeSkill", async (payload: Payload) => {
      const found = agentOf(payload);
      if (!found) {
        return;
      }
      const { initiative, agent } = found;
      const current = agent.skill ?? "";
      const skill = await pickSkill(
        initiative.worktreePath,
        current,
        `Startup skill for ${agent.role} — ${initiative.name}`,
      );
      if (skill === undefined) {
        return;
      }
      // Recorded even when unchanged, so the launch prompt stops asking.
      await store.updateAgent(initiative.id, agent.role, {
        skill: skill || undefined,
        skillChosen: true,
      });
      if (skill === current) {
        return;
      }
      view.refresh();

      if (terminals.isRunning(initiative, agentKey(agent))) {
        vscode.window.showInformationMessage(
          `${agent.role} will ${skill ? `load /${skill}` : "load no skill"} next time its terminal starts. Close the running terminal to switch now.`,
        );
      }
    }),

    vscode.commands.registerCommand("agentrus.addAgent", async (payload: Payload) => {
      const initiative = initiativeOf(payload);
      if (initiative) {
        await addAgent(initiative, store, view);
      }
    }),

    vscode.commands.registerCommand("agentrus.removeAgent", async (payload: Payload) => {
      const found = agentOf(payload);
      if (!found) {
        return;
      }
      const { initiative, agent } = found;
      if (!agent.custom) {
        vscode.window.showInformationMessage(
          `${agent.role} is one of the default agents and cannot be removed.`,
        );
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Remove the ${agent.role} agent from "${initiative.name}"?`,
        {
          modal: true,
          detail:
            "Its terminal closes. The conversation's transcript is kept on disk, so adding an agent with this name again later resumes it rather than starting clean — use \"Start fresh session\" before removing if you want it gone for good.",
        },
        "Remove",
      );
      if (confirmed !== "Remove") {
        return;
      }
      terminals.disposeKey(initiative, agentKey(agent));
      await removeHookFiles(context, initiative, agent);
      await store.removeAgent(initiative.id, agent.role);
      view.refresh();
    }),

    vscode.commands.registerCommand("agentrus.resetSession", async (payload: Payload) => {
      const found = agentOf(payload);
      if (!found) {
        return;
      }
      const { initiative, agent } = found;
      const confirmed = await vscode.window.showWarningMessage(
        `Start a fresh session for ${agent.role} on "${initiative.name}"?`,
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
      terminals.disposeKey(initiative, agentKey(agent));
      // Give a just-killed claude a beat to finish writing before its
      // transcript is deleted, so a dying flush cannot resurrect the session.
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await deleteSessions(initiative.worktreePath, sessionName(initiative, agent));
      } catch (error) {
        vscode.window.showErrorMessage(`Could not delete the conversation: ${message(error)}`);
        return;
      }
      await store.updateAgent(initiative.id, agent.role, { started: false });
      view.refresh();
    }),

    vscode.commands.registerCommand("agentrus.newShell", async (payload: Payload) => {
      const initiative = initiativeOf(payload);
      if (!initiative) {
        return;
      }
      const name = await vscode.window.showInputBox({
        title: `New shell — ${initiative.name}`,
        prompt: "A plain terminal in this initiative's directory.",
        value: nextShellName(initiative),
      });
      if (!name) {
        return;
      }
      const shell = await store.addShell(initiative.id, name);
      if (!shell) {
        return;
      }
      view.refresh();
      terminals.open(initiative, {
        key: shellKey(shell),
        name: `${initiative.name}-${shell.name}`,
        icon: "terminal",
      });
    }),

    vscode.commands.registerCommand("agentrus.addDefaultShells", async (payload: Payload) => {
      const initiative = initiativeOf(payload);
      if (!initiative) {
        return;
      }
      const wanted = defaultShells();
      if (wanted.length === 0) {
        vscode.window.showInformationMessage(
          "No default shells configured — set agentrus.defaultShells first.",
        );
        return;
      }
      const missing = wanted.filter(
        (name) => !initiative.shells.some((shell) => shell.name === name),
      );
      for (const name of missing) {
        await store.addShell(initiative.id, name);
      }
      view.refresh();
      vscode.window.showInformationMessage(
        missing.length > 0
          ? `Added ${missing.join(", ")} to "${initiative.name}".`
          : `"${initiative.name}" already has every default shell.`,
      );
    }),

    vscode.commands.registerCommand("agentrus.openShell", (payload: Payload) => {
      const found = shellOf(payload);
      if (found) {
        terminals.open(found.initiative, {
          key: shellKey(found.shell),
          name: `${found.initiative.name}-${found.shell.name}`,
          icon: "terminal",
        });
      }
    }),

    vscode.commands.registerCommand("agentrus.renameShell", async (payload: Payload) => {
      const found = shellOf(payload);
      if (!found) {
        return;
      }
      const { initiative, shell } = found;
      const name = await vscode.window.showInputBox({
        title: `Rename shell — ${initiative.name}`,
        value: shell.name,
        validateInput: (value) => (value.trim() ? undefined : "Give the shell a name."),
      });
      if (!name || name.trim() === shell.name) {
        return;
      }
      await store.renameShell(initiative.id, shell.id, name.trim());
      view.refresh();
      await terminals.rename(initiative, shellKey(shell), `${initiative.name}-${name.trim()}`);
    }),

    vscode.commands.registerCommand("agentrus.removeShell", async (payload: Payload) => {
      const found = shellOf(payload);
      if (!found) {
        return;
      }
      terminals.disposeKey(found.initiative, shellKey(found.shell));
      await store.removeShell(found.initiative.id, found.shell.id);
      view.refresh();
    }),

    vscode.commands.registerCommand("agentrus.addDoc", async (payload: Payload) => {
      const initiative = initiativeOf(payload);
      if (initiative) {
        await addDoc(context, initiative, store, view);
      }
    }),

    vscode.commands.registerCommand("agentrus.revealDocsFolder", async (payload: Payload) => {
      const initiative = initiativeOf(payload);
      if (initiative) {
        const dir = await ensureDocsDir(context, initiative);
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
      }
    }),

    vscode.commands.registerCommand("agentrus.copyArchivePath", async () => {
      const dir = await ensureArchiveRoot(context);
      await vscode.env.clipboard.writeText(dir);
      const reveal = await vscode.window.showInformationMessage(`Copied the archive path: ${dir}`, "Reveal");
      if (reveal === "Reveal") {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
      }
    }),

    vscode.commands.registerCommand("agentrus.openArchivedDocs", async () => {
      const archives = await listArchives(context);
      if (archives.length === 0) {
        vscode.window.showInformationMessage("No initiatives have been archived yet.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        archives.map((archive) => ({
          label: archive.name,
          description: `${archive.branch} · archived ${archive.archived.slice(0, 10)}`,
          detail: `${archive.files.length} files`,
          archive,
        })),
        { title: "Open archived docs", matchOnDescription: true },
      );
      if (!picked) {
        return;
      }
      const file = await vscode.window.showQuickPick(
        [
          { label: "$(folder-opened) Reveal in Finder", id: "reveal" as const, name: "" },
          { label: `$(info) ${MANIFEST}`, id: "file" as const, name: MANIFEST },
          ...picked.archive.files.map((name) => ({
            label: `$(file) ${name}`,
            id: "file" as const,
            name,
          })),
        ],
        { title: `Docs of "${picked.archive.name}"` },
      );
      if (!file) {
        return;
      }
      if (file.id === "file") {
        await vscode.commands.executeCommand(
          "vscode.open",
          vscode.Uri.file(join(picked.archive.path, file.name)),
        );
      } else {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(picked.archive.path));
      }
    }),

    // A card cannot hand vscode.open a Uri, so opening a doc goes through here.
    vscode.commands.registerCommand("agentrus.openDoc", async (payload: Payload) => {
      const found = await docOf(payload);
      if (found) {
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(found.doc.path));
      }
    }),

    vscode.commands.registerCommand("agentrus.revealDoc", async (payload: Payload) => {
      const found = await docOf(payload);
      if (found) {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(found.doc.path));
      }
    }),

    // For docs living in the docs folder there is nothing to unlink — the
    // folder is the source of truth — so the only way to be rid of one is to
    // delete the file. Behind a modal, since it is a real delete.
    vscode.commands.registerCommand("agentrus.deleteDocFile", async (payload: Payload) => {
      const found = await docOf(payload);
      if (!found) {
        return;
      }
      const { doc } = found;
      const confirmed = await vscode.window.showWarningMessage(
        `Delete "${doc.name}"?`,
        {
          modal: true,
          detail: `This deletes the file at ${doc.path}. It goes to the trash, so it can be recovered from there.`,
        },
        "Delete",
      );
      if (confirmed !== "Delete") {
        return;
      }
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(doc.path), { useTrash: true });
      } catch (error) {
        vscode.window.showErrorMessage(`Could not delete the doc: ${message(error)}`);
        return;
      }
      // The docs watcher refreshes the view by itself, but not before the
      // command returns.
      view.refresh();
    }),

    vscode.commands.registerCommand("agentrus.removeDoc", async (payload: Payload) => {
      const found = await docOf(payload);
      if (!found) {
        return;
      }
      // Unlink only. Deleting the user's file because they tidied a card away
      // would be a nasty surprise.
      await store.removeDoc(found.initiative.id, found.doc.id);
      view.refresh();
    }),

    vscode.commands.registerCommand("agentrus.removeInitiative", async (payload: Payload) => {
      const initiative = initiativeOf(payload);
      const current = initiative && (await requireRoot());
      if (initiative && current) {
        await removeInitiative(context, current, initiative, store, terminals, view);
        await resolveCurrent();
        view.refresh();
      }
    }),
  );
}

export function deactivate(): void {
  // Terminals and views are disposed through context.subscriptions.
}

interface HubRow extends vscode.QuickPickItem {
  command: string;
}

async function findRepoRoot(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") {
    return undefined;
  }
  // The MAIN repo root, even when the window has a worktree open: git
  // operations, worktree naming and initiative storage all key off it, so a
  // worktree window behaves exactly like the main one.
  return mainRepoRoot(folder.uri.fsPath);
}

/** First unused "shell N", so deleting one does not suggest a duplicate. */
function nextShellName(initiative: Initiative): string {
  const taken = new Set(initiative.shells.map((shell) => shell.name));
  for (let n = 1; ; n += 1) {
    if (!taken.has(`shell ${n}`)) {
      return `shell ${n}`;
    }
  }
}

/**
 * The skill picker, shared by the launch prompt and the change command.
 * Returns undefined when dismissed and "" for an explicit "no skill" — the
 * caller has to tell those apart to decide whether the question was answered.
 */
async function pickSkill(
  worktreePath: string,
  current: string,
  title: string,
): Promise<string | undefined> {
  const found = await availableSkills(worktreePath);
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
      title,
      placeHolder:
        "Sent as the first message every time this agent's terminal starts, with the docs directory as its argument.",
    },
  );
  if (!picked) {
    return undefined;
  }
  if (picked.id === "none") {
    return "";
  }
  if (picked.id === "skill") {
    return picked.label;
  }

  const entered = await vscode.window.showInputBox({
    title,
    value: current,
    placeHolder: "my-architect-skill",
  });
  if (entered === undefined) {
    return undefined;
  }
  return entered.trim().replace(/^\/+/, "");
}

async function addAgent(initiative: Initiative, store: Store, view: InitiativesViewProvider): Promise<void> {
  const taken = new Set(initiative.agents.map((agent) => agent.role));

  // Initiatives created before `generic` existed are missing it. Offer it as
  // one click rather than four prompts, and mint it exactly as a new
  // initiative would — not as a custom agent — so the two are identical and
  // neither can be removed.
  const missingDefaults = DEFAULT_AGENTS.filter((role) => !taken.has(role));
  if (missingDefaults.length > 0) {
    const preset = await vscode.window.showQuickPick(
      [
        ...missingDefaults.map((role) => ({
          label: `$(${agentIcon({ role, model: "" })}) ${role}`,
          description: `default agent · ${defaultModel(role)}`,
          id: "default" as const,
          role,
        })),
        { label: "$(person-add) Name a new agent…", id: "custom" as const, role: "" },
      ],
      { title: `Add an agent to "${initiative.name}"` },
    );
    if (!preset) {
      return;
    }
    if (preset.id === "default") {
      await store.addAgent(initiative.id, {
        role: preset.role,
        model: defaultModel(preset.role),
        skill: defaultSkill(preset.role),
        started: false,
        generation: 1,
      });
      view.refresh();
      return;
    }
  }

  const role = await vscode.window.showInputBox({
    title: `New agent — ${initiative.name}`,
    prompt: "Names the agent and its conversation. Letters, digits and dashes.",
    placeHolder: "tester",
    validateInput: (value) => {
      const slug = slugify(value);
      if (!slug) {
        return "Give it a name with some letters or digits.";
      }
      // The name reaches a shell command through the session name, so anything
      // slugify would mangle is rejected rather than quietly rewritten.
      if (slug !== value.trim().toLowerCase()) {
        return `Use "${slug}" — letters, digits and dashes only.`;
      }
      return taken.has(slug) ? `"${slug}" already exists in this initiative.` : undefined;
    },
  });
  if (!role) {
    return;
  }
  const name = slugify(role);

  const icon = await vscode.window.showQuickPick(
    AGENT_ICONS.map((codicon) => ({ label: `$(${codicon}) ${codicon}`, codicon })),
    { title: `Icon for ${name}` },
  );
  if (!icon) {
    return;
  }

  const model = await vscode.window.showQuickPick(
    KNOWN_MODELS.map((known) => ({
      label: known,
      description: known === "sonnet" ? "default" : undefined,
    })),
    { title: `Model for ${name}` },
  );
  if (!model) {
    return;
  }

  const skill = await pickSkill(initiative.worktreePath, "", `Startup skill for ${name}`);
  if (skill === undefined) {
    return;
  }

  const agent: Agent = {
    role: name,
    model: model.label,
    skill: skill || undefined,
    skillChosen: true,
    started: false,
    generation: 1,
    custom: true,
    icon: icon.codicon,
  };
  if (!(await store.addAgent(initiative.id, agent))) {
    vscode.window.showErrorMessage(`"${name}" already exists in this initiative.`);
    return;
  }
  view.refresh();
}

interface WorktreePlan {
  branch: string;
  directory: string;
  /** The ref a new branch is cut from, or the remote branch being tracked. */
  baseRef?: string;
  /** Whether the branch is created as a tracking branch for `baseRef`. */
  track?: boolean;
}

/**
 * Shows what is about to be created and lets any of it be changed. Beats the
 * old behaviour of deriving the branch and directory from the initiative name
 * and never showing them.
 */
async function reviewWorktree(
  title: string,
  plan: WorktreePlan,
  editable: { branch: boolean; baseRef: boolean },
  /** Repo root, to spot a directory that would nest inside the working tree. */
  root: string,
  /** Where a given branch would put its worktree by default. */
  derive: (branch: string) => string,
): Promise<WorktreePlan | undefined> {
  const current = { ...plan };
  // The branch and directory start life coupled; renaming the branch should
  // carry the directory along until the user asserts a directory of their own.
  let directoryPinned = false;
  for (;;) {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: `$(git-branch) Branch`,
          description: current.branch,
          detail: editable.branch ? undefined : "existing branch — checked out as-is",
          id: "branch" as const,
        },
        { label: `$(folder) Directory`, description: current.directory, id: "directory" as const },
        ...(current.baseRef !== undefined
          ? [
              {
                label: current.track ? `$(cloud) Tracks` : `$(git-commit) Base ref`,
                description: current.baseRef,
                detail: editable.baseRef ? undefined : "fixed by the branch you picked",
                id: "baseRef" as const,
              },
            ]
          : []),
        { label: "$(check) Create worktree", id: "create" as const },
      ],
      { title, placeHolder: "Pick a row to change it, or create the worktree." },
    );
    if (!picked) {
      return undefined;
    }
    if (picked.id === "create") {
      // Git refuses a non-empty directory, but saying so now beats a failed
      // worktree add after the fact.
      if (await isNonEmptyDir(current.directory)) {
        const anyway = await vscode.window.showWarningMessage(
          `${current.directory} already exists and is not empty.`,
          { modal: true, detail: "Git will refuse to create a worktree there." },
          "Change directory",
        );
        if (anyway === "Change directory") {
          continue;
        }
        return undefined;
      }

      // Git nests a worktree inside its own repo without complaint, and the
      // result is a whole checkout sitting untracked in the working tree —
      // something `git add -A`, a linter, or our own recursive .env copier
      // would happily walk into. Worth a word, not a veto: a gitignored
      // subfolder is a legitimate thing to want.
      if (await isInside(root, current.directory)) {
        const anyway = await vscode.window.showWarningMessage(
          `${current.directory} is inside the repository.`,
          {
            modal: true,
            detail:
              "The worktree would show up as an untracked folder in the repo, and anything that walks the tree — git add, linters, the copyToWorktree step — would descend into it. Fine if you have it gitignored.",
          },
          "Use it anyway",
          "Change directory",
        );
        if (anyway === "Change directory") {
          continue;
        }
        if (anyway !== "Use it anyway") {
          return undefined;
        }
      }
      return current;
    }

    if (picked.id === "branch") {
      if (!editable.branch) {
        continue;
      }
      const entered = await vscode.window.showInputBox({
        title: "Branch name",
        value: current.branch,
        validateInput: invalidBranch,
      });
      if (entered) {
        current.branch = entered.trim();
        if (!directoryPinned) {
          current.directory = derive(current.branch);
        }
      }
      continue;
    }

    if (picked.id === "directory") {
      const entered = await vscode.window.showInputBox({
        title: "Worktree directory",
        value: current.directory,
        prompt: "Set this and it stops following the branch name.",
        validateInput: (value) =>
          isAbsolute(value.trim()) ? undefined : "Needs an absolute path.",
      });
      if (entered) {
        current.directory = entered.trim();
        directoryPinned = true;
      }
      continue;
    }

    if (editable.baseRef) {
      const entered = await vscode.window.showInputBox({
        title: "Branch this initiative off which ref?",
        value: current.baseRef,
      });
      if (entered) {
        current.baseRef = entered.trim();
      }
    }
  }
}

async function isNonEmptyDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    // Missing, or not a directory — either way git will have its own say.
    return false;
  }
}

/** Whether `path` sits under `parent`. Both canonicalized: on macOS /tmp is
 * really /private/tmp, and a symlinked path would otherwise look unrelated. */
async function isInside(parent: string, path: string): Promise<boolean> {
  const [a, b] = await Promise.all([canonical(parent), canonical(path)]);
  const rel = relative(a, b);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Git's rules for a ref name, enough of them to catch a typo early. */
function invalidBranch(value: string): string | undefined {
  const name = value.trim();
  if (!name) {
    return "Give the branch a name.";
  }
  if (/[\s~^:?*[\\]/.test(name)) {
    return "No spaces, and none of ~ ^ : ? * [ \\";
  }
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return "No leading, trailing or doubled slashes.";
  }
  if (name.includes("..") || name.startsWith("-") || name.endsWith(".lock")) {
    return "Cannot contain \"..\", start with \"-\", or end with \".lock\".";
  }
  return undefined;
}

async function createInitiative(root: string, store: Store, view: InitiativesViewProvider): Promise<void> {
  // Two initiatives whose names slugify the same would share a docs folder
  // (docs.ts) and produce the same session names (sessions.ts) — each one's
  // agents writing into the other's notes. Caught here, at the only moment the
  // clash can be introduced.
  const takenSlugs = new Map(store.all().map((i) => [slugify(i.name), i.name]));
  const name = await vscode.window.showInputBox({
    title: "New initiative",
    prompt: "Name this initiative — it gets an architect, a dev, a reviewer and a generic agent.",
    placeHolder: "Auth revamp",
    validateInput: (value) => {
      const slug = slugify(value);
      if (!slug) {
        return "Give it a name with some letters or digits.";
      }
      const clash = takenSlugs.get(slug);
      return clash
        ? `"${clash}" already uses the docs folder "${slug}" — pick a name that differs by more than punctuation.`
        : undefined;
    },
  });
  if (!name) {
    return;
  }

  const config = vscode.workspace.getConfiguration("agentrus");
  const slug = slugify(name);
  const branch = `${config.get<string>("branchPrefix", "initiative/")}${slug}`;
  const worktreeDir = (forBranch: string): string =>
    join(worktreeRoot(root, config.get<string>("worktreeRoot", "")), slugify(forBranch));
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
      {
        label: "$(git-merge) Use an existing branch",
        description: "Isolated checkout on a branch you already have",
        id: "existing" as const,
      },
    ],
    { title: `Where should "${name}" run?` },
  );
  if (!where) {
    return;
  }

  if (where.id === "repo") {
    await store.add(name, root, await currentRef(root), false);
    view.refresh();
    return;
  }

  let plan: WorktreePlan | undefined;
  if (where.id === "worktree") {
    plan = await reviewWorktree(
      `New worktree for "${name}"`,
      { branch, directory: proposed, baseRef: await currentRef(root) },
      { branch: true, baseRef: true },
      root,
      worktreeDir,
    );
  } else {
    const chosen = await pickExistingBranch(root);
    if (!chosen) {
      return;
    }
    plan = await reviewWorktree(
      `Worktree on "${chosen.branch}"`,
      {
        branch: chosen.branch,
        directory: worktreeDir(chosen.branch),
        baseRef: chosen.track ? chosen.remoteRef : undefined,
        track: chosen.track,
      },
      // A local branch's name is not ours to change; a new tracking branch's is.
      { branch: chosen.track, baseRef: false },
      root,
      worktreeDir,
    );
  }
  if (!plan) {
    return;
  }
  const settled = plan;

  let created: string;
  try {
    created = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating worktree for "${name}"…` },
      () =>
        addWorktree(
          root,
          settled.directory,
          settled.branch,
          settled.baseRef ?? settled.branch,
          settled.track,
        ),
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Could not create the worktree: ${message(error)}`);
    return;
  }

  // Untracked config (.env and friends) does not travel with `git worktree
  // add`; carry over whatever the user listed.
  const copies = config.get<string[]>("copyToWorktree", []);
  const failures = await seedWorktree(root, created, copies);
  if (failures.length > 0) {
    vscode.window.showWarningMessage(
      `Worktree created, but some files were not copied — ${failures.join("; ")}`,
    );
  }

  await store.add(name, created, settled.branch, true);
  view.refresh();
}

/**
 * A branch to base the initiative on. Local branches already checked out
 * somewhere are shown but not offered — git allows a branch in one worktree at
 * a time. A remote-only branch gets a local tracking branch instead.
 */
async function pickExistingBranch(
  root: string,
): Promise<{ branch: string; track: boolean; remoteRef?: string } | undefined> {
  let local: Awaited<ReturnType<typeof listBranches>>;
  let remote: string[];
  try {
    [local, remote] = await Promise.all([listBranches(root), listRemoteBranches(root)]);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not list branches: ${message(error)}`);
    return undefined;
  }

  const localNames = new Set(local.map((branch) => branch.name));
  const rows: BranchRow[] = [];

  if (local.length > 0) {
    rows.push({ label: "Local", kind: vscode.QuickPickItemKind.Separator, id: "sep", branch: "" });
    for (const branch of local) {
      rows.push({
        label: branch.name,
        description: branch.worktree ? `in use — ${branch.worktree}` : undefined,
        id: branch.worktree ? "taken" : "local",
        branch: branch.name,
      });
    }
  }

  // Only remotes without a local counterpart: where there is one, pick that.
  const fresh = remote.filter((ref) => !localNames.has(withoutRemote(ref)));
  if (fresh.length > 0) {
    rows.push({ label: "Remote", kind: vscode.QuickPickItemKind.Separator, id: "sep", branch: "" });
    for (const ref of fresh) {
      rows.push({
        label: ref,
        description: "creates a local tracking branch",
        id: "remote",
        branch: ref,
      });
    }
  }

  if (rows.length === 0) {
    vscode.window.showInformationMessage("This repository has no branches to work on yet.");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(rows, {
    title: "Which branch should this initiative work on?",
    matchOnDescription: true,
  });
  if (!picked || picked.id === "sep") {
    return undefined;
  }
  if (picked.id === "taken") {
    vscode.window.showWarningMessage(
      `"${picked.branch}" is already checked out in another worktree — git allows only one at a time.`,
    );
    return undefined;
  }
  if (picked.id === "remote") {
    return { branch: withoutRemote(picked.branch), track: true, remoteRef: picked.branch };
  }
  return { branch: picked.branch, track: false };
}

interface BranchRow extends vscode.QuickPickItem {
  id: "local" | "taken" | "remote" | "sep";
  branch: string;
}

/** "origin/feature/x" → "feature/x", the name a local branch would take. */
function withoutRemote(ref: string): string {
  return ref.split("/").slice(1).join("/");
}

async function addDoc(
  context: vscode.ExtensionContext,
  initiative: Initiative,
  store: Store,
  view: InitiativesViewProvider,
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
    view.refresh();
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
  view.refresh();
  await vscode.commands.executeCommand("vscode.open", uri);
}

async function removeInitiative(
  context: vscode.ExtensionContext,
  root: string,
  initiative: Initiative,
  store: Store,
  terminals: Terminals,
  view: InitiativesViewProvider,
): Promise<void> {
  // Nothing on disk is ours to delete: the initiative just pointed at a repo
  // the user already had.
  if (!initiative.managed) {
    const confirmed = await vscode.window.showWarningMessage(
      `Remove initiative "${initiative.name}"?`,
      {
        modal: true,
        detail: "Its agents and shells are forgotten. The repo is not touched — this initiative has no worktree of its own.",
      },
      "Remove",
    );
    if (confirmed !== "Remove") {
      return;
    }
    const docsChoice = await askDocsChoice(context, initiative);
    if (!docsChoice) {
      return;
    }
    terminals.disposeInitiative(initiative);
    await removeInitiativeHookFiles(context, initiative);
    await disposeDocs(context, initiative, docsChoice, undefined);
    await store.remove(initiative.id);
    view.refresh();
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Remove initiative "${initiative.name}"?`,
    {
      modal: true,
      detail: `This deletes the worktree at ${initiative.worktreePath}. The branch "${initiative.branch}" is kept unless you choose otherwise.`,
    },
    "Remove worktree",
    "Remove worktree and branch",
  );
  if (!confirmed) {
    return;
  }
  const docsChoice = await askDocsChoice(context, initiative);
  if (!docsChoice) {
    return;
  }

  // Read before the worktree goes, for the archive's manifest.
  const head = await headSha(initiative.worktreePath).catch(() => undefined);
  terminals.disposeInitiative(initiative);
  await removeInitiativeHookFiles(context, initiative);

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

  await disposeDocs(context, initiative, docsChoice, head);
  await store.remove(initiative.id);
  view.refresh();
}

type DocsChoice = "Archive docs" | "Delete docs" | "Nothing to keep";

/** Undefined when the user dismissed the question, which cancels the removal. */
async function askDocsChoice(
  context: vscode.ExtensionContext,
  initiative: Initiative,
): Promise<DocsChoice | undefined> {
  if (!(await hasDocs(context, initiative))) {
    return "Nothing to keep";
  }
  return vscode.window.showWarningMessage(
    `What should happen to the docs of "${initiative.name}"?`,
    {
      modal: true,
      detail: `Archive moves the docs folder to ${archiveRoot(context)}, with a note of the branch, commit, agents and linked docs. Delete sends the docs folder to the trash. Linked files outside it are never deleted.`,
    },
    "Archive docs",
    "Delete docs",
  );
}

/**
 * Runs after the worktree is gone, so a failure here only reports: the
 * initiative is removed either way.
 */
async function disposeDocs(
  context: vscode.ExtensionContext,
  initiative: Initiative,
  choice: DocsChoice,
  head: string | undefined,
): Promise<void> {
  const dir = docsDir(context, initiative);
  try {
    if (choice === "Archive docs") {
      await archiveDocs(context, initiative, head);
    } else if (choice === "Delete docs") {
      await trashDocs(context, initiative);
    } else {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Could not dispose of the docs at ${dir}: ${message(error)}`);
  }
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
