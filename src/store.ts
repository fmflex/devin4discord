import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type TaskRow = {
  taskId: string;
  guildId: string | null;
  threadId: string;
  sourceMessageId: string | null;
  openerId: string;
  title: string;
  url: string;
  stateLabel: string | null;
  cursor: string | null;
  pullRequests: string[];
  active: boolean;
  /** Discord ID of whoever stopped the task; stopped tasks get no more syncs or replies. */
  stoppedBy: string | null;
  /** Discord ID of whoever put the task to sleep; cleared when a reply wakes it. */
  sleptBy: string | null;
  /** Reserved by a start that hasn't opened its thread yet; counts toward limits only. */
  pending: boolean;
  createdAt: number;
  updatedAt: number;
};

type Raw = {
  task_id: string;
  guild_id: string | null;
  thread_id: string;
  source_message_id: string | null;
  opener_id: string;
  title: string;
  url: string;
  state_label: string | null;
  cursor: string | null;
  pull_requests: string;
  active: number;
  stopped_by: string | null;
  slept_by: string | null;
  pending: number;
  created_at: number;
  updated_at: number;
};

function fromRaw(raw: Raw): TaskRow {
  return {
    taskId: raw.task_id,
    guildId: raw.guild_id,
    threadId: raw.thread_id,
    sourceMessageId: raw.source_message_id,
    openerId: raw.opener_id,
    title: raw.title,
    url: raw.url,
    stateLabel: raw.state_label,
    cursor: raw.cursor,
    pullRequests: JSON.parse(raw.pull_requests) as string[],
    active: raw.active === 1,
    stoppedBy: raw.stopped_by,
    sleptBy: raw.slept_by,
    pending: raw.pending === 1,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at
  };
}

export type NewTask = Pick<
  TaskRow,
  'taskId' | 'threadId' | 'sourceMessageId' | 'openerId' | 'title' | 'url'
> & { guildId: string; mcpKeyHash?: string | null };

export type Reservation = { guildId: string; openerId: string; sourceMessageId: string | null };

const PENDING_PREFIX = 'pending:';

export type TaskPatch = Partial<
  Pick<TaskRow, 'stateLabel' | 'cursor' | 'pullRequests' | 'active' | 'guildId' | 'stoppedBy' | 'sleptBy'>
>;

/** Links Devin sessions to Discord threads. */
export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  insert(task: NewTask) {
    const now = Date.now();
    this.db
      .prepare(
        `insert into tasks (task_id, agent, guild_id, thread_id, source_message_id, opener_id, title, url, mcp_key_hash, created_at, updated_at)
         values (?, 'devin', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.taskId,
        task.guildId,
        task.threadId,
        task.sourceMessageId,
        task.openerId,
        task.title,
        task.url,
        task.mcpKeyHash ?? null,
        now,
        now
      );
  }

  /**
   * Claims a task slot before any Devin or Discord call: the row counts toward
   * the opener's limits straight away. Null when the source message already has
   * a task. Returns the row's provisional task ID.
   */
  reserve(reservation: Reservation): string | null {
    const key = `${PENDING_PREFIX}${randomUUID()}`;
    const now = Date.now();
    const result = this.db
      .prepare(
        `insert into tasks (task_id, agent, guild_id, thread_id, source_message_id, opener_id, title, url, pending, created_at, updated_at)
         values (?, 'devin', ?, ?, ?, ?, '', '', 1, ?, ?)
         on conflict do nothing`
      )
      .run(key, reservation.guildId, key, reservation.sourceMessageId, reservation.openerId, now, now);
    return result.changes ? key : null;
  }

  /** Records the Devin session on a reserved row; the session ID becomes the row's ID. */
  attachSession(key: string, session: { taskId: string; title: string; url: string; mcpKeyHash: string | null }) {
    this.db
      .prepare(
        'update tasks set task_id = ?, title = ?, url = ?, mcp_key_hash = ?, updated_at = ? where task_id = ? and pending = 1'
      )
      .run(session.taskId, session.title, session.url, session.mcpKeyHash, Date.now(), key);
  }

  /** The thread exists: the task is now visible, synced and controllable. */
  complete(taskId: string, threadId: string) {
    this.db
      .prepare('update tasks set thread_id = ?, pending = 0, updated_at = ? where task_id = ? and pending = 1')
      .run(threadId, Date.now(), taskId);
  }

  /** Drops a reservation whose start failed. */
  release(taskId: string) {
    this.db.prepare('delete from tasks where task_id = ? and pending = 1').run(taskId);
  }

  /** Reservations left behind by a restart mid-start. */
  pendingRows(): TaskRow[] {
    return (this.db.prepare('select * from tasks where pending = 1').all() as Raw[]).map(fromRaw);
  }

  /** Whether `taskId` is a reservation's own ID rather than a Devin session's. */
  static isProvisional(taskId: string) {
    return taskId.startsWith(PENDING_PREFIX);
  }

  byId(taskId: string): TaskRow | null {
    const raw = this.db.prepare('select * from tasks where task_id = ? and pending = 0').get(taskId);
    return raw ? fromRaw(raw as Raw) : null;
  }

  byThread(threadId: string): TaskRow | null {
    const raw = this.db.prepare('select * from tasks where thread_id = ? and pending = 0').get(threadId);
    return raw ? fromRaw(raw as Raw) : null;
  }

  /** The task whose session was given this MCP task key (by hash). */
  byMcpKey(keyHash: string): TaskRow | null {
    const raw = this.db.prepare('select * from tasks where mcp_key_hash = ? and pending = 0').get(keyHash);
    return raw ? fromRaw(raw as Raw) : null;
  }

  bySourceMessage(messageId: string): TaskRow | null {
    const raw = this.db
      .prepare('select * from tasks where source_message_id = ? order by created_at desc limit 1')
      .get(messageId);
    return raw ? fromRaw(raw as Raw) : null;
  }

  active(): TaskRow[] {
    return (
      this.db.prepare('select * from tasks where active = 1 and pending = 0 order by updated_at').all() as Raw[]
    ).map(fromRaw);
  }

  recent(guildId: string, limit: number): TaskRow[] {
    return (
      this.db
        .prepare('select * from tasks where guild_id = ? and pending = 0 order by created_at desc limit ?')
        .all(guildId, limit) as Raw[]
    ).map(fromRaw);
  }

  /** Tasks from before servers were tracked; their guild is looked up on start-up. */
  withoutGuild(): TaskRow[] {
    return (
      this.db.prepare('select * from tasks where guild_id is null and pending = 0').all() as Raw[]
    ).map(fromRaw);
  }

  countStartedSince(guildId: string, openerId: string, since: number): number {
    const row = this.db
      .prepare(
        'select count(*) as n from tasks where guild_id = ? and opener_id = ? and created_at >= ?'
      )
      .get(guildId, openerId, since) as { n: number };
    return row.n;
  }

  countActive(guildId: string, openerId: string): number {
    const row = this.db
      .prepare('select count(*) as n from tasks where guild_id = ? and opener_id = ? and active = 1')
      .get(guildId, openerId) as { n: number };
    return row.n;
  }

  update(taskId: string, patch: TaskPatch) {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.stateLabel !== undefined) {
      sets.push('state_label = ?');
      values.push(patch.stateLabel);
    }
    if (patch.cursor !== undefined) {
      sets.push('cursor = ?');
      values.push(patch.cursor);
    }
    if (patch.pullRequests !== undefined) {
      sets.push('pull_requests = ?');
      values.push(JSON.stringify(patch.pullRequests));
    }
    if (patch.active !== undefined) {
      sets.push('active = ?');
      values.push(patch.active ? 1 : 0);
    }
    if (patch.guildId !== undefined) {
      sets.push('guild_id = ?');
      values.push(patch.guildId);
    }
    if (patch.stoppedBy !== undefined) {
      sets.push('stopped_by = ?');
      values.push(patch.stoppedBy);
    }
    if (patch.sleptBy !== undefined) {
      sets.push('slept_by = ?');
      values.push(patch.sleptBy);
    }
    sets.push('updated_at = ?');
    values.push(Date.now(), taskId);
    this.db.prepare(`update tasks set ${sets.join(', ')} where task_id = ?`).run(...values);
  }
}
