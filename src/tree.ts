import * as vscode from "vscode";
import { Agent, Initiative, ROLE_ICONS } from "./model";
import { Store } from "./store";
import { Terminals } from "./terminals";

export class InitiativeItem extends vscode.TreeItem {
  readonly contextValue = "initiative";

  constructor(readonly initiative: Initiative) {
    super(initiative.name, vscode.TreeItemCollapsibleState.Expanded);
    this.description = initiative.branch;
    this.tooltip = new vscode.MarkdownString(
      [`**${initiative.name}**`, "", `Branch: \`${initiative.branch}\``, `Worktree: \`${initiative.worktreePath}\``].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon("git-branch");
    this.resourceUri = vscode.Uri.file(initiative.worktreePath);
  }
}

export class AgentItem extends vscode.TreeItem {
  readonly contextValue = "agent";

  constructor(
    readonly initiative: Initiative,
    readonly agent: Agent,
    running: boolean,
  ) {
    super(agent.role, vscode.TreeItemCollapsibleState.None);
    this.description = running ? `${agent.model} · live` : agent.model;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${agent.role}** — \`${agent.model}\``,
        "",
        running ? "Terminal is open." : "Click to open; the session resumes where it left off.",
        "",
        `Session: \`${agent.sessionId}\``,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(
      ROLE_ICONS[agent.role],
      running ? new vscode.ThemeColor("charts.green") : undefined,
    );
    this.command = {
      command: "agentrus.openAgent",
      title: "Open Agent Session",
      arguments: [this],
    };
  }
}

type Node = InitiativeItem | AgentItem;

export class InitiativeTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly store: Store,
    private readonly terminals: Terminals,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      return this.store.all().map((initiative) => new InitiativeItem(initiative));
    }
    if (element instanceof InitiativeItem) {
      return element.initiative.agents.map(
        (agent) =>
          new AgentItem(element.initiative, agent, this.terminals.isRunning(element.initiative, agent)),
      );
    }
    return [];
  }
}
