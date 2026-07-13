import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Git reports worktree paths with symlinks resolved (on macOS /tmp is really
 * /private/tmp), so any path we compare against `git worktree list` has to be
 * resolved the same way or it will look like a worktree that no longer exists.
 */
export async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    return await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
}

/** Absolute paths of every worktree currently registered with the repo. */
export async function listWorktrees(root: string): Promise<string[]> {
  const out = await git(root, ["worktree", "list", "--porcelain"]);
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

export async function currentRef(root: string): Promise<string> {
  return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Creates the worktree and returns the canonical path git will report for it. */
export async function addWorktree(
  root: string,
  path: string,
  branch: string,
  baseRef: string,
): Promise<string> {
  const exists = await branchExists(root, branch);
  // Reuse the branch if it is already there; only create it when it is not.
  const args = exists
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, baseRef];
  await git(root, args);
  return canonical(path);
}

export async function removeWorktree(root: string, path: string, force: boolean): Promise<void> {
  const args = ["worktree", "remove", path];
  if (force) {
    args.push("--force");
  }
  await git(root, args);
}

export async function deleteBranch(root: string, branch: string, force: boolean): Promise<void> {
  await git(root, ["branch", force ? "-D" : "-d", branch]);
}
