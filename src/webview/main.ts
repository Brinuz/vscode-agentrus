import type {
  AgentCard,
  DocCard,
  InitiativeCard,
  Message,
  Payload,
  ShellCard,
  Snapshot,
} from "../snapshot";

declare function acquireVsCodeApi(): {
  postMessage(message: Message): void;
  getState(): State | undefined;
  setState(state: State): void;
};

/** Which cards the user has folded shut, by initiative id or `<id>:<group>`. */
interface State {
  collapsed: string[];
}

/** Identifies an initiative card being dragged, so nothing else can be. */
const MIME = "application/vnd.agentrus.initiative";

const api = acquireVsCodeApi();
const root = document.getElementById("root") as HTMLElement;
const collapsed = new Set(api.getState()?.collapsed ?? []);
/** Whether the first snapshot has decided what starts folded. */
let seeded = api.getState() !== undefined;

window.addEventListener("message", (event: MessageEvent<Snapshot>) => render(event.data));

// The page can only paint what it is sent, and a snapshot posted before this
// script ran was silently dropped — so ask for one, on load and on every
// re-show (hiding the view tears the page down and reloads it).
api.postMessage({ type: "ready" });

// Dropping past the last card sends the initiative to the end, which is what
// the tree did with a target of nothing.
document.body.addEventListener("dragover", allowDrop);
document.body.addEventListener("drop", (event) => drop(event, undefined));

function render(snapshot: Snapshot): void {
  // Nothing but the initiative this window is open on is worth unfolding on
  // sight; after that the arrangement is the user's.
  if (!seeded) {
    for (const initiative of snapshot.initiatives) {
      if (initiative.id !== snapshot.currentId) {
        collapsed.add(initiative.id);
      }
    }
    seeded = true;
    save();
  }

  root.textContent = "";
  if (!snapshot.hasRepo) {
    root.append(
      empty(
        'Agent"R"Us needs an open folder that is a git repository.',
        "Open folder",
        "vscode.openFolder",
      ),
    );
    return;
  }
  if (snapshot.initiatives.length === 0) {
    root.append(
      empty(
        "No initiatives yet. An initiative is a git worktree on its own branch, with an architect, a dev, a reviewer and a generic agent pinned to it.",
        "Create initiative",
        "agentrus.createInitiative",
      ),
    );
    return;
  }
  for (const initiative of snapshot.initiatives) {
    root.append(initiativeSection(initiative, initiative.id === snapshot.currentId));
  }
}

function initiativeSection(initiative: InitiativeCard, current: boolean): HTMLElement {
  const section = el("section", "initiative");
  // Dropping anywhere inside an initiative means "put it here" — the user
  // should not have to hit the header card exactly.
  section.addEventListener("dragover", (event) => {
    if (allowDrop(event)) {
      section.classList.add("drop-target");
    }
  });
  section.addEventListener("dragleave", () => section.classList.remove("drop-target"));
  section.addEventListener("drop", (event) => {
    section.classList.remove("drop-target");
    event.stopPropagation();
    drop(event, initiative.id);
  });
  section.append(initiativeHeader(initiative, current));

  const children = el("div", "children");
  children.append(
    group(initiative, "agents", "organization", "Agents", initiative.agents.length, [
      action("run-all", "Open all agents", "agentrus.openAllAgents", { initiativeId: initiative.id }),
      action("person-add", "Add agent", "agentrus.addAgent", { initiativeId: initiative.id }),
    ]),
    groupBody(initiative, "agents", initiative.agents.map((agent) => agentRow(initiative, agent))),
    group(initiative, "docs", "book", "Docs", initiative.docs.length, [
      action("add", "Add doc", "agentrus.addDoc", { initiativeId: initiative.id }),
      action("folder-opened", "Reveal docs folder", "agentrus.revealDocsFolder", {
        initiativeId: initiative.id,
      }),
    ]),
    groupBody(initiative, "docs", initiative.docs.map((doc) => docRow(initiative, doc))),
    group(initiative, "shells", "terminal", "Shells", initiative.shells.length, [
      action("add", "New shell", "agentrus.newShell", { initiativeId: initiative.id }),
    ]),
    groupBody(initiative, "shells", initiative.shells.map((shell) => shellRow(initiative, shell))),
  );
  if (collapsed.has(initiative.id)) {
    children.hidden = true;
  }
  section.append(children);
  return section;
}

function initiativeHeader(initiative: InitiativeCard, current: boolean): HTMLElement {
  const card = el("div", "card initiative-header");
  context(card, "initiative", { initiativeId: initiative.id });
  card.draggable = true;
  card.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData(MIME, initiative.id);
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  const where = initiative.branch ?? basename(initiative.worktreePath);
  card.title = [
    initiative.name,
    initiative.branch ? `Branch: ${initiative.branch}` : "",
    `${initiative.managed ? "Worktree" : "Directory"}: ${initiative.worktreePath}`,
    initiative.managed ? "" : "Uses the repo as-is — no worktree of its own.",
    current ? "Open in this window." : "",
  ]
    .filter(Boolean)
    .join("\n");

  card.append(
    chevron(initiative.id),
    codicon(initiative.managed ? "git-branch" : "repo"),
    el("span", "name", initiative.name),
    el("span", "where", where),
  );
  if (current) {
    // Marked in text rather than colour: colour already means working, needs
    // you and idle on the agent cards below, and a fourth meaning would blunt
    // all three.
    card.append(el("span", "badge", "this window"));
  }
  card.append(
    actions([
      action("run-all", "Open all agents", "agentrus.openAllAgents", {
        initiativeId: initiative.id,
      }),
      action("settings-gear", "Configure initiative", "agentrus.configureInitiative", {
        initiativeId: initiative.id,
      }),
    ]),
  );
  card.addEventListener("click", () => toggle(initiative.id, card));
  return card;
}

/** The group's own class is also what tints it — see `--accent` in the CSS. */
function groupClass(kind: string): string {
  return `${kind}-group`;
}

function group(
  initiative: InitiativeCard,
  kind: string,
  icon: string,
  label: string,
  count: number,
  buttons: HTMLElement[],
): HTMLElement {
  const key = `${initiative.id}:${kind}`;
  const row = el("div", `group ${groupClass(kind)}`);
  context(row, groupClass(kind), { initiativeId: initiative.id });
  row.append(
    chevron(key),
    codicon(icon),
    el("span", "label", label),
    el("span", "count", String(count)),
    actions(buttons),
  );
  row.addEventListener("click", () => toggle(key, row));
  return row;
}

function groupBody(initiative: InitiativeCard, kind: string, rows: HTMLElement[]): HTMLElement {
  const body = el("div", `group-body ${groupClass(kind)}`);
  body.append(...rows);
  if (collapsed.has(`${initiative.id}:${kind}`)) {
    body.hidden = true;
  }
  return body;
}

function agentRow(initiative: InitiativeCard, agent: AgentCard): HTMLElement {
  const payload: Payload = { initiativeId: initiative.id, role: agent.role };
  const card = el("div", "card agent");
  // Only agents the user added may be removed; the defaults stay put.
  context(card, "agent", payload, { agentrusCustom: agent.custom });
  card.title = [
    `${agent.role} — ${agent.model}`,
    agent.skill ? `Startup skill: /${agent.skill}` : "",
    agent.running
      ? runningTooltip(agent)
      : agent.started
        ? "Click to reopen; the conversation resumes where it left off."
        : "Click to start this agent's conversation.",
  ]
    .filter(Boolean)
    .join("\n");

  const lines = el("div", "lines");
  const first = el("div", "line");
  first.append(el("span", "role", agent.role));
  const status = chip(agent);
  if (status) {
    first.append(status);
  }
  lines.append(first, el("div", "detail", `${agent.model}${agent.skill ? ` · /${agent.skill}` : ""}`));

  card.append(
    codicon(agent.icon),
    lines,
    actions([action("settings-gear", "Configure agent", "agentrus.configureAgent", payload)]),
  );
  card.addEventListener("click", () => send("agentrus.openAgent", payload));
  return card;
}

/**
 * Traffic lights: green is clear to take, yellow is busy, red is stopped and
 * waiting on you.
 *
 * The yellow is the terminal's rather than `charts.yellow`, which is a
 * desaturated gold too close to its warmer neighbours to tell apart at this
 * size — the one thing this colouring exists for.
 */
function chip(agent: AgentCard): HTMLElement | undefined {
  if (!agent.running) {
    return undefined;
  }
  switch (agent.activity) {
    case "working": {
      const busy = el("span", "chip working");
      busy.append(codicon("loading", "codicon-modifier-spin"), el("span", undefined, "working…"));
      return busy;
    }
    case "needs-you": {
      const blocked = el("span", "chip needs-you");
      blocked.append(codicon("bell"), el("span", undefined, "needs you"));
      return blocked;
    }
    case "idle":
      return el("span", "chip idle", "idle");
    default:
      // Without a verdict there is nothing to say beyond "the terminal is
      // there", which is what "live" has always meant.
      return el("span", "chip idle", "live");
  }
}

function runningTooltip(agent: AgentCard): string {
  switch (agent.activity) {
    case "working":
      return "Mid-turn — working on something.";
    case "needs-you":
      return "Waiting for you — it asked for permission or input.";
    case "idle":
      return "Finished; nothing pending.";
    default:
      return "Terminal is open.";
  }
}

function docRow(initiative: InitiativeCard, doc: DocCard): HTMLElement {
  const payload: Payload = { initiativeId: initiative.id, docPath: doc.path };
  const card = el("div", "card doc");
  context(card, doc.linked ? "doc" : "doc-file", payload);
  card.title = doc.path;
  card.append(codicon("file"), el("span", "name", doc.name));
  if (doc.name !== basename(doc.path)) {
    card.append(el("span", "detail", basename(doc.path)));
  }
  card.append(
    actions([
      ...(doc.linked
        ? [action("close", "Remove doc from initiative", "agentrus.removeDoc", payload)]
        : []),
      action("folder-opened", "Reveal doc in Finder", "agentrus.revealDoc", payload),
    ]),
  );
  card.addEventListener("click", () => send("agentrus.openDoc", payload));
  return card;
}

function shellRow(initiative: InitiativeCard, shell: ShellCard): HTMLElement {
  const payload: Payload = { initiativeId: initiative.id, shellId: shell.id };
  const card = el("div", "card shell");
  context(card, "shell", payload);
  card.title = `Terminal in ${initiative.worktreePath}`;
  card.append(codicon("terminal"), el("span", "name", shell.name));
  if (shell.running) {
    card.append(el("span", "chip idle", "live"));
  }
  card.append(
    actions([action("settings-gear", "Configure shell", "agentrus.configureShell", payload)]),
  );
  card.addEventListener("click", () => send("agentrus.openShell", payload));
  return card;
}

function empty(text: string, label: string, command: string): HTMLElement {
  const box = el("div", "empty");
  const button = el("button", undefined, label);
  button.addEventListener("click", () => send(command));
  box.append(el("p", undefined, text), button);
  return box;
}

function actions(buttons: HTMLElement[]): HTMLElement {
  const bar = el("span", "actions");
  bar.append(...buttons);
  return bar;
}

function action(icon: string, title: string, command: string, payload?: Payload): HTMLElement {
  const button = el("button", "action");
  button.title = title;
  button.append(codicon(icon));
  button.addEventListener("click", (event) => {
    // The card underneath opens something; a button on it must not.
    event.stopPropagation();
    send(command, payload);
  });
  return button;
}

/**
 * What the right-click menu runs on. The payload sits alongside the
 * `webviewSection` the menu's `when` clauses key off, so a menu entry and a
 * click on the same card hand the command the very same argument.
 */
function context(
  node: HTMLElement,
  section: string,
  payload: Payload,
  extra?: Record<string, unknown>,
): void {
  node.dataset.vscodeContext = JSON.stringify({
    webviewSection: section,
    preventDefaultContextMenuItems: true,
    ...payload,
    ...extra,
  });
}

/** True, and the drop is accepted, only for an initiative dragged from here. */
function allowDrop(event: DragEvent): boolean {
  if (!event.dataTransfer?.types.includes(MIME)) {
    return false;
  }
  event.preventDefault();
  return true;
}

function drop(event: DragEvent, ontoId: string | undefined): void {
  const draggedId = event.dataTransfer?.getData(MIME);
  if (draggedId) {
    event.preventDefault();
    api.postMessage({ type: "reorder", draggedId, ontoId });
  }
}

function chevron(key: string): HTMLElement {
  return codicon(collapsed.has(key) ? "chevron-right" : "chevron-down", "chevron");
}

function toggle(key: string, row: HTMLElement): void {
  const body = row.nextElementSibling;
  const folding = !collapsed.has(key);
  if (folding) {
    collapsed.add(key);
  } else {
    collapsed.delete(key);
  }
  save();
  if (body instanceof HTMLElement) {
    body.hidden = folding;
  }
  const mark = row.querySelector(".chevron");
  if (mark) {
    mark.className = `codicon codicon-chevron-${folding ? "right" : "down"} chevron`;
  }
}

function save(): void {
  api.setState({ collapsed: [...collapsed] });
}

function send(command: string, payload?: Payload): void {
  api.postMessage({ type: "command", command, payload });
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function codicon(name: string, extra?: string): HTMLElement {
  return el("span", `codicon codicon-${name}${extra ? ` ${extra}` : ""}`);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
