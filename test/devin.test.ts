import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DevinClient, devinState, verifyDevinCredentials, verifyDevinOrgUser } from '../src/devin.ts';

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
  return new DevinClient(
    {
      apiKey: 'cog_test',
      orgId: 'org-1',
      baseUrl: 'https://devin.test/',
      repos: ['acme/app'],
      userMap: { '42': 'user-devin-42' }
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
    requestedBy: { discordId: '42', name: 'Jo' },
    guildId: '900',
    maxAcu: 10
  });
  assert.deepEqual(task, { id: 'devin-abc', url: 'https://app.devin.ai/sessions/abc' });
  assert.equal(calls[0].url, `https://devin.test${base}/sessions`);
  assert.equal(calls[0].auth, 'Bearer cog_test');
  assert.deepEqual(calls[0].body, {
    prompt: 'fix it',
    title: 'Fix it',
    tags: ['discord', 'discord-guild:900', 'discord-user:42'],
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

test('verifyDevinCredentials checks the key read-only and rejects bad keys or orgs', async () => {
  const ok = fakeFetch({
    'GET /v3/self': { principal_type: 'service_user', service_user_name: 'bot', org_id: 'org-1' },
    [`GET ${base}/sessions`]: { items: [] }
  });
  const input = { apiKey: 'cog_test', orgId: 'org-1', baseUrl: 'https://devin.test' };
  assert.deepEqual(await verifyDevinCredentials(input, ok.impl), { name: 'bot' });
  assert.deepEqual(ok.calls.map((c) => c.method), ['GET', 'GET']);
  assert.equal(ok.calls[1].url, `https://devin.test${base}/sessions?first=1`);

  await assert.rejects(verifyDevinCredentials({ ...input, orgId: 'org-2' }, ok.impl), /belongs to organization org-1/);

  const denied = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  await assert.rejects(verifyDevinCredentials(input, denied), /rejected this API key/);
});

test('stop terminates and sleep archives the session with the documented v3 calls', async () => {
  const { calls, impl } = fakeFetch({
    [`DELETE ${base}/sessions/devin-abc`]: {},
    [`POST ${base}/sessions/devin-abc/archive`]: {},
    [`POST ${base}/sessions/devin-abc/unarchive`]: {}
  });
  const client = adapter(impl);
  await client.terminate('devin-abc');
  await client.sleep('devin-abc');
  await client.unarchive('devin-abc');
  assert.deepEqual(
    calls.map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`),
    [`DELETE ${base}/sessions/devin-abc`, `POST ${base}/sessions/devin-abc/archive`, `POST ${base}/sessions/devin-abc/unarchive`]
  );
  assert.ok(calls.every((call) => call.auth === 'Bearer cog_test' && call.body === undefined));
});

test('verifyDevinOrgUser looks the user up in the org and explains failures', async () => {
  const input = { apiKey: 'cog_test', orgId: 'org-1', baseUrl: 'https://devin.test', userId: 'user-a' };
  const ok = fakeFetch({ 'GET /v3beta1/organizations/org-1/members/users/user-a': { user_id: 'user-a' } });
  await verifyDevinOrgUser(input, ok.impl);
  assert.equal(ok.calls[0].url, 'https://devin.test/v3beta1/organizations/org-1/members/users/user-a');
  assert.equal(ok.calls[0].auth, 'Bearer cog_test');
  await assert.rejects(verifyDevinOrgUser(input, fakeFetch({}).impl), /user-a isn't a user in organization org-1/);
  const forbidden = (async () => new Response('{}', { status: 403 })) as typeof fetch;
  await assert.rejects(verifyDevinOrgUser(input, forbidden), /ViewOrgMembership/);
});
