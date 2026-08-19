import type { Activity } from "./status";

/**
 * Everything the view draws. Built in the extension and posted whole on every
 * change — the webview holds no model of its own beyond which cards are
 * folded shut.
 */
export interface Snapshot {
  hasRepo: boolean;
  /** The initiative this window is open on, if any. */
  currentId?: string;
  initiatives: InitiativeCard[];
}

export interface InitiativeCard {
  id: string;
  name: string;
  branch?: string;
  worktreePath: string;
  managed: boolean;
  agents: AgentCard[];
  docs: DocCard[];
  shells: ShellCard[];
}

export interface AgentCard {
  role: string;
  model: string;
  skill?: string;
  icon: string;
  custom: boolean;
  started: boolean;
  running: boolean;
  activity?: Activity;
}

export interface DocCard {
  name: string;
  path: string;
  /**
   * Linked docs are store entries the user can unlink; files found in the
   * docs folder are not — they would reappear on the next refresh.
   */
  linked: boolean;
}

export interface ShellCard {
  id: string;
  name: string;
  running: boolean;
}

/**
 * What a command handler receives. Clicks and right-click menus produce the
 * same keys: the menu's come from each card's `data-vscode-context`, so the
 * two paths can never disagree about what a command is being run on.
 */
export interface Payload {
  initiativeId: string;
  role?: string;
  shellId?: string;
  docPath?: string;
}

/** Messages the webview posts back to the extension. */
export type Message =
  | { type: "ready" }
  | { type: "command"; command: string; payload?: Payload }
  | { type: "reorder"; draggedId: string; ontoId?: string };
