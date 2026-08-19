import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { agentIcon, agentKey, Doc, Initiative, shellKey } from "./model";
import { DocCard, InitiativeCard, Message, Snapshot } from "./snapshot";
import { ActivityMonitor } from "./status";
import { Store } from "./store";
import { Terminals } from "./terminals";

/**
 * The Initiatives view. A webview rather than a tree because a tree row is
 * 22px and the workbench offers no way to say otherwise — and an agent has a
 * role, a model, a skill and a status to show.
 */
export class InitiativesViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /** Ticket of the most recent refresh, so a slow snapshot cannot land on a
   * newer one — building one lists the docs folder, which is disk I/O. */
  private pending = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: Store,
    private readonly terminals: Terminals,
    /** Files currently in the initiative's docs folder. */
    private readonly docFiles: (initiative: Initiative) => Promise<Doc[]>,
    private readonly activity: ActivityMonitor,
    /**
     * Id of the initiative this window is open on. Resolved outside the view —
     * matching a worktree means canonicalizing paths, which is asynchronous.
     */
    private readonly currentId: () => string | undefined,
    private readonly hasRepo: boolean,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: Message) => void this.receive(message));
    // No snapshot from here: a message posted before the page's script runs
    // is silently dropped, and nothing would retry — the view sat blank until
    // the next incidental refresh. The page says "ready" when it can render,
    // and that is what triggers the first paint, here and on every re-show.
  }

  /**
   * Not awaited by callers: every command that changes something ends with a
   * refresh, and none of them has anything to do with the result.
   */
  refresh(): void {
    const ticket = (this.pending += 1);
    void this.snapshot().then((snapshot) => {
      if (ticket === this.pending) {
        void this.view?.webview.postMessage(snapshot);
      }
    });
  }

  private async receive(message: Message): Promise<void> {
    if (message.type === "ready") {
      this.refresh();
      return;
    }
    if (message.type === "command") {
      await vscode.commands.executeCommand(message.command, message.payload);
      return;
    }
    if (await this.store.reorderInitiative(message.draggedId, message.ontoId)) {
      this.refresh();
    }
  }

  private async snapshot(): Promise<Snapshot> {
    return {
      hasRepo: this.hasRepo,
      currentId: this.currentId(),
      initiatives: await Promise.all(this.store.all().map((i) => this.card(i))),
    };
  }

  private async card(initiative: Initiative): Promise<InitiativeCard> {
    return {
      id: initiative.id,
      name: initiative.name,
      branch: initiative.branch,
      worktreePath: initiative.worktreePath,
      managed: initiative.managed ?? true,
      agents: initiative.agents.map((agent) => ({
        role: agent.role,
        model: agent.model,
        skill: agent.skill,
        icon: agentIcon(agent),
        custom: agent.custom ?? false,
        started: agent.started ?? false,
        running: this.terminals.isRunning(initiative, agentKey(agent)),
        activity: this.activity.get(initiative, agent),
      })),
      docs: await this.docs(initiative),
      shells: initiative.shells.map((shell) => ({
        id: shell.id,
        name: shell.name,
        running: this.terminals.isRunning(initiative, shellKey(shell)),
      })),
    };
  }

  /**
   * Everything in the docs folder shows up by itself; the store only
   * contributes linked files living elsewhere. A store entry whose file is in
   * the folder (docs created before folder listing existed) is shadowed by
   * the folder's own entry rather than shown twice.
   */
  private async docs(initiative: Initiative): Promise<DocCard[]> {
    const files = await this.docFiles(initiative);
    const filePaths = new Set(files.map((doc) => doc.path));
    return [
      ...files.map((doc) => ({ name: doc.name, path: doc.path, linked: false })),
      ...initiative.docs
        .filter((doc) => !filePaths.has(doc.path))
        .map((doc) => ({ name: doc.name, path: doc.path, linked: true })),
    ];
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, "");
    const asset = (file: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", file));
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <link rel="stylesheet" href="${asset("codicon.css")}" />
    <link rel="stylesheet" href="${asset("webview.css")}" />
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${asset("webview.js")}"></script>
  </body>
</html>`;
  }
}
