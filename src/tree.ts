import { basename } from "node:path";
import * as vscode from "vscode";
import { Agent, agentIcon, agentKey, Doc, Initiative, Shell, shellKey } from "./model";
import { Activity, ActivityMonitor } from "./status";
import { Store } from "./store";
import { Terminals } from "./terminals";

export type GroupKind = "agents" | "docs" | "shells";

/** Identifies an initiative row being dragged within our own tree. */
const MIME = "application/vnd.code.tree.agentrus.initiatives";

export class InitiativeItem extends vscode.TreeItem {
  readonly contextValue = "initiative";

  constructor(
    readonly initiative: Initiative,
    /** The initiative this window is actually open on, if any. */
    current = false,
  ) {
    super(
      initiative.name,
      // Everything starts collapsed; only the one you have open is worth
      // unfolding on sight.
      current
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    // Stable identity, so VS Code tracks expansion per initiative rather than
    // per label, and so `reveal` can find the row again.
    this.id = initiative.id;
    const managed = initiative.managed ?? true;
    // Marked in text rather than colour: colour already means working, needs
    // you and idle on the agent rows below, and a fourth meaning would blunt
    // all three.
    const where = initiative.branch ?? basename(initiative.worktreePath);
    this.description = current ? `${where} · this window` : where;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${initiative.name}**`,
        "",
        initiative.branch ? `Branch: \`${initiative.branch}\`` : "",
        `${managed ? "Worktree" : "Directory"}: \`${initiative.worktreePath}\``,
        managed ? "" : "\nUses the repo as-is — no worktree of its own.",
        current ? "\nOpen in this window." : "",
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
    this.id = `${initiative.id}:${kind}`;
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
  constructor(
    readonly initiative: Initiative,
    readonly agent: Agent,
    running: boolean,
    /** What the transcript says the agent is doing, when it is running. */
    activity?: Activity,
  ) {
    super(agent.role, vscode.TreeItemCollapsibleState.None);
    // Only agents the user added may be removed; the defaults stay put.
    this.contextValue = agent.custom ? "agent-custom" : "agent";
    const skill = agent.skill ? ` · /${agent.skill}` : "";
    this.description = `${agent.model}${skill}${state(running, activity)}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${agent.role}** — \`${agent.model}\``,
        agent.skill ? `Startup skill: \`/${agent.skill}\`` : "",
        "",
        running
          ? runningTooltip(activity)
          : agent.started
            ? "Click to reopen; the conversation resumes where it left off."
            : "Click to start this agent's conversation.",
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(
      running ? icon(agent, activity) : agentIcon(agent),
      running ? new vscode.ThemeColor(color(activity)) : undefined,
    );
    this.command = {
      command: "agentrus.openAgent",
      title: "Open Agent Session",
      arguments: [this],
    };
  }
}

function state(running: boolean, activity?: Activity): string {
  if (!running) {
    return "";
  }
  switch (activity) {
    case "working":
      return " · working…";
    case "needs-you":
      return " · needs you";
    case "idle":
      return " · idle";
    default:
      // Without a verdict there is nothing to say beyond "the terminal is
      // there", which is what "live" has always meant.
      return " · live";
  }
}

/**
 * Traffic lights: green is clear to take, yellow is busy, red is stopped and
 * waiting on you.
 *
 * The yellow is the terminal's rather than `charts.yellow`, which is a
 * desaturated gold too close to its warmer neighbours to tell apart at icon
 * size — the one thing this colouring exists for.
 */
function color(activity?: Activity): string {
  switch (activity) {
    case "working":
      return "terminal.ansiYellow";
    case "needs-you":
      return "charts.red";
    default:
      return "charts.green";
  }
}

/**
 * `~spin` is the only animation a tree row can have, so it is spent on being
 * busy: the rows in motion are the ones to leave alone, which leaves the
 * still, orange bell as the thing your eye lands on. An agent keeps its own
 * icon whenever it is neither working nor blocked.
 */
function icon(agent: Agent, activity?: Activity): string {
  switch (activity) {
    case "working":
      return "loading~spin";
    case "needs-you":
      return "bell";
    default:
      return agentIcon(agent);
  }
}

function runningTooltip(activity?: Activity): string {
  switch (activity) {
    case "working":
      return "Mid-turn — working on something.";
    case "needs-you":
      return "Waiting for you — it asked for permission or input.";
    case "idle":
      return "Finished; nothing pending.";
    default:
      return "Terminal is open.";
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
  constructor(
    readonly initiative: Initiative,
    readonly doc: Doc,
    /** Linked docs are store entries the user can unlink; files found in the
     * docs folder are not — they would reappear on the next refresh. */
    linked: boolean,
  ) {
    super(doc.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = linked ? "doc" : "doc-file";
    if (doc.name !== basename(doc.path)) {
      this.description = basename(doc.path);
    }
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

export class InitiativeTree
  implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>
{
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  readonly dropMimeTypes = [MIME];
  readonly dragMimeTypes = [MIME];

  constructor(
    private readonly store: Store,
    private readonly terminals: Terminals,
    /** Files currently in the initiative's docs folder. */
    private readonly docFiles: (initiative: Initiative) => Promise<Doc[]>,
    private readonly activity: ActivityMonitor,
    /**
     * Id of the initiative this window is open on. Resolved outside the tree —
     * matching a worktree means canonicalizing paths, which cannot happen
     * inside a synchronous `getTreeItem`.
     */
    private readonly currentId: () => string | undefined,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  /** Required for `reveal`, which is how the open initiative gets expanded. */
  getParent(element: Node): Node | undefined {
    if (element instanceof InitiativeItem) {
      return undefined;
    }
    if (element instanceof GroupItem) {
      return new InitiativeItem(element.initiative, this.isCurrent(element.initiative));
    }
    const kind: GroupKind =
      element instanceof AgentItem ? "agents" : element instanceof ShellItem ? "shells" : "docs";
    return new GroupItem(element.initiative, kind, 0);
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      return this.store
        .all()
        .map((initiative) => new InitiativeItem(initiative, this.isCurrent(initiative)));
    }

    if (element instanceof InitiativeItem) {
      const { initiative } = element;
      return [
        new GroupItem(initiative, "agents", initiative.agents.length),
        new GroupItem(initiative, "docs", (await this.docs(initiative)).length),
        new GroupItem(initiative, "shells", initiative.shells.length),
      ];
    }

    if (element instanceof GroupItem) {
      const { initiative } = element;
      switch (element.kind) {
        case "agents":
          return initiative.agents.map(
            (agent) =>
              new AgentItem(
                initiative,
                agent,
                this.terminals.isRunning(initiative, agentKey(agent)),
                this.activity.get(initiative, agent),
              ),
          );
        case "docs":
          return this.docs(initiative);
        case "shells":
          return initiative.shells.map(
            (shell) =>
              new ShellItem(initiative, shell, this.terminals.isRunning(initiative, shellKey(shell))),
          );
      }
    }

    return [];
  }

  handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
    const dragged = source.filter((node): node is InitiativeItem => node instanceof InitiativeItem);
    if (dragged.length === 0) {
      return;
    }
    data.set(MIME, new vscode.DataTransferItem(dragged[0].initiative.id));
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
    const dragged = data.get(MIME)?.value;
    if (typeof dragged !== "string") {
      return;
    }
    // Dropping anywhere inside an initiative means "put it here" — the user
    // should not have to hit the initiative row exactly.
    const onto = target?.initiative.id;
    if (await this.store.reorderInitiative(dragged, onto)) {
      this.refresh();
    }
  }

  private isCurrent(initiative: Initiative): boolean {
    return this.currentId() === initiative.id;
  }

  /**
   * Everything in the docs folder shows up by itself; the store only
   * contributes linked files living elsewhere. A store entry whose file is in
   * the folder (docs created before folder listing existed) is shadowed by
   * the folder's own entry rather than shown twice.
   */
  private async docs(initiative: Initiative): Promise<DocItem[]> {
    const files = await this.docFiles(initiative);
    const filePaths = new Set(files.map((doc) => doc.path));
    const linked = initiative.docs.filter((doc) => !filePaths.has(doc.path));
    return [
      ...files.map((doc) => new DocItem(initiative, doc, false)),
      ...linked.map((doc) => new DocItem(initiative, doc, true)),
    ];
  }
}
