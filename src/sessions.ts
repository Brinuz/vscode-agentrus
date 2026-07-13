import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * True once Claude has written a transcript for this session id.
 *
 * Claude Code encodes the project cwd into the directory name under
 * ~/.claude/projects, and the encoding is undocumented, so we scan every
 * project directory for the transcript rather than reconstructing the path.
 * That keeps this working if the encoding ever changes, and it stays honest if
 * the user deletes a session behind our back.
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
  const target = `${sessionId}.jsonl`;
  let projects: string[];
  try {
    projects = await readdir(PROJECTS_DIR);
  } catch {
    return false;
  }

  for (const project of projects) {
    try {
      const entries = await readdir(join(PROJECTS_DIR, project));
      if (entries.includes(target)) {
        return true;
      }
    } catch {
      // Not a readable directory; skip it.
    }
  }
  return false;
}

/**
 * Command line that lands the user in `sessionId`: resume it if Claude has a
 * transcript for it, otherwise claim the id for a brand new conversation.
 */
export async function launchCommand(
  claudeCommand: string,
  sessionId: string,
  model: string,
): Promise<string> {
  const flag = (await sessionExists(sessionId))
    ? `--resume ${sessionId}`
    : `--session-id ${sessionId}`;
  return `${claudeCommand} ${flag} --model ${model}`;
}
