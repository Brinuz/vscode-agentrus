export const ROLES = ["architect", "dev", "reviewer"] as const;

export type Role = (typeof ROLES)[number];

export interface Agent {
  role: Role;
  /** Model alias passed to `claude --model`, e.g. "fable" or "opus". */
  model: string;
  /** UUID we mint ourselves and hand to `claude --session-id`. */
  sessionId: string;
}

export interface Initiative {
  id: string;
  name: string;
  branch: string;
  /** Absolute path of the git worktree backing this initiative. */
  worktreePath: string;
  agents: Agent[];
  createdAt: number;
}

export const ROLE_ICONS: Record<Role, string> = {
  architect: "compass",
  dev: "tools",
  reviewer: "search",
};
