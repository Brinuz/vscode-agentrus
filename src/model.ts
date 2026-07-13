export const ROLES = ["architect", "dev", "reviewer"] as const;

export type Role = (typeof ROLES)[number];

export interface Agent {
  role: Role;
  /** Model alias passed to `claude --model`, e.g. "fable" or "opus". */
  model: string;
  /**
   * UUID we mint ourselves and hand to `claude --session-id`. Claude requires
   * a UUID here, so this stays internal; the user sees the initiative name.
   */
  sessionId: string;
  /** Whether the id has been claimed, i.e. later launches must `--resume`. */
  started?: boolean;
}

/** A plain terminal in the initiative's worktree — no Claude attached. */
export interface Shell {
  id: string;
  name: string;
}

/** A file that belongs to the initiative. Path is relative to the worktree. */
export interface Doc {
  id: string;
  name: string;
  path: string;
}

export interface Initiative {
  id: string;
  name: string;
  branch: string;
  /** Absolute path of the git worktree backing this initiative. */
  worktreePath: string;
  agents: Agent[];
  shells: Shell[];
  docs: Doc[];
  createdAt: number;
}

export const ROLE_ICONS: Record<Role, string> = {
  architect: "compass",
  dev: "tools",
  reviewer: "search",
};

/** Terminal key, unique within an initiative. */
export function agentKey(agent: Agent): string {
  return `agent:${agent.role}`;
}

export function shellKey(shell: Shell): string {
  return `shell:${shell.id}`;
}
