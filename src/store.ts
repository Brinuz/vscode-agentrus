import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { Initiative, Role, ROLES } from "./model";
import { canonical, listWorktrees } from "./git";

const KEY = "agentrus.initiatives";

export class Store {
  private initiatives: Initiative[];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.initiatives = context.workspaceState.get<Initiative[]>(KEY, []);
  }

  all(): Initiative[] {
    return [...this.initiatives].sort((a, b) => a.createdAt - b.createdAt);
  }

  find(id: string): Initiative | undefined {
    return this.initiatives.find((i) => i.id === id);
  }

  async add(name: string, branch: string, worktreePath: string): Promise<Initiative> {
    const initiative: Initiative = {
      id: randomUUID(),
      name,
      branch,
      worktreePath,
      createdAt: Date.now(),
      agents: ROLES.map((role) => ({
        role,
        model: defaultModel(role),
        sessionId: randomUUID(),
      })),
    };
    this.initiatives.push(initiative);
    await this.flush();
    return initiative;
  }

  async remove(id: string): Promise<void> {
    this.initiatives = this.initiatives.filter((i) => i.id !== id);
    await this.flush();
  }

  async updateAgent(
    initiativeId: string,
    role: Role,
    change: { model?: string; sessionId?: string },
  ): Promise<void> {
    const agent = this.find(initiativeId)?.agents.find((a) => a.role === role);
    if (!agent) {
      return;
    }
    Object.assign(agent, change);
    await this.flush();
  }

  /**
   * Drop initiatives whose worktree no longer exists. Git is the source of
   * truth: if the user ran `git worktree remove` by hand, the tree should not
   * keep showing an initiative that has nowhere to run.
   */
  async reconcile(root: string): Promise<boolean> {
    let live: Set<string>;
    try {
      live = new Set(await listWorktrees(root));
    } catch {
      return false;
    }
    const before = this.initiatives.length;
    const survivors = await Promise.all(
      this.initiatives.map(async (i) => (live.has(await canonical(i.worktreePath)) ? i : undefined)),
    );
    this.initiatives = survivors.filter((i): i is Initiative => i !== undefined);
    if (this.initiatives.length === before) {
      return false;
    }
    await this.flush();
    return true;
  }

  private async flush(): Promise<void> {
    await this.context.workspaceState.update(KEY, this.initiatives);
  }
}

export function defaultModel(role: Role): string {
  const config = vscode.workspace.getConfiguration("agentrus");
  return config.get<string>(`models.${role}`) ?? "sonnet";
}
