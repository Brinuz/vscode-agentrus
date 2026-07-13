import { Agent, Initiative } from "./model";

/**
 * Claude has no way to tell us whether a session exists: there is no list
 * command, and the transcript is not discoverable on disk by session id.
 * Passing `--session-id` for an id that is already in use is a hard error
 * ("Session ID <id> is already in use."), so we remember whether we have
 * launched this agent before and resume from then on.
 */
export function launchCommand(
  claudeCommand: string,
  agent: Agent,
  started: boolean,
): string {
  const claim = `${claudeCommand} --session-id ${agent.sessionId} --model ${agent.model}`;
  if (!started) {
    return claim;
  }

  // Resume, but fall back to claiming the id if there is nothing to resume:
  // an agent whose terminal was closed before its first message never got a
  // conversation, and would otherwise be stuck failing to resume forever.
  const resume = `${claudeCommand} --resume ${agent.sessionId} --model ${agent.model}`;
  return `${resume} || ${claim}`;
}

/** Terminal title: what the user asked to see instead of a UUID. */
export function terminalName(initiative: Initiative, agent: Agent): string {
  return `${initiative.name}-${agent.role}-${agent.model}`;
}
