import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { Agent, Doc, Initiative, Role, ROLES, Shell } from "./model";
import { canonical, listWorktrees } from "./git";

const KEY = "agentrus.initiatives";

export class Store {
  private initiatives: Initiative[];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.initiatives = context.workspaceState.get<Initiative[]>(KEY, []).map((i) => ({
      ...i,
      // Stored before shells and docs existed: the tree would throw on the
      // missing arrays.
      shells: i.shells ?? [],
      docs: i.docs ?? [],
      // Agents used to be identified by a minted UUID and their conversations
      // were created without a title, so there is no name to resume them by.
      // Start those agents over rather than resuming into an error.
      agents: i.agents.map((agent) =>
        "sessionId" in agent
          ? { role: agent.role, model: agent.model, started: false, generation: 1 }
          : agent,
      ),
    }));
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
        started: false,
        generation: 1,
      })),
      shells: [],
      docs: [],
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
    change: Partial<Pick<Agent, "model" | "started" | "generation">>,
  ): Promise<void> {
    const agent = this.find(initiativeId)?.agents.find((a) => a.role === role);
    if (!agent) {
      return;
    }
    Object.assign(agent, change);
    await this.flush();
  }

  async addShell(initiativeId: string, name: string): Promise<Shell | undefined> {
    const initiative = this.find(initiativeId);
    if (!initiative) {
      return undefined;
    }
    const shell: Shell = { id: randomUUID(), name };
    initiative.shells.push(shell);
    await this.flush();
    return shell;
  }

  async removeShell(initiativeId: string, shellId: string): Promise<void> {
    const initiative = this.find(initiativeId);
    if (!initiative) {
      return;
    }
    initiative.shells = initiative.shells.filter((s) => s.id !== shellId);
    await this.flush();
  }

  async addDoc(initiativeId: string, name: string, path: string): Promise<Doc | undefined> {
    const initiative = this.find(initiativeId);
    if (!initiative) {
      return undefined;
    }
    const existing = initiative.docs.find((d) => d.path === path);
    if (existing) {
      return existing;
    }
    const doc: Doc = { id: randomUUID(), name, path };
    initiative.docs.push(doc);
    await this.flush();
    return doc;
  }

  async removeDoc(initiativeId: string, docId: string): Promise<void> {
    const initiative = this.find(initiativeId);
    if (!initiative) {
      return;
    }
    initiative.docs = initiative.docs.filter((d) => d.id !== docId);
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
