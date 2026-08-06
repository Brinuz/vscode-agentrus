import { open, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonical } from "./git";
import { Agent, Initiative } from "./model";
import { shellQuote as quote } from "./util";

/**
 * The session's identity and its label, both at once: passed as `--name` when
 * the conversation is created and as `--resume` to get back into it.
 *
 * Deliberately excludes the model, so switching an agent from fable to opus
 * keeps pointing at the same conversation instead of renaming it out of reach.
 * The generation suffix is legacy: "start fresh" used to rename the session
 * rather than delete it, and those old names must keep resolving.
 */
export function sessionName(initiative: Initiative, agent: Agent): string {
  const generation = agent.generation ?? 1;
  const suffix = generation > 1 ? `-${generation}` : "";
  return `${initiative.name}-${agent.role}${suffix}`;
}

/**
 * Whether to resume is decided by `sessionExists` — claude has no list
 * command, but the transcripts on disk know.
 *
 * `docsDir` sits outside the working tree, so it is granted explicitly with
 * --add-dir; without it the agent could not read the initiative's docs.
 *
 * `settingsPath` carries this agent's status hooks. It rides on resumes too,
 * so conversations started before hooks existed pick them up on their next
 * launch. Claude merges hook layers rather than replacing them, so the user's
 * own hooks keep firing alongside ours.
 */
export function launchCommand(
  claudeCommand: string,
  initiative: Initiative,
  agent: Agent,
  resume: boolean,
  docsDir: string,
  settingsPath: string,
): string {
  const name = quote(sessionName(initiative, agent));
  const flags = `--model ${agent.model} --settings ${quote(settingsPath)} --add-dir ${quote(docsDir)}`;
  // The startup skill goes to resumes too, not just the first launch: it
  // re-briefs the agent after compaction may have eroded the original
  // instructions. The docs directory rides along as the skill's argument,
  // since the skill has no other way to learn where this initiative's docs
  // live.
  //
  // The "--" is load-bearing: --add-dir is variadic and would otherwise
  // swallow the prompt as just another directory, silently.
  const prompt = agent.skill ? ` -- ${quote(`/${agent.skill} docs-dir: ${docsDir}`)}` : "";
  const create = `${claudeCommand} --name ${name} ${flags}${prompt}`;
  if (!resume) {
    return create;
  }

  // Resume, falling back to creating it: an agent whose terminal was closed
  // before its first message has no conversation to resume, and would
  // otherwise be stuck failing forever.
  return `${claudeCommand} --resume ${name} ${flags}${prompt} || ${create}`;
}

/**
 * Transcripts on disk whose session carries this name. Claude stores them
 * under a folder derived from the session's cwd (every non-alphanumeric
 * character flattened to "-"); a session created with --name records
 * `"agentName"` in the head of its transcript.
 *
 * Returns undefined when the project folder exists but cannot be read. A
 * missing folder means no session ever ran there.
 */
export async function namedTranscripts(
  worktreePath: string,
  name: string,
): Promise<string[] | undefined> {
  const dir = join(
    homedir(),
    ".claude",
    "projects",
    (await canonical(worktreePath)).replace(/[^a-zA-Z0-9]/g, "-"),
  );

  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
  }

  const token = `"agentName":${JSON.stringify(name)}`;
  const matches: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) {
      continue;
    }
    try {
      // The agent-name record sits in the first few lines of a transcript
      // created with --name; reading a bounded head keeps big project
      // folders cheap to scan.
      const handle = await open(join(dir, file), "r");
      try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(65536), 0, 65536, 0);
        if (buffer.toString("utf8", 0, bytesRead).includes(token)) {
          matches.push(join(dir, file));
        }
      } finally {
        await handle.close();
      }
    } catch {
      // A vanished or unreadable transcript is not the one we look for.
    }
  }
  return matches;
}

/**
 * Whether a conversation with this name exists for this directory, judged by
 * the transcripts on disk.
 *
 * Resuming a name that resolves to nothing does NOT fail: claude opens its
 * session picker, silently discards any queued prompt, and exits 0 unless the
 * picker is dismissed — so a `|| create` fallback rarely fires and the user
 * is left staring at a picker. The only reliable way to decide create-vs-
 * resume is to look at the transcripts.
 *
 * Returns undefined when the project folder exists but cannot be read; the
 * caller falls back to what it remembers.
 */
export async function sessionExists(
  worktreePath: string,
  name: string,
): Promise<boolean | undefined> {
  const matches = await namedTranscripts(worktreePath, name);
  return matches && matches.length > 0;
}

/**
 * Delete every transcript carrying this name, so the next launch creates a
 * brand new conversation under the very same name instead of resuming.
 */
export async function deleteSessions(worktreePath: string, name: string): Promise<number> {
  const matches = (await namedTranscripts(worktreePath, name)) ?? [];
  await Promise.all(matches.map((file) => rm(file, { force: true })));
  return matches.length;
}
