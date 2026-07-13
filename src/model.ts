export const ROLES = ["architect", "dev", "reviewer"] as const;

export type Role = (typeof ROLES)[number];

export interface Agent {
  role: Role;
  /** Model alias passed to `claude --model`, e.g. "fable" or "opus". */
  model: string;
  /** Whether the conversation exists, i.e. later launches must `--resume`. */
  started?: boolean;
  /** Bumped by "start fresh" to name a new conversation. Defaults to 1. */
  generation?: number;
}

/** A plain terminal in the initiative's worktree — no Claude attached. */
export interface Shell {
  id: string;
  name: string;
}

/**
 * A file that belongs to the initiative. Absolute: docs normally live in the
 * extension's storage, but a linked file can be anywhere.
 */
export interface Doc {
  id: string;
  name: string;
  path: string;
}

export interface Initiative {
  id: string;
  name: string;
  /** Branch the initiative works on. Absent when it just uses the repo as-is. */
  branch?: string;
  /** Absolute directory the agents, shells and docs run in. */
  worktreePath: string;
  /**
   * Whether Agentrus created the worktree. Only then may it remove the
   * directory, or treat a missing worktree as a dead initiative.
   */
  managed?: boolean;
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
