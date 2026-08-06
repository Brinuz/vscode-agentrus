/** Agents minted for every new initiative, in tree order. */
export const DEFAULT_AGENTS = ["architect", "dev", "reviewer", "generic"] as const;

/**
 * An agent's name, unique within its initiative. Not a closed set: initiatives
 * can carry extra agents the user named. It stays the agent's identity — the
 * terminal key and the Claude session name both derive from it — so renaming
 * one would orphan its conversation, and adding one must check for collisions.
 */
export type Role = string;

export interface Agent {
  role: Role;
  /** Model alias passed to `claude --model`, e.g. "fable" or "opus". */
  model: string;
  /**
   * Skill invoked as the first message of every launch, e.g. "architect".
   * The initiative's docs directory is appended as its argument.
   */
  skill?: string;
  /**
   * Whether the user has been asked which skill this agent should load. Set
   * even when they answered "none", so the launch prompt asks exactly once.
   */
  skillChosen?: boolean;
  /** Whether the conversation exists, i.e. later launches must `--resume`. */
  started?: boolean;
  /**
   * Legacy suffix from when "start fresh" renamed the session instead of
   * deleting it. Kept so conversations named that way still resolve.
   */
  generation?: number;
  /** Set on agents the user added by hand — only those may be removed. */
  custom?: boolean;
  /** Codicon for a custom agent; the defaults have their own icons. */
  icon?: string;
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

const DEFAULT_ICONS: Record<string, string> = {
  architect: "compass",
  dev: "tools",
  reviewer: "search",
  generic: "comment-discussion",
};

/** Icons offered when naming a custom agent. */
export const AGENT_ICONS = [
  "person",
  "comment-discussion",
  "beaker",
  "bug",
  "book",
  "rocket",
  "shield",
  "graph",
];

/** An explicitly chosen icon wins: only the defaults fall back to the map. */
export function agentIcon(agent: Agent): string {
  return agent.icon ?? DEFAULT_ICONS[agent.role] ?? "person";
}

/** Terminal key, unique within an initiative. */
export function agentKey(agent: Agent): string {
  return `agent:${agent.role}`;
}

export function shellKey(shell: Shell): string {
  return `shell:${shell.id}`;
}
