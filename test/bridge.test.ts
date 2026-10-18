import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentAdapter, StartTaskInput, TaskUpdate } from '../src/agents/types.ts';
import { Bridge, type ChatPort } from '../src/bridge.ts';
import { TaskStore } from '../src/store.ts';

type Sent = { channelId: string; content: string; ping?: string };

function setup() {
  const sent: Sent[] = [];
  const members: [string, string][] = [];
  const threads: { channelId: string; title: string; intro: string }[] = [];
  const started: StartTaskInput[] = [];
  const forwarded: { taskId: string; text: string }[] = [];
  const updates = new Map<string, TaskUpdate | Error>();
  let nextTask = 1;

  const chat: ChatPort = {
    async createTaskThread(channelId, title, intro) {
      threads.push({ channelId, title, intro });
      return `thread-${threads.length}`;
    },
    async addThreadMember(threadId, userId) {
      members.push([threadId, userId]);
    },
    async send(channelId, content, ping) {
      sent.push({ channelId, content, ...(ping ? { ping } : {}) });
    }
  };
  const agent: AgentAdapter = {
    name: 'Devin',
    async startTask(input) {
      started.push(input);
      const id = `task-${nextTask++}`;
      return { id, url: `https://agent.test/${id}` };
    },
    async sendMessage(taskId, input) {
      forwarded.push({ taskId, text: input.text });
    },
    async getUpdate(taskId) {
      const update = updates.get(taskId);
      if (!update) throw new Error(`no update for ${taskId}`);
      if (update instanceof Error) throw update;
      return update;
    }
  };
  const store = new TaskStore(':memory:');
  const bridge = new Bridge({ agent, store, chat, instructions: 'Fix it.', ignorePrefix: '//' });
  return { bridge, store, sent, members, threads, started, forwarded, updates };
}

const opener = { discordId: '10', name: 'Admin' };
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
  const result = await t.bridge.start({ kind: 'message', opener, channelId: 'chan', message });
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
  await t.bridge.start({ kind: 'message', opener, channelId: 'chan', message });
  const again = await t.bridge.start({ kind: 'message', opener, channelId: 'chan', message });
  assert.deepEqual(again, { started: false, threadId: 'thread-1' });
  assert.equal(t.started.length, 1);
});

test('sync relays messages without pings, pings on PRs and waiting, and never repeats', async () => {
  const t = setup();
  await t.bridge.start({ kind: 'prompt', opener, channelId: 'chan', task: 'Add dark mode', attachments: [] });
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
  await t.bridge.start({ kind: 'prompt', opener, channelId: 'chan', task: 'x', attachments: [] });
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
  await t.bridge.start({ kind: 'prompt', opener, channelId: 'chan', task: 'a', attachments: [] });
  await t.bridge.start({ kind: 'prompt', opener, channelId: 'chan', task: 'b', attachments: [] });
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
