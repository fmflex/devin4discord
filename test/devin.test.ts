import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DevinAdapter, devinState } from '../src/agents/devin.ts';

type Call = { url: string; method: string; body: unknown; auth: string | null };

function fakeFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get('authorization')
    });
    const key = `${method} ${new URL(url).pathname}`;
    if (!(key in routes)) return new Response(JSON.stringify({ detail: 'nope' }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return { calls, impl };
}

const base = '/v3/organizations/org-1';

function adapter(impl: typeof fetch) {
  return new DevinAdapter(
    {
      apiKey: 'cog_test',
      orgId: 'org-1',
      baseUrl: 'https://devin.test/',
      maxAcuLimit: 10,
      repos: ['acme/app'],
      tags: ['team'],
      userMap: new Map([['42', 'user-devin-42']])
    },
    impl
  );
}

test('startTask sends the prompt, attachments, limits and the mapped Devin user', async () => {
  const { calls, impl } = fakeFetch({
    [`POST ${base}/sessions`]: { session_id: 'devin-abc', url: 'https://app.devin.ai/sessions/abc', status: 'new' }
  });
  const task = await adapter(impl).startTask({
    prompt: 'fix it',
    title: 'Fix it',
    attachments: [{ url: 'https://cdn.discordapp.com/a.png', filename: 'a.png' }],
    requestedBy: { discordId: '42', name: 'Jo' }
  });
  assert.deepEqual(task, { id: 'devin-abc', url: 'https://app.devin.ai/sessions/abc' });
  assert.equal(calls[0].url, `https://devin.test${base}/sessions`);
  assert.equal(calls[0].auth, 'Bearer cog_test');
  assert.deepEqual(calls[0].body, {
    prompt: 'fix it',
    title: 'Fix it',
    tags: ['discord', 'team'],
    repos: ['acme/app'],
    max_acu_limit: 10,
    create_as_user_id: 'user-devin-42',
    attachment_urls: ['https://cdn.discordapp.com/a.png']
  });
});

test('sendMessage names the Discord author and omits unmapped users', async () => {
  const { calls, impl } = fakeFetch({ [`POST ${base}/sessions/devin-abc/messages`]: {} });
  await adapter(impl).sendMessage('devin-abc', {
    text: 'looks good',
    attachments: [],
    from: { discordId: '7', name: 'Sam' }
  });
  assert.deepEqual(calls[0].body, { message: 'Sam (Discord): looks good' });
});

test('getUpdate returns only new Devin messages and advances the cursor past user ones', async () => {
  const { impl } = fakeFetch({
    [`GET ${base}/sessions/devin-abc`]: {
      session_id: 'devin-abc',
      url: 'u',
      status: 'running',
      status_detail: 'waiting_for_user',
      pull_requests: [{ pr_url: 'https://github.com/acme/app/pull/1' }]
    },
    [`GET ${base}/sessions/devin-abc/messages`]: {
      items: [
        { event_id: 'e1', message: 'old', source: 'devin' },
        { event_id: 'e2', message: 'new one', source: 'devin' },
        { event_id: 'e3', message: '   ', source: 'devin' },
        { event_id: 'e4', message: 'from a human', source: 'user' }
      ],
      has_next_page: false
    }
  });
  const update = await adapter(impl).getUpdate('devin-abc', 'e1');
  assert.deepEqual(update, {
    state: 'waiting',
    stateLabel: 'waiting for a reply',
    messages: [{ id: 'e2', text: 'new one' }],
    cursor: 'e4',
    pullRequests: ['https://github.com/acme/app/pull/1']
  });
});

test('API errors include the status and detail', async () => {
  const { impl } = fakeFetch({});
  await assert.rejects(adapter(impl).getUpdate('missing', null), /failed with 404: nope/);
});

test('devinState maps Devin statuses', () => {
  assert.deepEqual(devinState({ status: 'running' }), { state: 'working', label: 'working' });
  assert.equal(devinState({ status: 'running', status_detail: 'finished' }).state, 'finished');
  assert.equal(devinState({ status: 'suspended', status_detail: 'inactivity' }).label, 'asleep (a reply wakes it)');
  assert.equal(devinState({ status: 'suspended', status_detail: 'out_of_credits' }).label, 'suspended (out of credits)');
  assert.equal(devinState({ status: 'exit' }).state, 'ended');
  assert.equal(devinState({ status: 'error' }).state, 'failed');
  assert.equal(devinState({ status: 'new' }).state, 'starting');
});
