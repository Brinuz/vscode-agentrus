import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { Doc, Initiative } from "./model";
import { sessionName } from "./sessions";
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

export async function hasDocs(
  context: vscode.ExtensionContext,
  initiative: Initiative,
): Promise<boolean> {
  return initiative.docs.length > 0 || (await listDocFiles(context, initiative)).length > 0;
}

/**
 * Docs of removed initiatives, one folder each, next to `docs/` rather than
 * inside it so the docs root only ever holds live initiatives.
 */
export function archiveRoot(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, "archive");
}

export async function ensureArchiveRoot(context: vscode.ExtensionContext): Promise<string> {
  const dir = archiveRoot(context);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Linked docs are the user's own files, so only the docs folder goes. */
export async function trashDocs(
  context: vscode.ExtensionContext,
  initiative: Initiative,
): Promise<void> {
  const dir = docsDir(context, initiative);
  if (await exists(dir)) {
    await vscode.workspace.fs.delete(vscode.Uri.file(dir), { recursive: true, useTrash: true });
  }
}

/**
 * Moves the docs folder, dotfiles included, into the archive with an
 * ARCHIVE.md recording what an agent would need to pick the work back up.
 */
export async function archiveDocs(
  context: vscode.ExtensionContext,
  initiative: Initiative,
  head: string | undefined,
): Promise<void> {
  const root = await ensureArchiveRoot(context);
  const now = new Date();
  const base = `${slugify(initiative.name)}-${localDate(now)}`;
  let folder = base;
  for (let n = 2; await exists(join(root, folder)); n++) {
    folder = `${base}-${n}`;
  }
  const target = join(root, folder);

  const dir = docsDir(context, initiative);
  if (await exists(dir)) {
    await rename(dir, target);
  } else {
    await mkdir(target);
  }
  await writeFile(join(target, MANIFEST), manifest(initiative, head, now));
  await writeIndex(root);
}

const MANIFEST = "ARCHIVE.md";

function manifest(initiative: Initiative, head: string | undefined, archived: Date): string {
  const fields = {
    name: initiative.name,
    branch: initiative.branch ?? "none",
    head: head ?? "unknown",
    worktree: initiative.worktreePath,
    created: new Date(initiative.createdAt).toISOString(),
    archived: archived.toISOString(),
  };
  const agents = initiative.agents.map(
    (agent) =>
      `- ${agent.role}: model ${agent.model}, skill ${agent.skill ?? "none"}, session \`${sessionName(initiative, agent)}\``,
  );
  const linked = initiative.docs.map((doc) => `- ${doc.name}: ${doc.path}`);
  return [
    "---",
    // JSON strings are valid YAML, and survive names with colons or quotes.
    ...Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "---",
    "",
    `# ${initiative.name}`,
    "",
    `Archived from Agent"R"Us on ${localDate(archived)}.`,
    "",
    "## Agents",
    ...(agents.length > 0 ? agents : ["None."]),
    "",
    "## Linked docs",
    ...(linked.length > 0 ? linked : ["None."]),
    "",
  ].join("\n");
}

/**
 * Rebuilt from every folder's ARCHIVE.md rather than appended to, so folders
 * deleted or renamed by hand drop out on the next archive.
 */
async function writeIndex(root: string): Promise<void> {
  const entries: { line: string; archived: string }[] = [];
  for (const folder of await readdir(root)) {
    let files: string[];
    let fields: Record<string, string>;
    try {
      files = await readdir(join(root, folder));
      fields = frontmatter(await readFile(join(root, folder, MANIFEST), "utf8"));
    } catch {
      continue;
    }
    const count = files.filter((name) => name !== MANIFEST && !name.startsWith(".")).length;
    const archived = fields.archived ?? "";
    entries.push({
      archived,
      line: `- [${fields.name ?? folder}](${encodeURI(folder)}/${MANIFEST}) · branch ${fields.branch ?? "none"} · archived ${archived.slice(0, 10)} · ${count} files`,
    });
  }
  entries.sort((a, b) => b.archived.localeCompare(a.archived));
  const header = `# Agent"R"Us archive\n\nDocs of removed initiatives, one folder each. Each folder's ${MANIFEST} records the branch, commit, agents and linked docs.\n\n`;
  await writeFile(join(root, "INDEX.md"), header + entries.map((entry) => entry.line).join("\n") + "\n");
}

function frontmatter(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const block = /^---\n([\s\S]*?)\n---/.exec(text);
  for (const line of block?.[1].split("\n") ?? []) {
    const match = /^(\w+): (.*)$/.exec(line);
    if (match) {
      fields[match[1]] = JSON.parse(match[2]);
    }
  }
  return fields;
}

/** The removal date as the user sees it, not UTC's. */
function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
