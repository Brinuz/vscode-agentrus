import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

/**
 * The main repository's root, even when `cwd` is inside a linked worktree.
 * Initiatives are keyed by this, so every window on the same repo — the main
 * checkout or any of its worktrees — sees the same list.
 */
export async function mainRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    // In the main checkout this is ".git"; in a worktree it points at the
    // main repository's .git directory.
    const commonDir = await git(cwd, ["rev-parse", "--git-common-dir"]);
    return await canonical(dirname(resolve(cwd, commonDir)));
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

export async function headSha(root: string): Promise<string> {
  return git(root, ["rev-parse", "HEAD"]);
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export interface Branch {
  name: string;
  /** Worktree that already has it checked out, if any — git refuses a second. */
  worktree?: string;
}

/**
 * Local branches, with the worktree holding each one. Git allows a branch in
 * only one worktree at a time, so the caller needs to know which are taken.
 */
export async function listBranches(root: string): Promise<Branch[]> {
  const out = await git(root, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)%09%(worktreepath)",
    "refs/heads",
  ]);
  return out
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [name, worktree] = line.split("\t");
      return { name, worktree: worktree || undefined };
    });
}

/** Remote-tracking branches, minus the symbolic `<remote>/HEAD` entries. */
export async function listRemoteBranches(root: string): Promise<string[]> {
  const out = await git(root, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    "refs/remotes",
  ]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name && !name.endsWith("/HEAD"));
}

/**
 * Creates the worktree and returns the canonical path git will report for it.
 *
 * `track` is for starting from a branch that only exists on a remote: it makes
 * a local branch following `baseRef`. Otherwise an existing local branch is
 * checked out as-is and `baseRef` is only used to cut a new one.
 */
export async function addWorktree(
  root: string,
  path: string,
  branch: string,
  baseRef: string,
  track = false,
): Promise<string> {
  const exists = await branchExists(root, branch);
  // Reuse the branch if it is already there; only create it when it is not.
  const args = track
    ? ["worktree", "add", "--track", "-b", branch, path, baseRef]
    : exists
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

/** Forget worktrees whose folders are gone. */
export async function pruneWorktrees(root: string): Promise<void> {
  await git(root, ["worktree", "prune"]);
}

export async function deleteBranch(root: string, branch: string, force: boolean): Promise<void> {
  await git(root, ["branch", force ? "-D" : "-d", branch]);
}
