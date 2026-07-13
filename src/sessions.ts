import { Agent, Initiative } from "./model";

/**
 * The session's identity and its label, both at once: passed as `--name` when
 * the conversation is created and as `--resume` to get back into it.
 *
 * Deliberately excludes the model, so switching an agent from fable to opus
 * keeps pointing at the same conversation instead of renaming it out of reach.
 * The generation suffix is what "start fresh" bumps, since a same-named
 * session would otherwise just resume the old conversation.
 */
export function sessionName(initiative: Initiative, agent: Agent): string {
  const generation = agent.generation ?? 1;
  const suffix = generation > 1 ? `-${generation}` : "";
  return `${initiative.name}-${agent.role}${suffix}`;
}

/**
 * Claude cannot tell us whether a session exists (no list command), so we
 * remember whether we have launched this agent and resume from then on.
 */
export function launchCommand(
  claudeCommand: string,
  initiative: Initiative,
  agent: Agent,
  started: boolean,
): string {
  const name = quote(sessionName(initiative, agent));
  const create = `${claudeCommand} --name ${name} --model ${agent.model}`;
  if (!started) {
    return create;
  }

  // Resume, falling back to creating it: an agent whose terminal was closed
  // before its first message has no conversation to resume, and would
  // otherwise be stuck failing forever.
  return `${claudeCommand} --resume ${name} --model ${agent.model} || ${create}`;
}

/** Names carry spaces, so they have to survive the shell. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
