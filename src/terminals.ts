import * as vscode from "vscode";
import { Initiative } from "./model";

export interface TerminalSpec {
  /** Unique within the initiative, e.g. "agent:dev" or "shell:<uuid>". */
  key: string;
  name: string;
  icon: string;
  /** Sent once, when the terminal is created. Shells pass nothing. */
  command?: string;
}

/**
 * Owns one integrated terminal per agent or shell. Clicking reveals the
 * terminal if it is still alive, and otherwise starts a fresh one.
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

  isRunning(initiative: Initiative, key: string): boolean {
    return this.terminals.has(id(initiative, key));
  }

  /** True if the terminal had to be created, i.e. the command was sent. */
  open(initiative: Initiative, spec: TerminalSpec): boolean {
    const existing = this.terminals.get(id(initiative, spec.key));
    if (existing) {
      existing.show(false);
      return false;
    }

    const terminal = vscode.window.createTerminal({
      name: spec.name,
      cwd: initiative.worktreePath,
      iconPath: new vscode.ThemeIcon(spec.icon),
      location: location(),
    });
    this.terminals.set(id(initiative, spec.key), terminal);
    this.changed.fire();

    if (spec.command) {
      terminal.sendText(spec.command);
    }
    terminal.show(false);
    return true;
  }

  /**
   * Relabel a live terminal's tab. VS Code exposes no API for this — only a
   * command acting on whichever terminal is *active*, so the terminal has to be
   * focused first.
   *
   * `show()` returns void and the workbench applies it asynchronously, so
   * firing the command straight after could rename whatever was active before —
   * a terminal the user never asked to touch. Hence the wait, and the check.
   * Doing nothing is a fine outcome: the tree label is already right and the
   * tab catches up when the terminal is next recreated.
   */
  async rename(initiative: Initiative, key: string, name: string): Promise<void> {
    const terminal = this.terminals.get(id(initiative, key));
    if (!terminal) {
      return;
    }

    terminal.show(false);
    if (vscode.window.activeTerminal !== terminal && !(await this.becameActive(terminal))) {
      return;
    }

    try {
      await vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name });
    } catch {
      // Older VS Code, or the command refused; the label still updated.
    }
  }

  /** Resolves true once this terminal is the active one, false if it never is. */
  private becameActive(terminal: vscode.Terminal): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (result: boolean): void => {
        subscription.dispose();
        clearTimeout(timer);
        resolve(result);
      };
      const subscription = vscode.window.onDidChangeActiveTerminal((active) => {
        if (active === terminal) {
          done(true);
        }
      });
      const timer = setTimeout(() => done(false), 2000);
    });
  }

  /** Close one terminal, e.g. before repointing an agent at a new session. */
  disposeKey(initiative: Initiative, key: string): void {
    const terminal = this.terminals.get(id(initiative, key));
    if (terminal) {
      terminal.dispose();
      this.terminals.delete(id(initiative, key));
      this.changed.fire();
    }
  }

  /**
   * Close every terminal belonging to an initiative that is going away, and
   * wait for them to go. `dispose()` only asks; an agent still writing into
   * the worktree while git deletes it leaves a half-removed tree behind.
   */
  async disposeInitiative(initiative: Initiative): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [key, terminal] of [...this.terminals]) {
      if (key.startsWith(`${initiative.id}:`)) {
        closing.push(closed(terminal));
        terminal.dispose();
        this.terminals.delete(key);
      }
    }
    this.changed.fire();
    await Promise.all(closing);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

/** Resolves once VS Code reports the terminal closed, or after a few seconds
 * so a terminal that never reports cannot hold up the caller. */
function closed(terminal: vscode.Terminal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      subscription.dispose();
      clearTimeout(timer);
      resolve();
    };
    const subscription = vscode.window.onDidCloseTerminal((closing) => {
      if (closing === terminal) {
        done();
      }
    });
    const timer = setTimeout(done, 5000);
  });
}

function id(initiative: Initiative, key: string): string {
  return `${initiative.id}:${key}`;
}

/** Where new terminals open. Read per terminal, so the setting takes effect
 * on the next one without a reload. */
function location(): vscode.TerminalLocation {
  const configured = vscode.workspace
    .getConfiguration("agentrus")
    .get<string>("terminalLocation", "panel");
  return configured === "editor"
    ? vscode.TerminalLocation.Editor
    : vscode.TerminalLocation.Panel;
}
