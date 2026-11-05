import { access, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonical, listWorktrees, pruneWorktrees, removeWorktree } from "./git";

/**
 * Taking a worktree off git's books without waiting for its files to go.
 *
 * `git worktree remove` deletes the checkout file by file before it lets go —
 * hundreds of thousands of files in a monorepo with node_modules, half a
 * minute or more with nothing to show for it. Worse, anything still writing
 * into the tree while it runs (a dev server, a local AWS emulator, an agent
 * that has not finished exiting) makes the final rmdir fail with "Directory
 * not empty" *after* git has already unregistered the worktree, leaving a
 * half-deleted folder that no retry can name any more.
 *
 * Renaming the folder aside is a single syscall on the same volume. Once the
 * folder is gone from its registered path, `git worktree prune` forgets it,
 * and the slow delete can happen afterwards, with nothing depending on it.
 */
export interface Detached {
  /** Where the old checkout now sits, waiting to be deleted. */
  movedTo?: string;
}

/**
 * Unregisters the worktree at `path`. The caller has already established
 * that discarding its contents is fine.
 *
 * Falls back to an in-place forced `git worktree remove` when the folder
 * cannot be renamed (another volume, a locked folder), in which case nothing
 * is left to delete afterwards.
 */
export async function detachWorktree(root: string, path: string): Promise<Detached> {
  if (!(await exists(path))) {
    // Already gone, e.g. deleted by hand: only git's record is left.
    await pruneWorktrees(root);
    return {};
  }
  // Resolved while the folder still exists: git reports symlink-free paths,
  // and after the move there is nothing left to resolve.
  const registeredAs = await canonical(path);

  // A dot-folder next to the worktree: same volume, so the rename is instant,
  // and out of the way of anything listing the worktrees folder.
  const movedTo = join(
    dirname(path),
    `.agentrus-removing-${basename(path)}-${Date.now().toString(36)}`,
  );
  try {
    await rename(path, movedTo);
  } catch {
    await removeWorktree(root, path, true);
    return {};
  }

  await pruneWorktrees(root);
  if ((await listWorktrees(root)).includes(registeredAs)) {
    // Prune leaves locked worktrees alone. Put the folder back rather than
    // leave git pointing at nothing, and let git explain itself.
    await rename(movedTo, path);
    await removeWorktree(root, path, true);
    return {};
  }
  return { movedTo };
}

/**
 * Deletes a folder `detachWorktree` set aside. Retries, because whatever was
 * still writing into the tree may take a moment to stop.
 *
 * Resolves to the paths still on disk afterwards — the moved folder if the
 * delete failed, and the original path if something recreated it after the
 * move (a container with a bind mount on it, say).
 */
export async function deleteDetached(original: string, detached: Detached): Promise<string[]> {
  if (detached.movedTo) {
    await rm(detached.movedTo, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(
      () => undefined,
    );
  }
  const left: string[] = [];
  for (const path of [detached.movedTo, original]) {
    if (path && (await exists(path))) {
      left.push(path);
    }
  }
  return left;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
