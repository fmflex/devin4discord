/** Where a task stands, normalised across agents. */
export type TaskState =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'finished'
  | 'asleep'
  | 'ended'
  | 'failed';

export type Attachment = { url: string; filename: string };

export type Person = { discordId: string; name: string };

export type StartTaskInput = {
  prompt: string;
  title: string;
  attachments: Attachment[];
  requestedBy: Person;
};

export type StartedTask = { id: string; url: string };

export type AgentMessage = { id: string; text: string };

export type TaskUpdate = {
  state: TaskState;
  /** Human-readable state, e.g. "waiting for a reply". */
  stateLabel: string;
  /** Agent messages after the cursor that should be shown in Discord. */
  messages: AgentMessage[];
  /** Opaque position to pass to the next `getUpdate` call. */
  cursor: string | null;
  pullRequests: string[];
};

/**
 * One coding agent (Devin, Cursor background agents, ...). The bridge only
 * talks to agents through this interface, so adding an agent means adding an
 * adapter.
 */
export interface AgentAdapter {
  /** Display name, used in Discord ("Send to Devin", "**Devin:** ..."). */
  readonly name: string;
  startTask(input: StartTaskInput): Promise<StartedTask>;
  sendMessage(
    taskId: string,
    input: { text: string; attachments: Attachment[]; from: Person }
  ): Promise<void>;
  getUpdate(taskId: string, cursor: string | null): Promise<TaskUpdate>;
}
