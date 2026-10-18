import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type TaskRow = {
  taskId: string;
  agent: string;
  threadId: string;
  sourceMessageId: string | null;
  openerId: string;
  title: string;
  url: string;
  stateLabel: string | null;
  cursor: string | null;
  pullRequests: string[];
  active: boolean;
  createdAt: number;
  updatedAt: number;
};

type Raw = {
  task_id: string;
  agent: string;
  thread_id: string;
  source_message_id: string | null;
  opener_id: string;
  title: string;
  url: string;
  state_label: string | null;
  cursor: string | null;
  pull_requests: string;
  active: number;
  created_at: number;
  updated_at: number;
};

function fromRaw(raw: Raw): TaskRow {
  return {
    taskId: raw.task_id,
    agent: raw.agent,
    threadId: raw.thread_id,
    sourceMessageId: raw.source_message_id,
    openerId: raw.opener_id,
    title: raw.title,
    url: raw.url,
    stateLabel: raw.state_label,
    cursor: raw.cursor,
    pullRequests: JSON.parse(raw.pull_requests) as string[],
    active: raw.active === 1,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at
  };
}

export type NewTask = Pick<
  TaskRow,
  'taskId' | 'agent' | 'threadId' | 'sourceMessageId' | 'openerId' | 'title' | 'url'
>;

export type TaskPatch = Partial<
  Pick<TaskRow, 'stateLabel' | 'cursor' | 'pullRequests' | 'active'>
>;

/** Links agent tasks to Discord threads. `path` may be ":memory:". */
export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists tasks (
        task_id text primary key,
        agent text not null,
        thread_id text not null unique,
        source_message_id text,
        opener_id text not null,
        title text not null,
        url text not null,
        state_label text,
        cursor text,
        pull_requests text not null default '[]',
        active integer not null default 1,
        created_at integer not null,
        updated_at integer not null
      );
      create index if not exists tasks_source_idx on tasks (source_message_id);
      create index if not exists tasks_active_idx on tasks (active, updated_at);
    `);
  }

  insert(task: NewTask) {
    const now = Date.now();
    this.db
      .prepare(
        `insert into tasks (task_id, agent, thread_id, source_message_id, opener_id, title, url, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.taskId,
        task.agent,
        task.threadId,
        task.sourceMessageId,
        task.openerId,
        task.title,
        task.url,
        now,
        now
      );
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

  recent(limit: number): TaskRow[] {
    return (
      this.db.prepare('select * from tasks order by created_at desc limit ?').all(limit) as Raw[]
    ).map(fromRaw);
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
    sets.push('updated_at = ?');
    values.push(Date.now(), taskId);
    this.db.prepare(`update tasks set ${sets.join(', ')} where task_id = ?`).run(...values);
  }

  close() {
    this.db.close();
  }
}
