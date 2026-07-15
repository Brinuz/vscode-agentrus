import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { Doc, Initiative } from "./model";
import { slugify } from "./util";

/**
 * Docs live in the extension's global storage rather than in the repo: they
 * are notes about the work, not part of it, so there is nothing to commit and
 * nothing to gitignore. Keeping them outside the worktree also means they
 * survive the initiative's worktree being removed.
 *
 * Agents are launched with `--add-dir` on this folder so they can still read
 * and write the docs despite them living outside the working tree.
 */
export function docsDir(context: vscode.ExtensionContext, initiative: Initiative): string {
  return join(context.globalStorageUri.fsPath, "docs", slugify(initiative.name));
}

export async function ensureDocsDir(
  context: vscode.ExtensionContext,
  initiative: Initiative,
): Promise<string> {
  const dir = docsDir(context, initiative);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Every file currently in the initiative's docs folder. The folder IS the
 * source of truth: anything that lands there — created by the user or written
 * by an agent — shows up in the tree without being registered anywhere.
 */
export async function listDocFiles(
  context: vscode.ExtensionContext,
  initiative: Initiative,
): Promise<Doc[]> {
  const dir = docsDir(context, initiative);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
  } catch {
    // Not created yet: no agent has launched and no doc has been added.
    return [];
  }
  return entries
    .filter(([name, type]) => type === vscode.FileType.File && !name.startsWith("."))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name]) => ({ id: `file:${name}`, name, path: join(dir, name) }));
}
