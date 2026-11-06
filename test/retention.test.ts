import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/db.ts';
import { GuildStore } from '../src/guilds.ts';
import { RETENTION_DAYS, pruneOldData } from '../src/retention.ts';
import { TaskStore } from '../src/store.ts';
import { SESSION_TTL_MS, SessionStore } from '../src/web/sessions.ts';

const G = '900000000000000001';
const DAY = 24 * 60 * 60 * 1000;

test('activity older than the retention period is pruned; recent and active data is kept', () => {
  const db = openDatabase(':memory:');
  const tasks = new TaskStore(db);
  const guilds = new GuildStore(db);
  const sessions = new SessionStore(db);
  const now = Date.now();
  const old = now - (RETENTION_DAYS + 1) * DAY;
  const task = (id: string, active: boolean, updatedAt: number) => {
    tasks.insert({ taskId: id, guildId: G, threadId: `thread-${id}`, sourceMessageId: null, openerId: 'u', title: id, url: id });
    db.prepare('update tasks set active = ?, updated_at = ? where task_id = ?').run(active ? 1 : 0, updatedAt, id);
  };
  task('old-finished', false, old);
  task('old-active', true, old);
  task('recent-finished', false, now - DAY);
  guilds.audit(G, { id: 'u', name: 'U' }, 'task.start');
  guilds.audit(G, { id: 'u', name: 'U' }, 'task.stop');
  db.prepare('update audit_log set created_at = ? where action = ?').run(old, 'task.start');
  sessions.create({ id: 'u', username: 'U', avatar: null }, []);
  const live = sessions.create({ id: 'v', username: 'V', avatar: null }, []);
  db.prepare("update web_sessions set expires_at = ? where user_id = 'u'").run(now - 1);

  assert.deepEqual(pruneOldData({ tasks, guilds, sessions }, now), { tasks: 1, audit: 1, sessions: 1 });
  assert.equal(tasks.byId('old-finished'), null);
  assert.ok(tasks.byId('old-active'));
  assert.ok(tasks.byId('recent-finished'));
  assert.deepEqual(guilds.auditLog(G).map((e) => e.action), ['task.stop']);
  assert.ok(sessions.get(live));
  assert.ok(SESSION_TTL_MS < RETENTION_DAYS * DAY);
});
