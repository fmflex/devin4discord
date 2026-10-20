import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bridge, TaskStartError, type ChatPort } from '../src/bridge.ts';
import { openDatabase } from '../src/db.ts';
import type { DevinApi, StartTaskInput, TaskUpdate } from '../src/devin.ts';
import { TaskStore } from '../src/store.ts';

type Sent = { channelId: string; content: string; ping?: string; buttons?: string[] };

function setup() {
  const sent: Sent[] = [];
  const members: [string, string][] = [];
  const threads: { channelId: string; title: string; intro: string }[] = [];
  const started: StartTaskInput[] = [];
  const forwarded: { taskId: string; text: string }[] = [];
  const threadsOnMessage: { channelId: string; messageId: string; title: string }[] = [];
  const controls: string[] = [];
  const updates = new Map<string, TaskUpdate | Error>();
  let nextTask = 1;
  const failures: { thread?: Error; terminate?: Error } = {};

  const chat: ChatPort = {
    async createTaskThread(channelId, title, intro) {
      if (failures.thread) throw failures.thread;
      threads.push({ channelId, title, intro });
      return `thread-${threads.length}`;
    },
    async createThreadOnMessage(channelId, messageId, title) {
      threadsOnMessage.push({ channelId, messageId, title });
      return `thread-on-${messageId}`;
    },
    async addThreadMember(threadId, userId) {
      members.push([threadId, userId]);
    },
    async send(channelId, content, ping, buttons) {
      sent.push({ channelId, content, ...(ping ? { ping } : {}), ...(buttons ? { buttons: buttons.map((b) => b.customId) } : {}) });
    }
  };
  const devin: DevinApi = {
    async startTask(input) {
      started.push(input);
      const id = `task-${nextTask++}`;
      return { id, url: `https://agent.test/${id}` };
    },
    async sendMessage(taskId, input) {
      forwarded.push({ taskId, text: input.text });
    },
    async terminate(taskId) {
      if (failures.terminate) throw failures.terminate;
      controls.push(`terminate ${taskId}`);
    },
    async sleep(taskId) {
      controls.push(`sleep ${taskId}`);
    },
    async unarchive(taskId) {
      controls.push(`unarchive ${taskId}`);
    },
    async getUpdate(taskId) {
      const update = updates.get(taskId);
      if (!update) throw new Error(`no update for ${taskId}`);
      if (update instanceof Error) throw update;
      return update;
    }
  };
  const store = new TaskStore(openDatabase(':memory:'));
  const bridge = new Bridge({ devin: (guildId) => (guildId === 'g1' ? devin : null), store, chat, ignorePrefix: '//' });
  return { bridge, store, sent, members, threads, threadsOnMessage, started, forwarded, updates, controls, failures };
}

const opener = { discordId: '10', name: 'Admin' };
const base = { guildId: 'g1', opener, instructions: 'Fix it.', maxAcu: null };
const message = {
  id: 'msg-1',
  authorName: 'Player',
  authorId: '99',
  link: 'https://discord.com/channels/1/2/msg-1',
  content: 'The button does nothing',
  attachments: [{ url: 'https://cdn.test/shot.png', filename: 'shot.png' }]
};

function update(overrides: Partial<TaskUpdate> = {}): TaskUpdate {
  return {
    state: 'working',
    stateLabel: 'working',
    messages: [],
    cursor: null,
    pullRequests: [],
    ...overrides
  };
}

test('starting from a message opens a thread, adds the opener and stores the task', async () => {
  const t = setup();
  const result = await t.bridge.start({ kind: 'message', ...base, channelId: 'chan', message });
  assert.deepEqual(result, { started: true, threadId: 'thread-1', url: 'https://agent.test/task-1' });
  assert.equal(t.started[0].title, 'Player: The button does nothing');
  assert.match(t.started[0].prompt, /> The button does nothing/);
  assert.match(t.started[0].prompt, /Fix it\./);
  assert.deepEqual(t.started[0].attachments, message.attachments);
  assert.equal(t.threads[0].channelId, 'chan');
  assert.match(t.threads[0].intro, /Started by <@10> from https:\/\/discord\.com/);
  assert.deepEqual(t.members, [['thread-1', '10']]);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].ping, undefined);
  assert.equal(t.store.byThread('thread-1')?.taskId, 'task-1');
});

test('the same message does not start a second task', async () => {
  const t = setup();
  await t.bridge.start({ kind: 'message', ...base, channelId: 'chan', message });
  const again = await t.bridge.start({ kind: 'message', ...base, channelId: 'chan', message });
  assert.deepEqual(again, { started: false, threadId: 'thread-1' });
  assert.equal(t.started.length, 1);
});

test('sync relays messages without pings, pings on PRs and waiting, and never repeats', async () => {
  const t = setup();
  await t.bridge.start({ kind: 'prompt', ...base, channelId: 'chan', task: 'Add dark mode', attachments: [] });
  t.sent.length = 0;
  t.updates.set(
    'task-1',
    update({
      state: 'waiting',
      stateLabel: 'waiting for a reply',
      messages: [{ id: 'e1', text: 'Which theme?' }],
      cursor: 'e1',
      pullRequests: ['https://github.com/acme/app/pull/7']
    })
  );
  await t.bridge.syncAll();
  assert.deepEqual(t.sent, [
    { channelId: 'thread-1', content: '**Devin:** Which theme?' },
    { channelId: 'thread-1', content: '<@10> **Pull request:** https://github.com/acme/app/pull/7', ping: '10' },
    { channelId: 'thread-1', content: '<@10> Devin is waiting for a reply: reply in this thread.', ping: '10' }
  ]);

  t.sent.length = 0;
  t.updates.set(
    'task-1',
    update({
      state: 'waiting',
      stateLabel: 'waiting for a reply',
      cursor: 'e1',
      pullRequests: ['https://github.com/acme/app/pull/7']
    })
  );
  await t.bridge.syncAll();
  assert.deepEqual(t.sent, []);
});

test('a finished or failed task stops being polled until someone replies', async () => {
  const t = setup();
  await t.bridge.start({ kind: 'prompt', ...base, channelId: 'chan', task: 'x', attachments: [] });
  t.updates.set('task-1', update({ state: 'ended', stateLabel: 'ended' }));
  await t.bridge.syncAll();
  assert.equal(t.store.active().length, 0);
  assert.equal(t.sent.at(-1)?.content, '<@10> Task ended.');

  assert.equal(await t.bridge.forward('thread-1', opener, 'one more thing', []), true);
  assert.deepEqual(t.forwarded, [{ taskId: 'task-1', text: 'one more thing' }]);
  assert.equal(t.store.active().length, 1);
});

test('forward ignores threads without a task', async () => {
  const t = setup();
  assert.equal(await t.bridge.forward('elsewhere', opener, 'hi', []), false);
  assert.deepEqual(t.forwarded, []);
});

test('one failing task does not stop the others from syncing', async () => {
  const t = setup();
  await t.bridge.start({ kind: 'prompt', ...base, channelId: 'chan', task: 'a', attachments: [] });
  await t.bridge.start({ kind: 'prompt', ...base, channelId: 'chan', task: 'b', attachments: [] });
  t.sent.length = 0;
  t.updates.set('task-1', new Error('boom'));
  t.updates.set('task-2', update({ messages: [{ id: 'e1', text: 'hello' }], cursor: 'e1' }));
  const originalError = console.error;
  console.error = () => {};
  try {
    await t.bridge.syncAll();
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(t.sent, [{ channelId: 'thread-2', content: '**Devin:** hello' }]);
});

test('tasks record their server and fail in a server without Devin', async () => {
  const t = setup();
  await t.bridge.start({ kind: 'prompt', ...base, maxAcu: 5, channelId: 'chan', task: 'x', attachments: [] });
  assert.equal(t.store.byThread('thread-1')?.guildId, 'g1');
  assert.equal(t.started[0].guildId, 'g1');
  assert.equal(t.started[0].maxAcu, 5);
  await assert.rejects(
    t.bridge.start({ kind: 'prompt', ...base, guildId: 'g2', channelId: 'chan', task: 'x', attachments: [] }),
    /not set up/
  );
});

const mention = {
  kind: 'mention' as const,
  ...base,
  channelId: 'chan',
  message: { ...message, content: '<@800> the button does nothing' },
  text: 'the button does nothing',
  context: {
    repliedTo: { ...message, id: undefined, authorName: 'Bob', content: 'see this', attachments: [{ url: 'https://cdn.test/b.png', filename: 'b.png' }] },
    recent: []
  },
  threadOnMessage: true
};

test('a mention opens the thread on the message and posts Stop / Sleep buttons', async () => {
  const t = setup();
  const result = await t.bridge.start(mention);
  assert.deepEqual(result, { started: true, threadId: 'thread-on-msg-1', url: 'https://agent.test/task-1' });
  assert.deepEqual(t.threadsOnMessage, [{ channelId: 'chan', messageId: 'msg-1', title: 'Devin: the button does nothing' }]);
  assert.equal(t.threads.length, 0);
  assert.match(t.started[0].prompt, /Admin asked you on Discord.*\n\nthe button does nothing/);
  assert.match(t.started[0].prompt, /<untrusted_discord_context_\w+>[\s\S]*Bob[\s\S]*see this/);
  assert.deepEqual(t.started[0].attachments.map((file) => file.filename), ['shot.png', 'b.png']);
  assert.match(t.sent[0].content, /Started by <@10>/);
  assert.deepEqual(t.sent.at(-1)?.buttons, ['devin:stop:task-1', 'devin:sleep:task-1']);
});

test('stop terminates the session, ends the sync and refuses later replies', async () => {
  const t = setup();
  await t.bridge.start({ kind: 'prompt', ...base, channelId: 'chan', task: 'x', attachments: [] });
  const row = t.store.byThread('thread-1')!;
  await t.bridge.stop(row, { discordId: '5', name: 'Mod' });
  assert.deepEqual(t.controls, ['terminate task-1']);
  assert.equal(t.sent.at(-1)?.content, 'Stopped by <@5>.');
  const after = t.store.byThread('thread-1')!;
  assert.equal(after.stoppedBy, '5');
  assert.equal(after.active, false);
  assert.deepEqual(t.store.active(), []);
  assert.equal(await t.bridge.forward('thread-1', opener, 'more', []), false);
  assert.deepEqual(t.forwarded, []);
});

test('a sync that finishes after a stop does not revive the task', async () => {
  const t = setup();
  await t.bridge.start({ kind: 'prompt', ...base, channelId: 'chan', task: 'x', attachments: [] });
  const row = t.store.byThread('thread-1')!;
  t.updates.set('task-1', update({ state: 'waiting', stateLabel: 'waiting for a reply' }));
  await t.bridge.stop(row, opener);
  await t.bridge.sync(row);
  assert.equal(t.store.byThread('thread-1')?.active, false);
  assert.ok(!t.sent.some((sent) => /waiting for a reply/.test(sent.content)));
});

test('after sleep the next reply wakes Devin and unarchives the session', async () => {
  const t = setup();
  await t.bridge.start({ kind: 'prompt', ...base, channelId: 'chan', task: 'x', attachments: [] });
  await t.bridge.sleep(t.store.byThread('thread-1')!, opener);
  assert.equal(t.sent.at(-1)?.content, 'Put to sleep by <@10>. A reply in this thread wakes Devin.');
  assert.equal(t.store.byThread('thread-1')?.sleptBy, '10');
  assert.equal(await t.bridge.forward('thread-1', opener, 'wake up', []), true);
  assert.deepEqual(t.forwarded, [{ taskId: 'task-1', text: 'wake up' }]);
  assert.deepEqual(t.controls, ['sleep task-1', 'unarchive task-1']);
  assert.equal(t.store.byThread('thread-1')?.sleptBy, null);
  await t.bridge.forward('thread-1', opener, 'again', []);
  assert.deepEqual(t.controls, ['sleep task-1', 'unarchive task-1']);
});

test('a session whose thread fails stays counted until it is terminated, at the latest on restart', async () => {
  const t = setup();
  t.failures.thread = new Error('Missing Access');
  t.failures.terminate = new Error('Devin is down');
  await assert.rejects(
    t.bridge.start({ kind: 'message', ...base, channelId: 'chan', message }),
    (error: unknown) => error instanceof TaskStartError && error.url === 'https://agent.test/task-1'
  );
  assert.deepEqual(t.controls, []);
  assert.equal(t.store.countActive('g1', '10'), 1, 'the running session still counts');
  assert.equal(t.store.byId('task-1'), null, 'but is not a visible task');
  assert.equal((await t.bridge.start({ kind: 'message', ...base, channelId: 'chan', message })).started, false);
  assert.equal(t.started.length, 1);

  await t.bridge.recoverPending();
  assert.equal(t.store.pendingRows().length, 1, 'kept while terminating still fails');
  delete t.failures.terminate;
  await t.bridge.recoverPending();
  assert.deepEqual(t.controls, ['terminate task-1']);
  assert.deepEqual(t.store.pendingRows(), []);
  assert.equal(t.store.countActive('g1', '10'), 0);

  t.store.reserve({ guildId: 'g1', openerId: '10', sourceMessageId: 'msg-2' });
  await t.bridge.recoverPending();
  assert.deepEqual(t.controls, ['terminate task-1'], 'a reservation without a session is just dropped');
  assert.deepEqual(t.store.pendingRows(), []);
});
