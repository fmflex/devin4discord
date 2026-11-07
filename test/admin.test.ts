import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectAdminStats } from '../src/admin.ts';
import { adminUserIds } from '../src/config.ts';
import { Secrets } from '../src/crypto.ts';
import { openDatabase } from '../src/db.ts';
import { devFixtures } from '../src/dev-web.ts';
import { GuildStore } from '../src/guilds.ts';
import { HostHealth } from '../src/health.ts';
import { TaskStore } from '../src/store.ts';
import { SESSION_COOKIE, createWebApp } from '../src/web/app.ts';
import { SessionStore } from '../src/web/sessions.ts';

const DAY = 24 * 60 * 60 * 1000;
const G = '900000000000000001';
const OTHER = '900000000000000002';
const PUBLIC = 'https://devin.example.com';

function seed() {
  const db = openDatabase(':memory:');
  const guilds = new GuildStore(db);
  const tasks = new TaskStore(db);
  guilds.ensure(G, 'Main');
  guilds.ensure(OTHER, 'Gone');
  for (const id of [G, OTHER]) {
    guilds.saveDevin(id, { apiKeyEncrypted: 'x', apiKeyHint: 'x', orgId: 'org', defaultRepos: [], userMap: {} });
  }
  const now = Date.now();
  const add = (id: string, opener: string, ageDays: number, extra: Record<string, unknown> = {}) => {
    tasks.insert({ taskId: `t${id}`, guildId: G, threadId: `th${id}`, sourceMessageId: null, openerId: opener, title: 't', url: 'u' });
    db.prepare('update tasks set created_at = ? where task_id = ?').run(now - ageDays * DAY, `t${id}`);
    if (Object.keys(extra).length) tasks.update(`t${id}`, extra);
  };
  add('1', 'u1', 0.1);
  add('2', 'u2', 2, { pullRequests: ['https://github.com/a/b/pull/1'], active: false });
  add('3', 'u1', 10, { sleptBy: 'u1' });
  guilds.audit(G, { id: 'u1', name: 'One' }, 'task.stop');
  guilds.audit(G, { id: 'u1', name: 'One' }, 'task.stop');
  guilds.audit(G, { id: 'u1', name: 'One' }, 'devin.update');
  return { db, guilds, tasks, now };
}

test('admin stats count usage, servers and the database', () => {
  const { db, now } = seed();
  const health = new HostHealth(now - 3 * 60 * 60 * 1000);
  health.recordError('Syncing task 123 failed: boom', now - 1000);
  health.recordError('Syncing task 456 failed: boom', now - 2000);
  health.recordPrune(4, null, now - 1000);
  const stats = collectAdminStats({
    db,
    databasePath: ':memory:',
    health,
    bot: { ready: true, pingMs: 50, guilds: [{ id: G, name: 'Main', memberCount: 10 }, { id: '900000000000000003', name: 'New', memberCount: 5 }] },
    now
  });
  assert.equal(stats.tasks.last24h, 1);
  assert.equal(stats.tasks.last7d, 2);
  assert.equal(stats.tasks.last30d, 3);
  assert.equal(stats.tasks.users30d, 2);
  assert.equal(stats.tasks.active, 2);
  assert.equal(stats.tasks.sleeping, 1);
  assert.equal(stats.tasks.withPr30d, 1);
  assert.equal(stats.tasks.longRunning, 1);
  assert.equal(stats.daily.length, 30);
  assert.equal(stats.daily.reduce((sum, d) => sum + d.tasks, 0), 3);
  assert.deepEqual(stats.actions[0], { action: 'task.stop', count: 2 });
  assert.equal(stats.servers.botIn, 2);
  assert.equal(stats.servers.members, 15);
  assert.equal(stats.servers.configured, 2);
  assert.equal(stats.servers.notConfigured, 1);
  assert.equal(stats.servers.leftWithSettings, 1);
  assert.equal(stats.topServers[0].guildId, G);
  assert.equal(stats.topServers[0].tasks30d, 3);
  assert.ok(stats.database.fileBytes > 0);
  assert.equal(stats.database.tables.find((t) => t.name === 'tasks')?.rows, 3);
  assert.equal(stats.host.errors1h, 2);
  assert.equal(stats.host.topErrors[0].count, 2, 'messages differing only in IDs are grouped');
  const texts = stats.warnings.map((w) => w.text).join('\n');
  assert.match(texts, /2 errors logged in the last hour/);
  assert.match(texts, /1 active task was started over 7 days ago/);
  assert.match(texts, /1 server removed the bot/);
  assert.doesNotMatch(texts, /not connected to Discord/);
});

test('admin stats warn when Discord is down and cleanup failed', () => {
  const { db, now } = seed();
  const health = new HostHealth(now);
  health.recordPrune(0, new Error('database is locked'), now);
  const stats = collectAdminStats({ db, databasePath: ':memory:', health, bot: null, now });
  assert.equal(stats.servers.botIn, null);
  assert.equal(stats.warnings[0].level, 'bad');
  const texts = stats.warnings.map((w) => w.text).join('\n');
  assert.match(texts, /not connected to Discord/);
  assert.match(texts, /cleanup of old data failed: database is locked/);
});

test('captureConsole records errors and still prints them', () => {
  const health = new HostHealth();
  const printed: unknown[][] = [];
  const target = { error: (...args: unknown[]) => void printed.push(args) };
  health.captureConsole(target);
  target.error('Webhook for server %s answered %d.', 'x', 500, '\nsecond line');
  assert.equal(printed.length, 1);
  assert.equal(health.errorsSince(0)[0].text, 'Webhook for server x answered 500. ');
});

test('ADMIN_USER_IDS must be Discord user IDs', () => {
  assert.deepEqual(adminUserIds(null), []);
  assert.deepEqual(adminUserIds(' 100000000000000001, 100000000000000001 ,'), ['100000000000000001']);
  assert.throws(() => adminUserIds('jonathan'), /ADMIN_USER_IDS/);
});

function app(userIds: string[]) {
  const db = openDatabase(':memory:');
  const { identity, directory } = devFixtures(G);
  const health = new HostHealth();
  return createWebApp({
    publicUrl: PUBLIC,
    discordClientId: '1',
    discordClientSecret: 's',
    botPermissions: 1n,
    devinApiUrl: 'https://devin.test',
    secrets: new Secrets('test-master-key-test-master-key-1234'),
    guilds: new GuildStore(db),
    sessions: new SessionStore(db),
    directory,
    admin: { userIds, stats: () => collectAdminStats({ db, databasePath: ':memory:', health, bot: null }) },
    devLogin: identity
  });
}

async function signedIn(web: ReturnType<typeof app>) {
  const res = await web.request(`${PUBLIC}/auth/dev`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0];
  return (path: string) => web.request(`${PUBLIC}${path}`, { headers: { cookie } });
}

test('/admin is only for ADMIN_USER_IDS', async () => {
  const devUser = devFixtures(G).identity.user.id;

  const anonymous = await app([devUser]).request(`${PUBLIC}/admin`);
  assert.equal(anonymous.status, 302);

  const other = await signedIn(app(['100000000000000009']));
  assert.equal((await other('/admin')).status, 404);
  assert.doesNotMatch(await (await other('/')).text(), /href="\/admin"/);

  const admin = await signedIn(app([devUser]));
  const res = await admin('/admin');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const page = await res.text();
  assert.match(page, /Host admin/);
  assert.match(page, /Needs attention/);
  assert.match(page, /not connected to Discord/);
  assert.match(await (await admin('/')).text(), /href="\/admin"/);
});
