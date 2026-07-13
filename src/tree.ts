import { basename } from "node:path";
import * as vscode from "vscode";
import { Agent, agentKey, Doc, Initiative, ROLE_ICONS, Shell, shellKey } from "./model";
import { Store } from "./store";
import { Terminals } from "./terminals";

export type GroupKind = "agents" | "docs" | "shells";

export class InitiativeItem extends vscode.TreeItem {
  readonly contextValue = "initiative";

  constructor(readonly initiative: Initiative) {
    super(initiative.name, vscode.TreeItemCollapsibleState.Expanded);
    const managed = initiative.managed ?? true;
    this.description = initiative.branch ?? basename(initiative.worktreePath);
    this.tooltip = new vscode.MarkdownString(
      [
        `**${initiative.name}**`,
        "",
        initiative.branch ? `Branch: \`${initiative.branch}\`` : "",
        `${managed ? "Worktree" : "Directory"}: \`${initiative.worktreePath}\``,
        managed ? "" : "\nUses the repo as-is — no worktree of its own.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(managed ? "git-branch" : "repo");
    this.resourceUri = vscode.Uri.file(initiative.worktreePath);
  }
}

export class GroupItem extends vscode.TreeItem {
  constructor(
    readonly initiative: Initiative,
    readonly kind: GroupKind,
    count: number,
  ) {
    super(LABELS[kind], vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = `group:${kind}`;
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon(GROUP_ICONS[kind]);
  }
}

const LABELS: Record<GroupKind, string> = {
  agents: "Agents",
  docs: "Docs",
  shells: "Shells",
};

const GROUP_ICONS: Record<GroupKind, string> = {
  agents: "organization",
  docs: "book",
  shells: "terminal",
};

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
        running
          ? "Terminal is open."
          : agent.started
            ? "Click to reopen; the conversation resumes where it left off."
            : "Click to start this agent's conversation.",
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

export class ShellItem extends vscode.TreeItem {
  readonly contextValue = "shell";

  constructor(
    readonly initiative: Initiative,
    readonly shell: Shell,
    running: boolean,
  ) {
    super(shell.name, vscode.TreeItemCollapsibleState.None);
    this.description = running ? "live" : undefined;
    this.tooltip = `Terminal in ${initiative.worktreePath}`;
    this.iconPath = new vscode.ThemeIcon(
      "terminal",
      running ? new vscode.ThemeColor("charts.green") : undefined,
    );
    this.command = {
      command: "agentrus.openShell",
      title: "Open Shell",
      arguments: [this],
    };
  }
}

export class DocItem extends vscode.TreeItem {
  readonly contextValue = "doc";

  constructor(
    readonly initiative: Initiative,
    readonly doc: Doc,
  ) {
    super(doc.name, vscode.TreeItemCollapsibleState.None);
    this.description = basename(doc.path);
    this.tooltip = doc.path;
    this.resourceUri = vscode.Uri.file(doc.path);
    this.command = {
      command: "vscode.open",
      title: "Open Doc",
      arguments: [this.resourceUri],
    };
  }
}

type Node = InitiativeItem | GroupItem | AgentItem | ShellItem | DocItem;

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
      const { initiative } = element;
      return [
        new GroupItem(initiative, "agents", initiative.agents.length),
        new GroupItem(initiative, "docs", initiative.docs.length),
        new GroupItem(initiative, "shells", initiative.shells.length),
      ];
    }

    if (element instanceof GroupItem) {
      const { initiative } = element;
      switch (element.kind) {
        case "agents":
          return initiative.agents.map(
            (agent) =>
              new AgentItem(initiative, agent, this.terminals.isRunning(initiative, agentKey(agent))),
          );
        case "docs":
          return initiative.docs.map((doc) => new DocItem(initiative, doc));
        case "shells":
          return initiative.shells.map(
            (shell) =>
              new ShellItem(initiative, shell, this.terminals.isRunning(initiative, shellKey(shell))),
          );
      }
    }

    return [];
  }
}
