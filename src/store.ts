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
    createdAt: raw.created_at,
    updatedAt: raw.updated_at
  };
}

export type NewTask = Pick<
  TaskRow,
  'taskId' | 'threadId' | 'sourceMessageId' | 'openerId' | 'title' | 'url'
> & { guildId: string };

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
        `insert into tasks (task_id, agent, guild_id, thread_id, source_message_id, opener_id, title, url, created_at, updated_at)
         values (?, 'devin', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.taskId,
        task.guildId,
        task.threadId,
        task.sourceMessageId,
        task.openerId,
        task.title,
        task.url,
        now,
        now
      );
  }

  byId(taskId: string): TaskRow | null {
    const raw = this.db.prepare('select * from tasks where task_id = ?').get(taskId);
    return raw ? fromRaw(raw as Raw) : null;
  }

  byThread(threadId: string): TaskRow | null {
    const raw = this.db.prepare('select * from tasks where thread_id = ?').get(threadId);
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
      this.db.prepare('select * from tasks where active = 1 order by updated_at').all() as Raw[]
    ).map(fromRaw);
  }

  recent(guildId: string, limit: number): TaskRow[] {
    return (
      this.db
        .prepare('select * from tasks where guild_id = ? order by created_at desc limit ?')
        .all(guildId, limit) as Raw[]
    ).map(fromRaw);
  }

  /** Tasks from before servers were tracked; their guild is looked up on start-up. */
  withoutGuild(): TaskRow[] {
    return (
      this.db.prepare('select * from tasks where guild_id is null').all() as Raw[]
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
