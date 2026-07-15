import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { message } from "./util";

/**
 * Copy configured files from the main repo into a freshly created worktree.
 * `git worktree add` only materializes tracked files, so untracked config
 * like `.env` has to be carried over by hand.
 *
 * Entries are paths relative to the repo root. An entry starting with `**\/`
 * matches that file name anywhere in the repo (skipping `.git` and
 * `node_modules`), keeping its relative location in the worktree.
 *
 * Returns a description per entry that could not be copied.
 */
export async function seedWorktree(
  root: string,
  worktree: string,
  entries: string[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      const paths = await resolveEntry(root, entry);
      if (paths.length === 0) {
        failures.push(`${entry}: no matching files`);
      }
      for (const rel of paths) {
        const target = join(worktree, rel);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(root, rel), target);
      }
    } catch (error) {
      failures.push(`${entry}: ${message(error)}`);
    }
  }
  return failures;
}

async function resolveEntry(root: string, entry: string): Promise<string[]> {
  if (entry.startsWith("**/")) {
    const name = entry.slice(3);
    const pattern = new RegExp(
      `^${name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    );
    return walk(root, "", pattern);
  }
  await stat(join(root, entry));
  return [entry];
}

async function walk(root: string, rel: string, pattern: RegExp): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const childRel = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      found.push(...(await walk(root, childRel, pattern)));
    } else if (pattern.test(entry.name)) {
      found.push(childRel);
    }
  }
  return found;
}
