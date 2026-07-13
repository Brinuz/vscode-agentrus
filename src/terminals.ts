import * as vscode from "vscode";
import { Agent, Initiative, ROLE_ICONS } from "./model";
import { launchCommand } from "./sessions";

function key(initiative: Initiative, agent: Agent): string {
  return `${initiative.id}:${agent.role}`;
}

/**
 * Owns one integrated terminal per agent. Clicking an agent reveals its
 * terminal if it is still alive, and otherwise starts a new one that resumes
 * the same Claude session.
 */
export class Terminals implements vscode.Disposable {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly subscription: vscode.Disposable;
  private readonly changed = new vscode.EventEmitter<void>();

  /** Fires when a terminal appears or disappears, so the tree can restyle. */
  readonly onDidChange = this.changed.event;

  constructor() {
    this.subscription = vscode.window.onDidCloseTerminal((closed) => {
      for (const [id, terminal] of this.terminals) {
        if (terminal === closed) {
          this.terminals.delete(id);
          this.changed.fire();
        }
      }
    });
  }

  isRunning(initiative: Initiative, agent: Agent): boolean {
    return this.terminals.has(key(initiative, agent));
  }

  async open(initiative: Initiative, agent: Agent): Promise<void> {
    const id = key(initiative, agent);
    const existing = this.terminals.get(id);
    if (existing) {
      existing.show(false);
      return;
    }

    const claudeCommand = vscode.workspace
      .getConfiguration("agentrus")
      .get<string>("claudeCommand", "claude");

    const terminal = vscode.window.createTerminal({
      name: `${initiative.name} · ${agent.role}`,
      cwd: initiative.worktreePath,
      iconPath: new vscode.ThemeIcon(ROLE_ICONS[agent.role]),
    });
    this.terminals.set(id, terminal);
    this.changed.fire();

    terminal.sendText(await launchCommand(claudeCommand, agent.sessionId, agent.model));
    terminal.show(false);
  }

  /** Close a single agent's terminal, e.g. before repointing it at a new session. */
  disposeAgent(initiative: Initiative, agent: Agent): void {
    const id = key(initiative, agent);
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.dispose();
      this.terminals.delete(id);
      this.changed.fire();
    }
  }

  /** Close every terminal belonging to an initiative that is going away. */
  disposeInitiative(initiative: Initiative): void {
    for (const [id, terminal] of [...this.terminals]) {
      if (id.startsWith(`${initiative.id}:`)) {
        terminal.dispose();
        this.terminals.delete(id);
      }
    }
    this.changed.fire();
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
