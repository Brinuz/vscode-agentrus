import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { Agent, Initiative } from "./model";
import { shellQuote, slugify } from "./util";

/**
 * What an agent's own process says it is doing, rather than what its
 * transcript implies. Claude fires these on its way through a turn, so the
 * state arrives as an event instead of being inferred a few seconds late.
 *
 * `PostToolUse` is the one that runs per tool call rather than once a turn,
 * and it earns that cost: approving a permission prompt fires nothing, so
 * without it a blocked agent would keep claiming to need you for the whole
 * rest of the turn. A finished tool call is the only evidence that the block
 * cleared.
 */
export type HookEvent =
  | "UserPromptSubmit"
  | "PostToolUse"
  | "Notification"
  | "Stop"
  | "SessionEnd";

const EVENTS: HookEvent[] = [
  "UserPromptSubmit",
  "PostToolUse",
  "Notification",
  "Stop",
  "SessionEnd",
];

export interface HookStatus {
  event: HookEvent;
  /**
   * `Notification`'s own message. It is the only thing separating "Claude
   * needs your permission" from the nudge Claude sends after going quiet, and
   * those mean opposite things to the tree.
   */
  message?: string;
}

/**
 * Settings and status both live in the extension's global storage, next to
 * `docs/` — see `docsDir` for the same reasoning. The user's own
 * `~/.claude/settings.json` is never written to: these hooks belong to
 * Agentrus, not to the machine.
 *
 * One pair of files per agent. That is what lets each hook command hard-code
 * the status path it writes to, so nothing has to map a session id back to an
 * agent at read time.
 */
export function settingsPath(
  context: vscode.ExtensionContext,
  initiative: Initiative,
  agent: Agent,
): string {
  return join(context.globalStorageUri.fsPath, "hooks", `${fileName(initiative, agent)}.json`);
}

export function statusPath(
  context: vscode.ExtensionContext,
  initiative: Initiative,
  agent: Agent,
): string {
  return join(context.globalStorageUri.fsPath, "status", `${fileName(initiative, agent)}.status`);
}

/**
 * The initiative's id rather than its name: names repeat, and two initiatives
 * sharing a status file would show each other's state. The role rides along
 * only to keep the folder readable while debugging.
 */
function fileName(initiative: Initiative, agent: Agent): string {
  return `${initiative.id}-${slugify(agent.role)}`;
}

/**
 * Create the status folder before anything watches it. A file watcher pointed
 * at a directory that does not exist yet is not reliably armed when one
 * appears, and on a fresh install nothing creates this until the first agent
 * launches — long after activation set the watcher up.
 */
export async function ensureStatusDir(context: vscode.ExtensionContext): Promise<void> {
  await mkdir(join(context.globalStorageUri.fsPath, "status"), { recursive: true });
}

/**
 * Write the settings file this agent launches with, and return its path for
 * `--settings`. Rewritten on every launch, so a change here reaches existing
 * agents the next time they start.
 */
export async function ensureHookSettings(
  context: vscode.ExtensionContext,
  initiative: Initiative,
  agent: Agent,
): Promise<string> {
  const settings = settingsPath(context, initiative, agent);
  const status = statusPath(context, initiative, agent);
  await mkdir(dirname(settings), { recursive: true });
  await mkdir(dirname(status), { recursive: true });
  await writeFile(settings, JSON.stringify(hookSettings(status), null, 2));
  return settings;
}

function hookSettings(status: string): unknown {
  const entry = (command: string): unknown => [{ matcher: "", hooks: [{ type: "command", command }] }];
  return {
    hooks: {
      UserPromptSubmit: entry(record("UserPromptSubmit", status)),
      PostToolUse: entry(record("PostToolUse", status)),
      Notification: entry(record("Notification", status)),
      Stop: entry(record("Stop", status)),
      // A finished conversation should leave nothing behind claiming it is
      // mid-turn; with the file gone the transcript reader takes over again.
      SessionEnd: entry(`rm -f ${shellQuote(status)}`),
    },
  };
}

/**
 * Record the event name, then whatever claude passes on stdin.
 *
 * Written to a temp file and moved into place because `mv` within one
 * filesystem is atomic: the watcher can fire at any moment, and half a file is
 * worse than a stale one.
 */
function record(event: HookEvent, status: string): string {
  const target = shellQuote(status);
  const temp = shellQuote(`${status}.tmp`);
  return `{ printf '${event}\\n'; cat; } > ${temp} && mv ${temp} ${target}`;
}

/**
 * The agent's last hook event, or undefined when it has none — an agent whose
 * conversation predates hooks, or one that ended.
 */
export async function readStatus(path: string): Promise<HookStatus | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  const newline = text.indexOf("\n");
  const name = (newline === -1 ? text : text.slice(0, newline)).trim();
  const event = EVENTS.find((known) => known === name);
  if (!event) {
    return undefined;
  }
  return { event, message: payloadMessage(newline === -1 ? "" : text.slice(newline + 1)) };
}

function payloadMessage(json: string): string | undefined {
  try {
    const payload = JSON.parse(json) as { message?: unknown };
    return typeof payload.message === "string" ? payload.message : undefined;
  } catch {
    // No payload, or a half-written one; the event name still stands.
    return undefined;
  }
}

/** Drop an agent's files when it is removed, so nothing is orphaned. */
export async function removeHookFiles(
  context: vscode.ExtensionContext,
  initiative: Initiative,
  agent: Agent,
): Promise<void> {
  await rm(settingsPath(context, initiative, agent), { force: true });
  await rm(statusPath(context, initiative, agent), { force: true });
}

export async function removeInitiativeHookFiles(
  context: vscode.ExtensionContext,
  initiative: Initiative,
): Promise<void> {
  await Promise.all(initiative.agents.map((agent) => removeHookFiles(context, initiative, agent)));
}
