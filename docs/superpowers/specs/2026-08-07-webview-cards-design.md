# Webview cards for the Initiatives view — design

**Date:** 2026-08-07 · **Branch:** `feat/bigger`

## Problem

The Initiatives view is a native VS Code `TreeView`, whose row height is fixed
by the workbench (22px) with no extension API to change it. The rows — agents
especially — feel cramped: role, model, skill and status all compete for one
line. The goal is bigger, "fatter" rows.

## Decision summary

- Rewrite the view as a **`WebviewView`** — the only way to control row size.
- **Everything gets the card treatment**: agents are two-line cards with a
  status chip; initiatives are header cards; docs and shells are compact
  single-line cards; group headers stay slim collapsible rows.
- **Actions**: hover icons for the common actions plus the existing QuickPick
  hubs behind a gear/⋯ icon. Native right-click menus are preserved by porting
  `view/item/context` contributions to `webview/context` with
  `data-vscode-context` attributes.
- **Drag-and-drop** reordering of initiatives is rebuilt with HTML5 DnD.
- The native tree is **replaced outright** — no setting to keep both.
- **Implementation: vanilla TypeScript** — no runtime dependencies, a second
  esbuild entry point for the webview script, full DOM re-render per update.

## Architecture

`package.json` keeps the view id `agentrus.initiatives` but declares it with
`"type": "webview"`. A new `InitiativesViewProvider` in `src/view.ts`
implements `vscode.WebviewViewProvider`, registered with
`registerWebviewViewProvider`. `src/tree.ts` and `createTreeView` are deleted.

Data flows one way, extension → webview, as a **plain JSON snapshot**:

```
{
  hasRepo: boolean,
  currentId?: string,
  initiatives: [{
    id, name, branch?, worktreePath, managed,
    agents: [{ role, model, skill?, icon, custom, started, running, activity? }],
    docs:   [{ path, name, linked }],
    shells: [{ id, name, running }],
  }]
}
```

The provider posts a fresh snapshot on the same triggers that refresh the tree
today: `terminals.onDidChange`, `activity.onDidChange`, the docs-folder
watcher, and explicit `refresh()` after commands. The webview script
(`src/webview/main.ts`, bundled to `dist/webview.js`) rebuilds the DOM from
scratch on every snapshot — at this scale (tens of cards) that is instant and
avoids state-sync bugs.

Interactions post small messages back — `{type: "openAgent", initiativeId,
role}`, `{type: "reorder", draggedId, ontoId}`, `{type: "command", command,
payload}` — which the provider routes to the existing command implementations.

### Command refactor

Commands stop receiving `TreeItem`s. Each handler takes a plain payload
(`{initiativeId, role}`, `{initiativeId, shellId}`, `{initiativeId,
docPath}`), resolved to live objects through the `Store`. `openAllAgents`
iterates roles rather than constructing `AgentItem`s. This is mechanical but
touches every `registerCommand` in `extension.ts`.

## Rendering

- **Initiative card**: header with codicon (`git-branch`/`repo`), name,
  branch or directory basename, a "this window" badge on the current one, and
  a collapse chevron. Expansion state lives in the webview's
  `getState()/setState()` so it survives hides; on a fresh window the current
  initiative starts expanded, all others collapsed (replaces the
  `collapseToCurrent` reveal dance — we own the state now).
- **Group headers** ("Agents 4" / "Docs 0" / "Shells 3"): slim collapsible
  rows with their `+` / open-all / reveal hover icons.
- **Agent card**: line 1 — codicon, role, status chip; line 2 — `model ·
  /skill`. Chip semantics as today: spinning + yellow "working…", red "needs
  you", green "idle"/"live", none when not running. Click anywhere opens the
  agent (same `openAgent` flow, including the first-launch skill prompt).
- **Doc / shell cards**: single line; shells get a green "live" chip when
  running; docs show a basename description when the display name differs.
- **Tooltips**: `title` attributes carrying the same text the Markdown
  tooltips carry today (plain text is acceptable).
- **Icons**: `@vscode/codicons` as a devDependency; the build copies
  `codicon.css` + `codicon.ttf` into `dist/`, loaded with a webview-safe URI.
  `loading~spin` becomes the `codicon-loading` glyph with a CSS spin.
- **Theming**: `--vscode-*` variables only (foreground, sideBar background,
  list hover, focusBorder, chart colours for chips). No hardcoded colours.
- **Empty states**: `viewsWelcome` does not apply to webview views, so the
  webview renders them itself — "no repo" with an Open Folder button, "no
  initiatives" with a Create Initiative button — posting the same commands the
  welcome buttons invoke today. The `agentrus.hasRepo` context key stays for
  anything else that needs it.

## Actions

Hover icons reproduce today's `inline@` entries per card type (initiative:
run-all + gear; agents group: run-all + add; agent: gear; docs group: add +
reveal; shell: gear; doc: unlink/reveal). Everything else stays behind the
QuickPick hubs, which are untouched.

Each card sets `data-vscode-context` (e.g. `{"webviewSection": "agent",
"agentrusInitiative": id, "agentrusRole": role,
"preventDefaultContextMenuItems": true}`). The `view/item/context` menu block
in `package.json` is ported to `webview/context`, with `when` clauses keyed on
`webviewSection` (and `agentrusCustom` for the remove-agent entry). Menu
commands receive the context object as their payload — the same plain-payload
shape the refactored commands accept.

## Drag-and-drop

Initiative header cards are `draggable`. Dropping onto any card belonging to
an initiative (or the gap between cards) posts `{type: "reorder", draggedId,
ontoId}` → `store.reorderInitiative` (unchanged) → fresh snapshot. Dropping
below the list moves to the end, matching today's `undefined` target.

## Error handling

Command implementations keep their `showErrorMessage` behaviour. The webview
is dumb: a message referencing a vanished initiative/agent is ignored and a
fresh snapshot is pushed. Snapshot rendering guards against missing fields by
construction (single source builds it).

## Testing

No test infrastructure exists in the repo; verification is manual:

1. `npm run check-types` and a production build pass.
2. Package + install + reload (vsce loop), then walk: open agent /
   open all, hubs, right-click menus on every card type, reorder by drag and
   by menu, collapse state across hide/show and reload, current-initiative
   auto-expand, empty states (no repo, no initiatives), docs appearing when a
   file lands in the docs folder, status chips cycling working/needs-you/idle,
   light + dark theme.

## Out of scope

Keyboard navigation beyond tab-focus, virtual scrolling, animations beyond
the spinner, find-in-tree, any `viewsWelcome`-style contribution API.
