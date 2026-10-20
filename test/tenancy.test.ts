import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PermissionsBitField } from 'discord.js';
import { Bot, unconfiguredReply } from '../src/bot.ts';
import { Bridge, type ChatPort } from '../src/bridge.ts';
import { Secrets, sha256 } from '../src/crypto.ts';
import { discordDirectory } from '../src/discord.ts';
import { MIGRATIONS, SCHEMA_VERSION, migrate, openDatabase } from '../src/db.ts';
import type { DevinApi, StartTaskInput } from '../src/devin.ts';
import { GuildStore } from '../src/guilds.ts';
import { newMcpToken } from '../src/mcp.ts';
import {
  NO_LIMITS,
  ADMIN_ROLE,
  canConfigure,
  hasPermission,
  startLimits,
  type MemberSnapshot,
  type RoleRule
} from '../src/permissions.ts';
import { TaskStore } from '../src/store.ts';
import { devinResolver } from '../src/tenants.ts';
import { controlId } from '../src/triggers.ts';

const KEY = 'a-master-key-that-is-long-enough-123456';

test('secrets round-trip, are bound to their guild and fail with the wrong key', () => {
  const secrets = new Secrets(KEY);
  const blob = secrets.encrypt('cog_secret_4f2a', 'guild-1');
  assert.doesNotMatch(blob, /cog_secret/);
  assert.notEqual(blob, secrets.encrypt('cog_secret_4f2a', 'guild-1'));
  assert.equal(secrets.decrypt(blob, 'guild-1'), 'cog_secret_4f2a');
  assert.throws(() => secrets.decrypt(blob, 'guild-2'));
  assert.throws(() => new Secrets(`${KEY}-other`).decrypt(blob, 'guild-1'));
  const [version, iv, tag, body] = blob.split(':');
  const flipped = Buffer.from(body, 'base64url');
  flipped[0] ^= 1;
  assert.throws(() => secrets.decrypt([version, iv, tag, flipped.toString('base64url')].join(':'), 'guild-1'));
  assert.throws(() => new Secrets('short'), /MASTER_KEY/);
});

const G = '900000000000000001';
const MOD = '300000000000000002';
const HELPER = '300000000000000003';

function member(overrides: Partial<MemberSnapshot> = {}): MemberSnapshot {
  return { id: '10', name: 'Member', roleIds: [G], isAdmin: false, canManageGuild: false, ...overrides };
}

const rules: RoleRule[] = [
  { roleId: MOD, permissions: ['start_tasks', 'reply', 'manage_tasks', 'settings'], limits: { maxAcu: 20, tasksPerDay: null, concurrentTasks: 3 } },
  { roleId: HELPER, permissions: ['start_tasks', 'reply'], limits: { maxAcu: 5, tasksPerDay: 2, concurrentTasks: 1 } }
];

test('permission rules: Administrator, Manage Server, settings role and non-members', () => {
  assert.equal(canConfigure(member({ isAdmin: true }), []), true);
  assert.equal(hasPermission(member({ isAdmin: true }), [], 'start_tasks'), true);
  assert.equal(canConfigure(member({ canManageGuild: true }), []), true);
  assert.equal(hasPermission(member({ canManageGuild: true }), [], 'start_tasks'), false);
  assert.equal(canConfigure(member({ roleIds: [G, MOD] }), rules), true);
  assert.equal(canConfigure(member({ roleIds: [G, HELPER] }), rules), false);
  assert.equal(canConfigure(member(), rules), false);
  assert.equal(canConfigure(null, rules), false);
});

test('start limits take the most generous role, and admins have none', () => {
  assert.deepEqual(startLimits(member({ roleIds: [G, HELPER] }), rules), { maxAcu: 5, tasksPerDay: 2, concurrentTasks: 1 });
  assert.deepEqual(startLimits(member({ roleIds: [G, HELPER, MOD] }), rules), { maxAcu: 20, tasksPerDay: null, concurrentTasks: 3 });
  assert.deepEqual(startLimits(member({ isAdmin: true, roleIds: [G, HELPER] }), rules), NO_LIMITS);
});

test('the Administrator row restricts admins but never removes settings', () => {
  const admin = member({ isAdmin: true });
  const restricted: RoleRule[] = [
    ...rules,
    { roleId: ADMIN_ROLE, permissions: ['reply', 'settings'], limits: NO_LIMITS }
  ];
  assert.equal(hasPermission(admin, restricted, 'start_tasks'), false);
  assert.equal(hasPermission(admin, restricted, 'reply'), true);
  assert.equal(hasPermission(admin, restricted, 'manage_tasks'), false);
  assert.equal(canConfigure(admin, [{ roleId: ADMIN_ROLE, permissions: [], limits: NO_LIMITS }]), true);
  // Real roles still grant what the Administrator row leaves out.
  assert.equal(hasPermission(member({ isAdmin: true, roleIds: [G, HELPER] }), restricted, 'start_tasks'), true);
  // Only the Discord permission confers the Administrator row.
  assert.equal(hasPermission(member({ roleIds: [G, ADMIN_ROLE] }), [{ roleId: ADMIN_ROLE, permissions: ['start_tasks'], limits: NO_LIMITS }], 'start_tasks'), false);

  const capped: RoleRule[] = [
    ...rules,
    { roleId: ADMIN_ROLE, permissions: ['start_tasks', 'settings'], limits: { maxAcu: 10, tasksPerDay: 3, concurrentTasks: 1 } }
  ];
  assert.deepEqual(startLimits(admin, capped), { maxAcu: 10, tasksPerDay: 3, concurrentTasks: 1 });
  assert.deepEqual(startLimits(member({ isAdmin: true, roleIds: [G, HELPER] }), capped), { maxAcu: 10, tasksPerDay: 3, concurrentTasks: 1 });
  assert.deepEqual(startLimits(member({ isAdmin: true, roleIds: [G, MOD] }), capped), { maxAcu: 20, tasksPerDay: null, concurrentTasks: 3 });
});

test('migrations keep starter tasks and are idempotent', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATIONS[0]);
  db.exec('pragma user_version = 1');
  db.prepare(
    `insert into tasks (task_id, agent, thread_id, opener_id, title, url, created_at, updated_at)
     values ('devin-1', 'devin', 'thread-1', '10', 'Old task', 'https://app.devin.ai/sessions/1', 1, 1)`
  ).run();
  migrate(db);
  migrate(db);
  assert.equal((db.prepare('pragma user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
  const tasks = new TaskStore(db);
  const old = tasks.byThread('thread-1');
  assert.equal(old?.title, 'Old task');
  assert.equal(old?.guildId, null);
  assert.deepEqual(tasks.withoutGuild().map((row) => row.taskId), ['devin-1']);
  tasks.update('devin-1', { guildId: G });
  assert.equal(tasks.byThread('thread-1')?.guildId, G);
  assert.deepEqual(tasks.withoutGuild(), []);
});

test('guild settings persist, and only the encrypted key is stored', () => {
  const db = openDatabase(':memory:');
  const guilds = new GuildStore(db);
  const secrets = new Secrets(KEY);
  guilds.ensure(G, 'Test');
  assert.equal(guilds.isConfigured(G), false);
  guilds.saveDevin(G, {
    apiKeyEncrypted: secrets.encrypt('cog_plain_4f2a', G),
    apiKeyHint: '4f2a',
    orgId: 'org-1',
    defaultRepos: ['acme/app'],
    userMap: { '10': 'user-1' }
  });
  guilds.setRoleRules(G, rules);
  guilds.setChannels(G, ['c1', 'c2'], 'c2');
  assert.equal(guilds.isConfigured(G), true);
  assert.deepEqual(guilds.roleRules(G), rules);
  assert.deepEqual(guilds.allowedChannels(G).sort(), ['c1', 'c2']);
  assert.equal(guilds.settings(G)?.taskChannelId, 'c2');
  assert.equal(guilds.devin(G)?.apiKeyHint, '4f2a');
  const dump = JSON.stringify(db.prepare('select * from guild_devin').all());
  assert.doesNotMatch(dump, /cog_plain/);
  assert.equal(devinResolver(guilds, secrets, 'https://devin.test') (G) !== null, true);
  guilds.clearDevin(G);
  assert.equal(guilds.isConfigured(G), false);
});

function botSetup() {
  const db = openDatabase(':memory:');
  const guilds = new GuildStore(db);
  const tasks = new TaskStore(db);
  const started: StartTaskInput[] = [];
  const forwarded: string[] = [];
  const controls: string[] = [];
  const sent: { channelId: string; content: string }[] = [];
  const threadsOnMessage: { channelId: string; messageId: string; title: string }[] = [];
  let next = 1;
  const devin: DevinApi = {
    async startTask(input) {
      started.push(input);
      const id = `task-${next++}`;
      return { id, url: `https://devin.test/${id}` };
    },
    async sendMessage(_taskId, input) {
      forwarded.push(input.text);
    },
    async getUpdate() {
      throw new Error('not used');
    },
    async terminate(taskId) {
      controls.push(`terminate ${taskId}`);
    },
    async sleep(taskId) {
      controls.push(`sleep ${taskId}`);
    },
    async unarchive(taskId) {
      controls.push(`unarchive ${taskId}`);
    }
  };
  let threads = 0;
  const chat: ChatPort = {
    async createTaskThread() {
      return `thread-${++threads}`;
    },
    async createThreadOnMessage(channelId, messageId, title) {
      threadsOnMessage.push({ channelId, messageId, title });
      return `thread-on-${messageId}`;
    },
    async addThreadMember() {},
    async send(channelId, content) {
      sent.push({ channelId, content });
    }
  };
  const bridge = new Bridge({
    devin: (guildId) => (guilds.isConfigured(guildId) ? devin : null),
    store: tasks,
    chat,
    ignorePrefix: '//'
  });
  let now = Date.now();
  const bot = new Bot({ bridge, guilds, tasks, publicUrl: 'https://devin.example.com', now: () => now });
  const configure = () => {
    guilds.ensure(G, 'Test');
    guilds.saveDevin(G, { apiKeyEncrypted: 'x', apiKeyHint: 'abcd', orgId: 'org-1', defaultRepos: [], userMap: {} });
    guilds.setRoleRules(G, rules);
  };
  return {
    bot,
    guilds,
    tasks,
    started,
    forwarded,
    controls,
    sent,
    threadsOnMessage,
    configure,
    advance: (ms: number) => (now += ms)
  };
}

const channel = { id: 'c1', parentId: null };
const message = { id: 'm1', authorName: 'Player', authorId: '99', link: 'https://discord.com/x', content: 'Bug', attachments: [] };

test('every trigger in an unconfigured server gets the setup link', async () => {
  const t = botSetup();
  const expected = "Devin isn't set up in this server yet. An admin can set it up at https://devin.example.com";
  assert.equal(unconfiguredReply('https://devin.example.com'), expected);
  const admin = member({ isAdmin: true });
  const outcomes = [
    await t.bot.startFromMessage(G, admin, channel, message),
    await t.bot.startFromPrompt(G, admin, channel, 'Do a thing', []),
    await t.bot.status(G, admin, 'thread-1'),
    await t.bot.list(G, admin, async () => true)
  ];
  for (const outcome of outcomes) assert.deepEqual(outcome, { ok: false, reason: 'unconfigured', reply: expected });
  assert.equal(t.started.length, 0);
});

test('triggers are gated by role permissions, channels and limits', async () => {
  const t = botSetup();
  t.configure();
  const nobody = member({ id: '1' });
  const helper = member({ id: '2', roleIds: [G, HELPER] });
  const mod = member({ id: '3', roleIds: [G, MOD] });

  const denied = await t.bot.startFromMessage(G, nobody, channel, message);
  assert.equal(denied.ok === false && denied.reason, 'forbidden');
  assert.equal((await t.bot.list(G, nobody, async () => true)).ok, false);

  const first = await t.bot.startFromPrompt(G, helper, channel, 'one', []);
  assert.equal(first.ok && first.started, true);
  assert.equal(t.started[0].maxAcu, 5);
  assert.equal(t.started[0].guildId, G);

  const concurrent = await t.bot.startFromPrompt(G, helper, channel, 'two', []);
  assert.equal(concurrent.ok === false && concurrent.reason, 'limit');
  t.tasks.update('task-1', { active: false });
  assert.equal((await t.bot.startFromPrompt(G, helper, channel, 'two', [])).ok, true);
  t.tasks.update('task-2', { active: false });
  const daily = await t.bot.startFromPrompt(G, helper, channel, 'three', []);
  assert.equal(daily.ok === false && daily.reason, 'limit');
  t.advance(25 * 60 * 60 * 1000);
  assert.equal((await t.bot.startFromPrompt(G, helper, channel, 'three', [])).ok, true);

  t.guilds.setChannels(G, ['c2'], null);
  const wrongChannel = await t.bot.startFromPrompt(G, mod, channel, 'x', []);
  assert.equal(wrongChannel.ok === false && wrongChannel.reason, 'channel');
  assert.equal((await t.bot.startFromPrompt(G, mod, { id: 'thread-x', parentId: 'c2' }, 'x', [])).ok, true);
});

test('thread replies need reply, manage_tasks, or being the opener', async () => {
  const t = botSetup();
  t.configure();
  const helper = member({ id: '2', roleIds: [G, HELPER] });
  await t.bot.startFromPrompt(G, helper, channel, 'one', []);
  const thread = t.tasks.active()[0].threadId;

  const outsider = await t.bot.reply(G, member({ id: '5' }), thread, 'hi', []);
  assert.equal(outsider.ok === false && outsider.reason, 'forbidden');
  assert.equal((await t.bot.reply(G, helper, thread, 'more info', [])).ok, true);
  const other = await t.bot.reply('900000000000000099', helper, thread, 'x', []);
  assert.equal(other.ok === false && other.reason, 'not_task');
  assert.deepEqual(t.forwarded, ['more info']);
});

const BOT = '800000000000000001';
const G2 = '900000000000000002';

function incoming(
  t: ReturnType<typeof botSetup>,
  who: MemberSnapshot,
  content: string,
  overrides: { channel?: { id: string; parentId: string | null }; id?: string; isReply?: boolean } = {}
) {
  const limits: number[] = [];
  const outcome = t.bot.handleMessage({
    guildId: G,
    member: who,
    channel: overrides.channel ?? channel,
    message: { ...message, id: overrides.id ?? `m-${Math.random()}`, authorId: who.id, content },
    botUserId: BOT,
    isReply: overrides.isReply ?? false,
    loadContext: async (limit) => {
      limits.push(limit);
      return { repliedTo: null, recent: [{ ...message, authorName: 'Other', content: 'earlier' }] };
    }
  });
  return { outcome, limits };
}

test('an @mention starts a task with the mention stripped and channel context', async () => {
  const t = botSetup();
  t.configure();
  const helper = member({ id: '2', roleIds: [G, HELPER] });
  const { outcome, limits } = incoming(t, helper, `<@${BOT}> fix the login page`, { id: 'm-start' });
  const result = await outcome;
  assert.equal(result.action, 'started');
  assert.deepEqual(limits, [10]);
  assert.deepEqual(t.threadsOnMessage.map((x) => x.messageId), ['m-start']);
  assert.match(t.started[0].prompt, /\n\nfix the login page\n/);
  assert.doesNotMatch(t.started[0].prompt, new RegExp(BOT));
  assert.match(t.started[0].prompt, /UNTRUSTED[\s\S]*<untrusted_discord_context>[\s\S]*earlier/);
  assert.equal(t.guilds.auditLog(G)[0].action, 'task.start');

  t.guilds.setMentionSettings(G, 3, false);
  t.tasks.update('task-1', { active: false });
  const second = incoming(t, helper, `<@${BOT}> again`, { channel: { id: 't9', parentId: 'c1' } });
  assert.equal((await second.outcome).action, 'started');
  assert.deepEqual(second.limits, [3]);
  assert.equal(t.threadsOnMessage.length, 1, 'a mention inside a thread opens a new task thread instead');
});

test('role mentions, @everyone and plain messages outside task threads are ignored', async () => {
  const t = botSetup();
  t.configure();
  const admin = member({ isAdmin: true });
  for (const content of [`<@&${BOT}> fix it`, '@everyone fix it', 'fix it']) {
    assert.deepEqual(await incoming(t, admin, content).outcome, { action: 'ignored' });
  }
  const empty = await incoming(t, admin, `<@${BOT}>`).outcome;
  assert.equal(empty.action === 'denied' && empty.reason, 'empty');
  assert.equal(t.started.length, 0);
});

test('mentions are gated by start_tasks and the per-role limits', async () => {
  const t = botSetup();
  t.configure();
  const nobody = await incoming(t, member({ id: '1' }), `<@${BOT}> do it`).outcome;
  assert.equal(nobody.action === 'denied' && nobody.reason, 'forbidden');
  const unconfigured = botSetup();
  const setup = await incoming(unconfigured, member({ isAdmin: true }), `<@${BOT}> do it`).outcome;
  assert.equal(setup.action === 'denied' && setup.reason, 'unconfigured');

  const helper = member({ id: '2', roleIds: [G, HELPER] });
  assert.equal((await incoming(t, helper, `<@${BOT}> one`).outcome).action, 'started');
  assert.equal(t.started[0].maxAcu, 5);
  const concurrent = incoming(t, helper, `<@${BOT}> two`);
  const result = await concurrent.outcome;
  assert.equal(result.action === 'denied' && result.reason, 'limit');
  assert.deepEqual(concurrent.limits, [], 'context is not fetched for a denied start');
  t.tasks.update('task-1', { active: false });
  assert.equal((await incoming(t, helper, `<@${BOT}> two`).outcome).action, 'started');
  t.tasks.update('task-2', { active: false });
  const daily = await incoming(t, helper, `<@${BOT}> three`).outcome;
  assert.equal(daily.action === 'denied' && daily.reason, 'limit');
  assert.match(daily.action === 'denied' ? daily.reply : '', /2 tasks per day/);
  t.guilds.setChannels(G, ['c2'], null);
  const elsewhere = await incoming(t, member({ isAdmin: true }), `<@${BOT}> x`).outcome;
  assert.equal(elsewhere.action === 'denied' && elsewhere.reason, 'channel');
});

function seedTask(t: ReturnType<typeof botSetup>, taskId: string, threadId: string, guildId = G, openerId = '7') {
  t.tasks.insert({ taskId, guildId, threadId, sourceMessageId: null, openerId, title: 'Task', url: `https://devin.test/${taskId}` });
}

test('a mention inside a task thread is a reply, not a new task', async () => {
  const t = botSetup();
  t.configure();
  seedTask(t, 'task-a', 'thread-a', G, '2');
  const helper = member({ id: '2', roleIds: [G, HELPER] });
  const inThread = { id: 'thread-a', parentId: 'c1' };
  const result = await incoming(t, helper, `<@${BOT}> also check the footer`, { channel: inThread }).outcome;
  assert.deepEqual(result, { action: 'forwarded' });
  assert.deepEqual(t.forwarded, ['also check the footer']);
  assert.equal(t.started.length, 0);
  assert.deepEqual(await incoming(t, helper, 'plain reply', { channel: inThread }).outcome, { action: 'forwarded' });
  assert.deepEqual(t.forwarded, ['also check the footer', 'plain reply']);
});

test('"Only forward messages that @mention Devin" skips plain thread messages', async () => {
  const t = botSetup();
  t.configure();
  assert.equal(t.guilds.settings(G)?.mentionOnlyReplies, false);
  t.guilds.setMentionSettings(G, 10, true);
  seedTask(t, 'task-a', 'thread-a', G, '2');
  const helper = member({ id: '2', roleIds: [G, HELPER] });
  const inThread = { id: 'thread-a', parentId: 'c1' };
  assert.deepEqual(await incoming(t, helper, 'chatter', { channel: inThread }).outcome, { action: 'ignored' });
  assert.deepEqual(await incoming(t, helper, `<@${BOT}> real feedback`, { channel: inThread }).outcome, { action: 'forwarded' });
  assert.deepEqual(t.forwarded, ['real feedback']);
});

test('stop and sleep: the opener, manage_tasks and Administrators only', async () => {
  const actors = {
    opener: member({ id: '7' }),
    manager: member({ id: '3', roleIds: [G, MOD] }),
    admin: member({ id: '4', isAdmin: true }),
    other: member({ id: '5', roleIds: [G, HELPER] }),
    manageServer: member({ id: '6', canManageGuild: true })
  };
  const allowed = new Set(['opener', 'manager', 'admin']);
  for (const [name, who] of Object.entries(actors)) {
    for (const action of ['stop', 'sleep'] as const) {
      const t = botSetup();
      t.configure();
      seedTask(t, 'task-a', 'thread-a');
      const viaSlash = await t.bot.controlThread(action, G, who, 'thread-a');
      const viaMention = await incoming(t, who, `<@${BOT}> ${action}`, { channel: { id: 'thread-a', parentId: 'c1' } }).outcome;
      if (allowed.has(name)) {
        assert.equal(viaSlash.ok, true, `${name} ${action}`);
        assert.deepEqual(t.controls, [`${action === 'stop' ? 'terminate' : 'sleep'} task-a`]);
        const posted = action === 'stop' ? `Stopped by <@${who.id}>.` : `Put to sleep by <@${who.id}>.`;
        assert.ok(t.sent.some((sent) => sent.channelId === 'thread-a' && sent.content.startsWith(posted)), posted);
        assert.equal(t.guilds.auditLog(G)[0].action, `task.${action}`);
        assert.equal(t.guilds.auditLog(G)[0].actorId, who.id);
        // The second attempt finds the task already stopped or asleep.
        assert.equal(viaMention.action === 'denied' && viaMention.reason, 'ended');
        const row = t.tasks.byThread('thread-a')!;
        if (action === 'stop') assert.equal(row.stoppedBy, who.id);
        else assert.equal(row.sleptBy, who.id);
      } else {
        assert.equal(viaSlash.ok === false && viaSlash.reason, 'forbidden', `${name} ${action}`);
        assert.match(viaSlash.reply, /^You can't do that/);
        assert.equal(viaMention.action === 'denied' && viaMention.reason, 'forbidden');
        assert.deepEqual(t.controls, []);
        assert.deepEqual(t.guilds.auditLog(G), []);
      }
    }
  }
});

test('Stop / Sleep buttons only act on a task of this server, in its own thread', async () => {
  const t = botSetup();
  t.configure();
  seedTask(t, 'task-here', 'thread-here');
  seedTask(t, 'task-there', 'thread-there', G2);
  const admin = member({ id: '4', isAdmin: true });
  const tampered = [
    // Another server's task, pressed from this server (in its thread or ours).
    [controlId('stop', 'task-there'), 'thread-there'],
    [controlId('stop', 'task-there'), 'thread-here'],
    // This server's task, pressed from a different thread.
    [controlId('stop', 'task-here'), 'thread-other'],
    ['devin:stop:task-missing', 'thread-here'],
    ['devin:terminate:task-here', 'thread-here'],
    ['garbage', 'thread-here']
  ];
  for (const [customId, channelId] of tampered) {
    const outcome = await t.bot.controlButton(customId, G, admin, channelId);
    assert.equal(outcome.ok === false && outcome.reason, 'not_task', customId);
  }
  assert.deepEqual(t.controls, []);
  const other = await t.bot.controlButton(controlId('sleep', 'task-here'), G, member({ id: '5' }), 'thread-here');
  assert.equal(other.ok === false && other.reason, 'forbidden');
  const ok = await t.bot.controlButton(controlId('sleep', 'task-here'), G, member({ id: '7' }), 'thread-here');
  assert.equal(ok.ok, true);
  assert.deepEqual(t.controls, ['sleep task-here']);
});

test('a stopped task takes no more replies', async () => {
  const t = botSetup();
  t.configure();
  seedTask(t, 'task-a', 'thread-a');
  await t.bot.controlThread('stop', G, member({ id: '7' }), 'thread-a');
  const reply = await t.bot.reply(G, member({ id: '3', roleIds: [G, MOD] }), 'thread-a', 'more', []);
  assert.equal(reply.ok === false && reply.reason, 'ended');
  assert.deepEqual(t.forwarded, []);
});

test('the setup UI asks Discord for the member instead of trusting the cache', async () => {
  const calls: unknown[] = [];
  const guild = {
    id: '900000000000000001',
    members: {
      fetch: async (options: unknown) => {
        calls.push(options);
        return {
          id: '42',
          displayName: 'Ex-mod',
          guild,
          roles: { cache: new Map() },
          permissions: new PermissionsBitField(0n)
        };
      }
    }
  };
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const member = await discordDirectory(client as never).member(guild.id, '42');
  assert.deepEqual(calls, [{ user: '42', force: true }]);
  assert.deepEqual(member, { id: '42', name: 'Ex-mod', roleIds: [guild.id], isAdmin: false, canManageGuild: false });
});

test('/devin list only shows task threads the member can see', async () => {
  const t = botSetup();
  t.configure();
  const admin = member({ isAdmin: true });
  await t.bot.startFromPrompt(G, admin, channel, 'public task', []);
  await t.bot.startFromPrompt(G, admin, channel, 'staff task', []);
  const [staff, open] = t.tasks.recent(G, 10);
  const listed = await t.bot.list(G, admin, async (threadId) => threadId === open.threadId);
  assert.equal(listed.ok, true);
  assert.match(listed.reply, new RegExp(`<#${open.threadId}>`));
  assert.doesNotMatch(listed.reply, new RegExp(`<#${staff.threadId}>`));
  const none = await t.bot.list(G, admin, async () => {
    throw new Error('Missing Access');
  });
  assert.deepEqual(none, { ok: true, reply: 'No tasks you can see yet.' });
});

test('with an MCP token, each task gets its own MCP task key in the prompt', async () => {
  const t = botSetup();
  t.configure();
  const admin = member({ isAdmin: true });
  await t.bot.startFromPrompt(G, admin, channel, 'no mcp', []);
  assert.doesNotMatch(t.started[0].prompt, /task key/i);

  const token = newMcpToken();
  t.guilds.setMcpToken(G, token.hash, token.hint);
  await t.bot.startFromPrompt(G, admin, channel, 'one', []);
  await t.bot.startFromPrompt(G, admin, channel, 'two', []);
  const keys = t.started.slice(1).map((s) => /Discord MCP task key: (d4dt_\S+)/.exec(s.prompt)?.[1]);
  assert.ok(keys[0] && keys[1] && keys[0] !== keys[1]);
  const owners = keys.map((key) => t.tasks.byMcpKey(sha256(key!))?.title);
  assert.deepEqual(owners, ['one', 'two']);
  assert.equal(t.tasks.byMcpKey(sha256(token.token)), null);
});
