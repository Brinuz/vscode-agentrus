import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import * as vscode from "vscode";
import { Agent, DEFAULT_AGENTS, Doc, Initiative, Role, Shell } from "./model";
import { canonical, listWorktrees } from "./git";

/** Pre-repo-keyed storage: one list per workspace folder. */
const LEGACY_KEY = "agentrus.initiatives";

export class Store {
  private initiatives: Initiative[];
  private readonly key: string | undefined;
  private readonly orderKey: string | undefined;

  /**
   * Initiatives are stored in global storage keyed by the main repo root, so
   * a window on the repo and a window on one of its worktrees see the same
   * list. Earlier versions kept them in workspaceState; that data is moved
   * over the first time the repo's window activates.
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    root: string | undefined,
  ) {
    this.key = root === undefined ? undefined : `agentrus.initiatives/${root}`;
    this.orderKey = root === undefined ? undefined : `agentrus.ordered/${root}`;
    const stored = this.key ? context.globalState.get<Initiative[]>(this.key) : undefined;
    const legacy = root ? context.workspaceState.get<Initiative[]>(LEGACY_KEY) : undefined;

    this.initiatives = (stored ?? legacy ?? []).map((i) => ({
      ...i,
      // Stored before shells and docs existed: the tree would throw on the
      // missing arrays.
      shells: i.shells ?? [],
      // Doc paths used to be relative to the worktree, before docs moved out
      // of the repo and into the extension's storage.
      docs: (i.docs ?? []).map((doc) =>
        isAbsolute(doc.path) ? doc : { ...doc, path: join(i.worktreePath, doc.path) },
      ),
      // Every initiative predating the prompt owned its worktree.
      managed: i.managed ?? true,
      // Agents used to be identified by a minted UUID and their conversations
      // were created without a title, so there is no name to resume them by.
      // Start those agents over rather than resuming into an error.
      agents: withDefaults(
        i.agents.map((agent) =>
          "sessionId" in agent
            ? { role: agent.role, model: agent.model, started: false, generation: 1 }
            : agent,
        ),
      ),
    }));

    if (stored === undefined && legacy !== undefined) {
      void this.flush();
      void context.workspaceState.update(LEGACY_KEY, undefined);
    }

    // The array order IS the display order now that initiatives can be
    // reordered. It used to be sorted by createdAt on every read, so the
    // stored order is settled once — after that the user's arrangement stands.
    if (this.orderKey && !context.globalState.get<boolean>(this.orderKey)) {
      this.initiatives.sort((a, b) => a.createdAt - b.createdAt);
      void this.flush();
      void context.globalState.update(this.orderKey, true);
    }
  }

  all(): Initiative[] {
    return [...this.initiatives];
  }

  find(id: string): Initiative | undefined {
    return this.initiatives.find((i) => i.id === id);
  }

  async add(
    name: string,
    worktreePath: string,
    branch: string | undefined,
    managed: boolean,
  ): Promise<Initiative> {
    const initiative: Initiative = {
      id: randomUUID(),
      name,
      branch,
      worktreePath,
      managed,
      createdAt: Date.now(),
      agents: DEFAULT_AGENTS.map((role) => ({
        role,
        model: defaultModel(role),
        skill: defaultSkill(role),
        started: false,
        generation: 1,
      })),
      shells: defaultShells().map((shellName) => ({ id: randomUUID(), name: shellName })),
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

  /**
   * Move an initiative by `delta` places. Clamped rather than wrapped: nudging
   * the top row up should do nothing, not send it to the bottom.
   */
  async moveInitiative(id: string, delta: number): Promise<boolean> {
    const from = this.initiatives.findIndex((i) => i.id === id);
    if (from === -1) {
      return false;
    }
    const to = Math.min(Math.max(from + delta, 0), this.initiatives.length - 1);
    if (to === from) {
      return false;
    }
    const [moved] = this.initiatives.splice(from, 1);
    this.initiatives.splice(to, 0, moved);
    await this.flush();
    return true;
  }

  /** Drop the dragged initiative in front of the one it was dropped on. */
  async reorderInitiative(draggedId: string, targetId: string | undefined): Promise<boolean> {
    if (draggedId === targetId) {
      return false;
    }
    const from = this.initiatives.findIndex((i) => i.id === draggedId);
    if (from === -1) {
      return false;
    }
    const [moved] = this.initiatives.splice(from, 1);
    // Dropped past the last row: the target is gone, so it goes to the end.
    const target = targetId ? this.initiatives.findIndex((i) => i.id === targetId) : -1;
    this.initiatives.splice(target === -1 ? this.initiatives.length : target, 0, moved);
    await this.flush();
    return true;
  }

  async updateAgent(
    initiativeId: string,
    role: Role,
    change: Partial<Pick<Agent, "model" | "skill" | "skillChosen" | "started" | "generation" | "icon">>,
  ): Promise<void> {
    const agent = this.find(initiativeId)?.agents.find((a) => a.role === role);
    if (!agent) {
      return;
    }
    Object.assign(agent, change);
    await this.flush();
  }

  /**
   * Add an agent the user named. Returns undefined when the name is taken:
   * the name is the agent's identity, so two of them would collide on terminal
   * key and Claude session name alike.
   */
  async addAgent(initiativeId: string, agent: Agent): Promise<Agent | undefined> {
    const initiative = this.find(initiativeId);
    if (!initiative || initiative.agents.some((a) => a.role === agent.role)) {
      return undefined;
    }
    initiative.agents.splice(slotFor(initiative.agents, agent.role), 0, agent);
    await this.flush();
    return agent;
  }

  async removeAgent(initiativeId: string, role: Role): Promise<void> {
    const initiative = this.find(initiativeId);
    if (!initiative) {
      return;
    }
    initiative.agents = initiative.agents.filter((a) => a.role !== role);
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

  async renameShell(initiativeId: string, shellId: string, name: string): Promise<void> {
    const shell = this.find(initiativeId)?.shells.find((s) => s.id === shellId);
    if (!shell) {
      return;
    }
    shell.name = name;
    await this.flush();
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
   *
   * Only applies to worktrees Agentrus created. An initiative that just uses
   * the repo as-is has no worktree of its own and must never be pruned.
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
      this.initiatives.map(async (i) =>
        !i.managed || live.has(await canonical(i.worktreePath)) ? i : undefined,
      ),
    );
    this.initiatives = survivors.filter((i): i is Initiative => i !== undefined);
    if (this.initiatives.length === before) {
      return false;
    }
    await this.flush();
    return true;
  }

  private async flush(): Promise<void> {
    if (this.key) {
      await this.context.globalState.update(this.key, this.initiatives);
    }
  }
}

/**
 * Give an initiative the default agents it predates, each in its usual place.
 * A default can never be removed, so one that is missing only ever means the
 * initiative is older than it — there is no choice of the user's to preserve.
 */
function withDefaults(agents: Agent[]): Agent[] {
  const filled = [...agents];
  for (const role of DEFAULT_AGENTS) {
    if (filled.some((agent) => agent.role === role)) {
      continue;
    }
    filled.splice(slotFor(filled, role), 0, {
      role,
      model: defaultModel(role),
      skill: defaultSkill(role),
      started: false,
      generation: 1,
    });
  }
  return filled;
}

/**
 * Where an agent joins the list. A default one takes its place in
 * DEFAULT_AGENTS order, so an initiative that predates it ends up looking like
 * one created today instead of carrying it after the agents the user named.
 */
function slotFor(agents: Agent[], role: Role): number {
  const rank = rankOf(role);
  const next = agents.findIndex((agent) => rankOf(agent.role) > rank);
  return next < 0 ? agents.length : next;
}

/** Defaults sort in DEFAULT_AGENTS order; agents the user named come after. */
function rankOf(role: Role): number {
  const rank = DEFAULT_AGENTS.indexOf(role);
  return rank < 0 ? DEFAULT_AGENTS.length : rank;
}

/**
 * Only the default agents have a configured model; one the user added by hand
 * has no setting to read, so it falls back to sonnet.
 */
export function defaultModel(role: Role): string {
  const config = vscode.workspace.getConfiguration("agentrus");
  return config.get<string>(`models.${role}`) || "sonnet";
}

export function defaultSkill(role: Role): string | undefined {
  const config = vscode.workspace.getConfiguration("agentrus");
  return config.get<string>(`skills.${role}`) || undefined;
}

/** Shells every new initiative starts with, unopened until clicked. */
export function defaultShells(): string[] {
  const config = vscode.workspace.getConfiguration("agentrus");
  return config
    .get<string[]>("defaultShells", [])
    .map((name) => name.trim())
    .filter((name, index, all) => name.length > 0 && all.indexOf(name) === index);
}
