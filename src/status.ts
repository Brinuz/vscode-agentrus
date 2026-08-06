import { open, stat } from "node:fs/promises";
import * as vscode from "vscode";
import { HookStatus, readStatus, statusPath } from "./hooks";
import { Agent, agentKey, Initiative } from "./model";
import { namedTranscripts, sessionName } from "./sessions";
import { Store } from "./store";
import { Terminals } from "./terminals";

/**
 * `needs-you` is deliberately its own state rather than a flavour of idle:
 * "finished and waiting" and "blocked on a question" look identical in a
 * transcript, and only one of them is worth interrupting yourself for.
 */
export type Activity = "working" | "needs-you" | "idle";

/** Tail of a transcript worth reading to find the last message. */
const TAIL_BYTES = 64 * 1024;

/**
 * How long a transcript may sit untouched before "working" stops being
 * believable. Two windows, because the two ways of being mid-turn go quiet for
 * very different lengths of time:
 *
 * - waiting on a tool writes nothing until it returns, and a test suite or a
 *   long build legitimately takes a while;
 * - generating a reply never goes quiet for long, so silence there means the
 *   session died mid-turn — which is exactly what an abandoned transcript
 *   looks like when its agent is resumed.
 *
 * Getting this wrong only mislabels a row, so the windows are generous.
 */
const STALE_TOOL_MS = 30 * 60 * 1000;
const STALE_TURN_MS = 2 * 60 * 1000;

/**
 * Whether the agent is mid-turn, judged from its transcript.
 *
 * Modification time alone will not do: while a tool runs, claude writes
 * nothing, so a long `npm test` looks exactly like an agent sitting idle. The
 * last record's shape is what actually distinguishes them — an assistant
 * message that stopped for `tool_use` is waiting on a tool, while one that
 * stopped for any other reason has handed control back to the user.
 *
 * Returns undefined when the transcript cannot be read, or holds nothing that
 * settles the question.
 */
export async function transcriptActivity(
  file: string,
  now = Date.now(),
): Promise<Activity | undefined> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }

  // Trailing records are metadata — titles, modes, attachments, the agent
  // name — appended after the conversation, so the last LINE says nothing.
  // Walk back to the last real message.
  for (const record of await tailRecords(file)) {
    const quietFor = quietSince(record, mtimeMs, now);
    if (record.type === "assistant") {
      if (record.message?.stop_reason !== "tool_use") {
        return "idle";
      }
      return quietFor < STALE_TOOL_MS ? "working" : "idle";
    }
    if (record.type === "user") {
      // Esc leaves a marker behind. That is the user stopping the agent
      // outright, so no amount of freshness makes it "working" — and it is the
      // commonest way a turn ends early.
      if (interrupted(record)) {
        return "idle";
      }
      // A prompt, or a tool result feeding back in: either way claude has it
      // and owes a reply — unless the transcript went cold, which means the
      // session died before answering.
      return quietFor < STALE_TURN_MS ? "working" : "idle";
    }
    // Everything else — system notices, queue operations, summaries — says
    // nothing about whose turn it is.
  }
  return undefined;
}

/**
 * How long since the message itself, not since the file changed. Those are not
 * the same thing: claude appends metadata records for hours after a
 * conversation ends, dragging mtime forward while nothing is said — enough to
 * keep a dead session looking busy indefinitely. The windows above were
 * measured on message timestamps, so this is what they belong against.
 *
 * mtime remains the fallback for the rare record carrying no timestamp.
 */
function quietSince(record: Record, mtimeMs: number, now: number): number {
  const at = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
  return now - (Number.isNaN(at) ? mtimeMs : at);
}

/** Whether this user record is the marker Esc writes, in either wording. */
function interrupted(record: Record): boolean {
  const content = record.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => block.text?.startsWith("[Request interrupted by user"));
}

interface Record {
  type?: string;
  timestamp?: string;
  // Content is a block array on the records that matter here, but claude also
  // writes plain-string content, so the array check is not a formality.
  message?: { stop_reason?: string; content?: string | { text?: string }[] };
}

/** Records in the tail of the transcript, newest first. */
async function tailRecords(file: string): Promise<Record[]> {
  let text: string;
  try {
    const { size } = await stat(file);
    const start = Math.max(0, size - TAIL_BYTES);
    const handle = await open(file, "r");
    try {
      const length = size - start;
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, start);
      text = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
    // Reading from an offset almost certainly lands mid-line; that fragment is
    // not parseable JSON and would only produce noise.
    if (start > 0) {
      text = text.slice(text.indexOf("\n") + 1);
    }
  } catch {
    return [];
  }

  const records: Record[] = [];
  for (const line of text.split("\n").reverse()) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line) as Record);
    } catch {
      // A half-written line at the very end, or the fragment we sliced off.
    }
  }
  return records;
}

async function newestOf(files: string[]): Promise<string | undefined> {
  const stamped = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, at: (await stat(file)).mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );
  return stamped
    .filter((entry): entry is { file: string; at: number } => entry !== undefined)
    .sort((a, b) => b.at - a.at)[0]?.file;
}

/**
 * What each agent's hook event means for the tree.
 *
 * `SessionEnd` maps to nothing on purpose: its hook deletes the status file,
 * so there is normally nothing left to interpret, and a conversation that is
 * over has no activity to report.
 */
function hookActivity(status: HookStatus): Activity | undefined {
  switch (status.event) {
    case "UserPromptSubmit":
      return "working";
    // A tool that just finished means the turn is moving again — including
    // straight after a permission prompt was approved, which is the only sign
    // that the agent stopped waiting on you.
    case "PostToolUse":
      return "working";
    case "Stop":
      return "idle";
    case "Notification":
      return notificationActivity(status.message);
    case "SessionEnd":
      return undefined;
  }
}

/**
 * `Notification` fires both when claude is blocked on you and when it nudges
 * you after going quiet, and only the message tells them apart. The nudge is
 * the one that must NOT read as "needs you" — an agent that finished half an
 * hour ago would otherwise sit there asking for attention it does not want.
 *
 * Anything else, including a payload we could not read, is treated as a block:
 * a permission prompt nobody notices defeats the point of the state.
 */
function notificationActivity(message?: string): Activity {
  return message && /waiting for your input/i.test(message) ? "idle" : "needs-you";
}

/**
 * Polls the transcripts of agents whose terminal is open, so the tree can show
 * which ones are mid-turn.
 *
 * Only open terminals are polled, and the interval stops entirely when none
 * are: an initiative list nobody is working in costs nothing to watch.
 *
 * Agents launched with status hooks do not need polling at all: their own
 * process reports each turn as it happens, which is both faster and the only
 * way to learn that claude is waiting on a permission prompt. The transcript
 * reader stays underneath as the fallback for everyone else.
 */
export class ActivityMonitor implements vscode.Disposable {
  private readonly verdicts = new Map<string, Activity>();
  /** Hook-reported state, which outranks anything inferred from a transcript. */
  private readonly hooks = new Map<string, Activity>();
  private readonly watcher: vscode.FileSystemWatcher;
  /**
   * Resolved transcript per agent. Worth remembering: finding one means
   * reading the head of every transcript in the project folder, which is far
   * too much work to repeat every few seconds. Dropped as soon as the file
   * stops existing, so "start fresh" resolves the new one.
   */
  private readonly transcripts = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<void>();
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  readonly onDidChange = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly terminals: Terminals,
  ) {
    // `*`, not `**`: status files are flat, and a recursive pattern would have
    // VS Code watch the tree through FSEvents, which coalesces events for
    // about a second before the extension hears about them. Non-recursive
    // watching fires straight away, which is the whole point of the hooks.
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(context.globalStorageUri, "status"), "*"),
    );
    const reread = (): void => void this.readHooks();
    this.watcher.onDidCreate(reread);
    this.watcher.onDidChange(reread);
    this.watcher.onDidDelete(reread);
    reread();
  }

  /**
   * Last known verdict. Synchronous: the tree cannot await a poll.
   *
   * Hook state wins where it exists — it is the agent's process saying what it
   * is doing, not a guess made from the file it left behind.
   */
  get(initiative: Initiative, agent: Agent): Activity | undefined {
    const key = `${initiative.id}:${agentKey(agent)}`;
    return this.hooks.get(key) ?? this.verdicts.get(key);
  }

  /** Re-read every agent's status file after anything in the folder changes. */
  private async readHooks(): Promise<void> {
    const live = new Map<string, Activity>();
    for (const initiative of this.store.all()) {
      for (const agent of initiative.agents) {
        const status = await readStatus(statusPath(this.context, initiative, agent));
        const activity = status && hookActivity(status);
        if (activity) {
          live.set(`${initiative.id}:${agentKey(agent)}`, activity);
        }
      }
    }

    if (!sameVerdicts(this.hooks, live)) {
      this.hooks.clear();
      for (const [key, activity] of live) {
        this.hooks.set(key, activity);
      }
      this.changed.fire();
    }
  }

  /**
   * Start or stop polling to match the setting and what is actually running.
   * Safe to call as often as terminals come and go.
   */
  sync(): void {
    const seconds = vscode.workspace
      .getConfiguration("agentrus")
      .get<number>("activityPollSeconds", 3);
    const wanted = seconds > 0 && this.hasLiveAgent();

    if (!wanted) {
      this.stop();
      return;
    }
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.poll(), Math.max(1, seconds) * 1000);
    void this.poll();
  }

  private hasLiveAgent(): boolean {
    return this.store
      .all()
      .some((initiative) =>
        initiative.agents.some((agent) => this.terminals.isRunning(initiative, agentKey(agent))),
      );
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.transcripts.clear();
    if (this.verdicts.size > 0) {
      this.verdicts.clear();
      this.changed.fire();
    }
  }

  /** The agent's transcript, remembered across polls while it still exists. */
  private async transcriptOf(
    key: string,
    initiative: Initiative,
    agent: Agent,
  ): Promise<string | undefined> {
    const cached = this.transcripts.get(key);
    if (cached) {
      try {
        await stat(cached);
        return cached;
      } catch {
        this.transcripts.delete(key);
      }
    }

    const files = await namedTranscripts(initiative.worktreePath, sessionName(initiative, agent));
    const newest = files && files.length > 0 ? await newestOf(files) : undefined;
    if (newest) {
      this.transcripts.set(key, newest);
    }
    return newest;
  }

  private async poll(): Promise<void> {
    // A slow disk must not let polls pile up on top of each other.
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const live = new Map<string, Activity>();
      for (const initiative of this.store.all()) {
        for (const agent of initiative.agents) {
          const key = `${initiative.id}:${agentKey(agent)}`;
          if (!this.terminals.isRunning(initiative, agentKey(agent))) {
            continue;
          }
          // Hooks already answer for this one, and better. Reading its
          // transcript would only produce a verdict nothing ever consults.
          if (this.hooks.has(key)) {
            continue;
          }
          const file = await this.transcriptOf(key, initiative, agent);
          const activity = file ? await transcriptActivity(file) : undefined;
          if (activity) {
            live.set(key, activity);
          }
        }
      }

      if (!sameVerdicts(this.verdicts, live)) {
        this.verdicts.clear();
        for (const [key, activity] of live) {
          this.verdicts.set(key, activity);
        }
        this.changed.fire();
      }
    } finally {
      this.polling = false;
    }
  }

  dispose(): void {
    this.stop();
    this.watcher.dispose();
    this.changed.dispose();
  }
}

function sameVerdicts(a: Map<string, Activity>, b: Map<string, Activity>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false;
    }
  }
  return true;
}
