import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Secrets, sha256 } from '../src/crypto.ts';
import { openDatabase } from '../src/db.ts';
import { devFixtures, devLoginEnabled } from '../src/dev-web.ts';
import type { Directory } from '../src/directory.ts';
import { GuildStore } from '../src/guilds.ts';
import type { MemberSnapshot } from '../src/permissions.ts';
import { MAX_FORM_BYTES, SESSION_COOKIE, STATE_COOKIE, createWebApp, type WebDeps } from '../src/web/app.ts';
import { checkOAuthState } from '../src/web/oauth.ts';
import { SessionStore } from '../src/web/sessions.ts';

const PUBLIC = 'https://devin.example.com';
const G = '900000000000000001';
const USER = '100000000000000001';
const SETTINGS_ROLE = '300000000000000009';

type Call = { url: string; method: string };

function setup(
  memberOf: MemberSnapshot | null = { id: USER, name: 'Dev', roleIds: [G], isAdmin: true, canManageGuild: true },
  mcp?: WebDeps['mcp']
) {
  const db = openDatabase(':memory:');
  const guilds = new GuildStore(db);
  const secrets = new Secrets('test-master-key-test-master-key-1234');
  const calls: Call[] = [];
  const responses = new Map<string, { status: number; body: unknown }>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const hit = responses.get(`${method} ${new URL(url).pathname}`);
    if (!hit) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status });
  }) as typeof fetch;
  const { identity } = devFixtures(G);
  const state = { member: memberOf };
  const directory: Directory = {
    hasGuild: (id) => id === G,
    guildName: () => 'Test server',
    member: async (id, userId) => (id === G && userId === USER ? state.member : null),
    roles: async () => [
      { id: G, name: '@everyone', color: 0, position: 0, managed: false },
      { id: SETTINGS_ROLE, name: 'Mods', color: 0, position: 1, managed: false }
    ],
    channels: async () => [
      { id: '400000000000000001', name: 'general', kind: 'text', category: null, position: 0 },
      { id: '400000000000000003', name: 'bug-reports', kind: 'forum', category: 'Community', position: 1 }
    ]
  };
  const app = createWebApp({
    publicUrl: PUBLIC,
    discordClientId: '123',
    discordClientSecret: 'client-secret',
    botPermissions: 1n,
    devinApiUrl: 'https://devin.test',
    secrets,
    guilds,
    sessions: new SessionStore(db),
    directory,
    fetch: fetchImpl,
    mcp,
    devLogin: { ...identity, guilds: [{ ...identity.guilds[0], id: G }] }
  });
  const request = (path: string, init: RequestInit = {}) => app.request(`${PUBLIC}${path}`, init);
  return { app, db, guilds, secrets, calls, responses, state, directory, request };
}

function cookie(res: Response, name: string) {
  const found = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return found?.split(';')[0] ?? null;
}

async function signIn(t: ReturnType<typeof setup>) {
  const res = await t.request('/auth/dev');
  const session = cookie(res, SESSION_COOKIE);
  assert.ok(session);
  const page = await (await t.request(`/g/${G}/channels`, { headers: { cookie: session } })).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1];
  assert.ok(csrf);
  return { session, csrf };
}

function post(t: ReturnType<typeof setup>, path: string, session: string, form: Record<string, string>, origin = PUBLIC) {
  return t.request(path, {
    method: 'POST',
    headers: { cookie: session, origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form)
  });
}

test('checkOAuthState needs a matching, signed state', () => {
  assert.equal(checkOAuthState('abc', 'abc'), true);
  assert.equal(checkOAuthState('abc', 'abd'), false);
  assert.equal(checkOAuthState(undefined, 'abc'), false);
  assert.equal(checkOAuthState(false, 'abc'), false);
  assert.equal(checkOAuthState('abc', null), false);
});

test('Discord sign-in sets a state cookie and rejects a callback with the wrong state', async () => {
  const t = setup();
  const login = await t.request('/auth/login');
  assert.equal(login.status, 302);
  const location = new URL(login.headers.get('location')!);
  assert.equal(location.origin, 'https://discord.com');
  assert.equal(location.searchParams.get('scope'), 'identify guilds');
  assert.equal(location.searchParams.get('redirect_uri'), `${PUBLIC}/auth/callback`);
  const state = location.searchParams.get('state')!;
  const raw = login.headers.getSetCookie().find((c) => c.startsWith(`${STATE_COOKIE}=`))!;
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /Secure/);
  assert.match(raw, /SameSite=Lax/);
  const stateCookie = raw.split(';')[0];

  const forged = await t.request(`/auth/callback?code=c&state=${state}x`, { headers: { cookie: stateCookie } });
  assert.equal(forged.status, 400);
  const noCookie = await t.request(`/auth/callback?code=c&state=${state}`);
  assert.equal(noCookie.status, 400);
  assert.equal(t.calls.length, 0);

  t.responses.set('POST /api/v10/oauth2/token', { status: 200, body: { access_token: 'at', token_type: 'Bearer' } });
  t.responses.set('GET /api/v10/users/@me', { status: 200, body: { id: USER, username: 'dev', avatar: null } });
  t.responses.set('GET /api/v10/users/@me/guilds', { status: 200, body: [{ id: G, name: 'Test', icon: null, owner: false, permissions: '0' }] });
  const ok = await t.request(`/auth/callback?code=c&state=${state}`, { headers: { cookie: stateCookie } });
  assert.equal(ok.status, 302);
  const session = ok.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
  assert.match(session, /HttpOnly/);
  assert.match(session, /Secure/);
  assert.match(session, /SameSite=Lax/);
  const picker = await (await t.request('/', { headers: { cookie: session.split(';')[0] } })).text();
  assert.match(picker, /Configure/);
});

test('forms are rejected without the CSRF token or from another origin', async () => {
  const t = setup();
  const { session, csrf } = await signIn(t);
  const path = `/g/${G}/channels`;
  assert.equal((await post(t, path, session, { allowed: '400000000000000001' })).status, 403);
  assert.equal((await post(t, path, session, { _csrf: 'wrong', allowed: '400000000000000001' })).status, 403);
  assert.equal((await post(t, path, session, { _csrf: csrf }, 'https://evil.example')).status, 403);
  assert.equal((await post(t, '/auth/logout', '', { _csrf: csrf })).status, 403);
  assert.deepEqual(t.guilds.allowedChannels(G), []);
  const ok = await post(t, path, session, { _csrf: csrf, allowed: '400000000000000001', task_channel: '' });
  assert.equal(ok.status, 302);
  assert.deepEqual(t.guilds.allowedChannels(G), ['400000000000000001']);
  assert.equal(t.guilds.auditLog(G)[0].action, 'channels.update');
});

function trackedBody(chunks: number, chunkSize = 16 * 1024) {
  const read = { chunks: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (read.chunks >= chunks) return controller.close();
      read.chunks++;
      controller.enqueue(new Uint8Array(chunkSize).fill(97));
    }
  });
  return { body, read };
}

test('anonymous and cross-origin POSTs are rejected before the body is read', async () => {
  const t = setup();
  const anonymous = trackedBody(1000);
  const res = await t.request('/anything', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: anonymous.body,
    duplex: 'half'
  } as RequestInit);
  assert.equal(res.status, 403);
  assert.ok(anonymous.read.chunks <= 1, `read ${anonymous.read.chunks} chunks`);

  const { session } = await signIn(t);
  const foreign = trackedBody(1000);
  const cross = await t.request(`/g/${G}/channels`, {
    method: 'POST',
    headers: { cookie: session, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
    body: foreign.body,
    duplex: 'half'
  } as RequestInit);
  assert.equal(cross.status, 403);
  assert.ok(foreign.read.chunks <= 1, `read ${foreign.read.chunks} chunks`);
});

test('signed-in forms over the size limit are refused without being parsed', async () => {
  const t = setup();
  const { session, csrf } = await signIn(t);
  const path = `/g/${G}/channels`;
  const big = await post(t, path, session, { _csrf: csrf, allowed: '1'.repeat(MAX_FORM_BYTES) });
  assert.equal(big.status, 413);

  const streamed = trackedBody(1000);
  const chunked = await t.request(path, {
    method: 'POST',
    headers: { cookie: session, origin: PUBLIC, 'content-type': 'application/x-www-form-urlencoded' },
    body: streamed.body,
    duplex: 'half'
  } as RequestInit);
  assert.equal(chunked.status, 413);
  assert.ok(streamed.read.chunks <= MAX_FORM_BYTES / (16 * 1024) + 2, `read ${streamed.read.chunks} chunks`);
  assert.deepEqual(t.guilds.allowedChannels(G), []);

  const ok = await post(t, path, session, { _csrf: csrf, allowed: '400000000000000001', task_channel: '' });
  assert.equal(ok.status, 302);
});

test('MCP request bodies are size-capped before the handler reads them', async () => {
  let called = 0;
  const t = setup(undefined, async () => {
    called++;
    return new Response('{}');
  });
  const big = await t.request('/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
    body: 'x'.repeat(256 * 1024 + 1)
  });
  assert.equal(big.status, 413);
  assert.equal(called, 0);
  const small = await t.request('/mcp', { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{}' });
  assert.equal(small.status, 200);
  assert.equal(called, 1);
});

test('server pages are checked against the live member, not the OAuth list', async () => {
  const t = setup();
  const { session } = await signIn(t);
  const page = (path: string) => t.request(path, { headers: { cookie: session } });
  assert.equal((await page(`/g/${G}/permissions`)).status, 200);

  t.state.member = { id: USER, name: 'Dev', roleIds: [G], isAdmin: false, canManageGuild: true };
  assert.equal((await page(`/g/${G}/devin`)).status, 200);

  t.state.member = { id: USER, name: 'Dev', roleIds: [G, SETTINGS_ROLE], isAdmin: false, canManageGuild: false };
  assert.equal((await page(`/g/${G}/devin`)).status, 403);
  t.guilds.setRoleRules(G, [
    { roleId: SETTINGS_ROLE, permissions: ['settings'], limits: { maxAcu: null, tasksPerDay: null, concurrentTasks: null } }
  ]);
  assert.equal((await page(`/g/${G}/devin`)).status, 200);

  t.state.member = null;
  assert.equal((await page(`/g/${G}/devin`)).status, 403);
  assert.doesNotMatch(await (await page('/')).text(), /\/g\/900000000000000001\/devin/);
  assert.equal((await page('/g/900000000000000002/devin')).status, 404);
  assert.equal((await t.request(`/g/${G}/devin`)).status, 302);
});

test('the Administrator row saves restrictions, keeps settings and reverts to the default', async () => {
  const t = setup();
  const { session, csrf } = await signIn(t);
  const page = await (await t.request(`/g/${G}/permissions`, { headers: { cookie: session } })).text();
  assert.match(page, /name="p_administrator" value="start_tasks"[^>]* checked/);
  assert.match(page, /name="p_administrator" value="settings"[^>]* checked disabled/);

  const saved = await post(t, `/g/${G}/permissions`, session, { _csrf: csrf, p_administrator: 'reply', acu_administrator: '10' });
  assert.equal(saved.status, 302);
  assert.deepEqual(t.guilds.roleRules(G), [
    { roleId: 'administrator', permissions: ['reply', 'settings'], limits: { maxAcu: 10, tasksPerDay: null, concurrentTasks: null } }
  ]);
  assert.equal(t.guilds.auditLog(G)[0].detail, 'Administrator: reply, settings (10 ACU)');

  const all = new URLSearchParams([
    ['_csrf', csrf],
    ...['start_tasks', 'reply', 'manage_tasks'].map((p): [string, string] => ['p_administrator', p])
  ]);
  const reverted = await t.request(`/g/${G}/permissions`, {
    method: 'POST',
    headers: { cookie: session, origin: PUBLIC, 'content-type': 'application/x-www-form-urlencoded' },
    body: all
  });
  assert.equal(reverted.status, 302);
  assert.deepEqual(t.guilds.roleRules(G), []);
});

test('every settings page explains its settings with links to the docs', async () => {
  const t = setup();
  const { session } = await signIn(t);
  const page = async (tab: string) => (await t.request(`/g/${G}/${tab}`, { headers: { cookie: session } })).text();
  const devin = await page('devin');
  assert.match(devin, /<details class="help"><summary aria-label="About the API key"/);
  assert.match(devin, /href="https:\/\/docs\.devin\.ai\/api-reference\/authentication#service-users/);
  assert.match(devin, /href="https:\/\/support\.discord\.com\/hc\/en-us\/articles\/206346498/);
  const permissions = await page('permissions');
  assert.match(permissions, /aria-label="About Manage tasks"/);
  assert.match(permissions, /aria-label="About the ACU cap"/);
  assert.match(await page('channels'), /aria-label="About allowed channels"/);
});

test('the MCP token is shown once, stored hashed, rotated and revoked', async () => {
  const t = setup();
  const { session, csrf } = await signIn(t);
  const empty = await (await t.request(`/g/${G}/mcp`, { headers: { cookie: session } })).text();
  assert.match(empty, /No token yet/);
  assert.match(empty, /value="https:\/\/devin\.example\.com\/mcp"/);

  const created = await post(t, `/g/${G}/mcp/token`, session, { _csrf: csrf });
  assert.equal(created.status, 200);
  const token = /<code class="token">(d4d_[\w-]+)<\/code>/.exec(await created.text())?.[1];
  assert.ok(token);
  const stored = t.db.prepare('select token_hash from guild_mcp where guild_id = ?').get(G) as { token_hash: string };
  assert.notEqual(stored.token_hash, token);
  assert.equal(t.guilds.guildForMcpToken(sha256(token)), G);
  const again = await (await t.request(`/g/${G}/mcp`, { headers: { cookie: session } })).text();
  assert.ok(!again.includes(token));
  assert.match(again, new RegExp(`ends in …${token.slice(-4)}`));

  await post(t, `/g/${G}/mcp/token`, session, { _csrf: csrf });
  assert.equal(t.guilds.guildForMcpToken(sha256(token)), null);
  assert.equal((await post(t, `/g/${G}/mcp/remove`, session, { _csrf: csrf })).status, 302);
  assert.equal(t.guilds.mcpToken(G), null);
  assert.deepEqual(t.guilds.auditLog(G).map((e) => e.action), ['mcp.remove', 'mcp.token', 'mcp.token']);
});

test('MCP read and post channels are configured together with admin opt-in', async () => {
  const t = setup();
  const { session, csrf } = await signIn(t);
  const allChannelFallback = await (await t.request(`/g/${G}/mcp`, { headers: { cookie: session } })).text();
  assert.doesNotMatch(allChannelFallback, /Channels marked "bot can't/);
  assert.match(allChannelFallback, /Reading: none ticked, so it follows the Channels tab: every channel\./);
  t.guilds.setChannels(G, ['400000000000000001'], null);
  t.directory.channels = async () => [
    { id: '400000000000000001', name: 'general', kind: 'text', category: null, position: 0, bot: { read: false, post: true } },
    { id: '400000000000000003', name: 'bug-reports', kind: 'forum', category: 'Community', position: 1 },
    { id: '400000000000000004', name: 'dev-help', kind: 'text', category: 'Development', position: 2, bot: { read: true, post: false } }
  ];
  const page = await (await t.request(`/g/${G}/mcp`, { headers: { cookie: session } })).text();
  assert.match(page, /<h3>Channels<\/h3>/);
  assert.match(page, /Reading: none ticked, so it follows the Channels tab: #general\./);
  assert.match(page, new RegExp(`action="/g/${G}/mcp/channels"`));
  assert.match(page, /name="read" value="400000000000000001"/);
  assert.match(page, /name="post" value="400000000000000001"/);
  assert.match(page, /name="read" value="400000000000000003"/);
  assert.doesNotMatch(page, /name="post" value="400000000000000003"/);
  assert.match(page, /<span class="muted small">n\/a<\/span>/);
  assert.match(page, /About MCP read channels/);
  assert.match(page, /About MCP posting channels/);
  assert.match(page, /Channels Devin may read through MCP/);
  assert.match(page, /With none ticked, it follows the Allowed list on the Channels tab \(every channel when that's empty too\)\./);
  assert.match(page, /bot can't read here/);
  assert.match(page, /bot can't post here/);
  assert.match(page, /class="noaccess"/);
  assert.match(page, /Channels marked "bot can't…" need the bot's role to get View Channel and Read Message History \(Read\) or Send Messages \(Post\) in Discord\./);
  assert.match(page, /href="https:\/\/support\.discord\.com\/hc\/en-us\/articles\/206141927-How-is-the-permission-hierarchy-structured"/);
  assert.doesNotMatch(page, /name="read"[^>]*disabled/);
  assert.doesNotMatch(page, /name="post"[^>]*disabled/);

  const path = `/g/${G}/mcp/channels`;
  assert.equal((await post(t, path, session, { read: '400000000000000001', post: '400000000000000001' })).status, 403);
  assert.deepEqual(t.guilds.mcpReadChannels(G), []);
  assert.deepEqual(t.guilds.mcpPostChannels(G), []);

  const form = new URLSearchParams([
    ['_csrf', csrf],
    ['read', '400000000000000001'],
    ['read', '400000000000000003'],
    ['read', '400000000000000099'],
    ['post', '400000000000000001'],
    ['post', '400000000000000003'],
    ['post', '400000000000000099']
  ]);
  const saved = await t.request(path, {
    method: 'POST',
    headers: { cookie: session, origin: PUBLIC, 'content-type': 'application/x-www-form-urlencoded' },
    body: form
  });
  assert.equal(saved.status, 302);
  assert.deepEqual(t.guilds.mcpReadChannels(G), ['400000000000000001', '400000000000000003']);
  assert.deepEqual(t.guilds.mcpPostChannels(G), ['400000000000000001']);
  assert.equal(t.guilds.auditLog(G)[0].action, 'mcp.channels');
  assert.equal(t.guilds.auditLog(G)[0].detail, 'read: #general, #bug-reports; post: #general');
  const savedPage = await (await t.request(`/g/${G}/mcp`, { headers: { cookie: session } })).text();
  assert.match(savedPage, /name="read" value="400000000000000001"[^>]*checked/);
  assert.match(savedPage, /name="post" value="400000000000000001"[^>]*checked/);
});

test('/mcp skips the cookie session and CSRF checks but needs a token', async () => {
  const t = setup();
  const res = await t.request('/mcp', { method: 'POST', body: '{}' });
  assert.equal(res.status, 404);
});

test('the Devin key is checked, stored encrypted and only shown as a hint', async () => {
  const t = setup();
  const { session, csrf } = await signIn(t);
  const form = { _csrf: csrf, api_key: 'cog_live_secret_4f2a', org_id: 'org-1', repos: 'acme/app', user_map: '', instructions: '' };

  t.responses.set('GET /v3/self', { status: 401, body: {} });
  const rejected = await post(t, `/g/${G}/devin`, session, form);
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /rejected this API key/);
  assert.equal(t.guilds.isConfigured(G), false);

  t.responses.set('GET /v3/self', { status: 200, body: { principal_type: 'service_user', org_id: 'org-1' } });
  t.responses.set('GET /v3/organizations/org-1/sessions', { status: 200, body: { items: [] } });
  assert.equal((await post(t, `/g/${G}/devin`, session, form)).status, 302);
  assert.ok(t.calls.every((call) => call.method === 'GET'));
  assert.equal(t.guilds.isConfigured(G), true);
  assert.doesNotMatch(JSON.stringify(t.db.prepare('select * from guild_devin').all()), /cog_live/);
  assert.equal(t.secrets.decrypt(t.guilds.devin(G)!.apiKeyEncrypted, G), 'cog_live_secret_4f2a');

  const page = await (await t.request(`/g/${G}/devin`, { headers: { cookie: session } })).text();
  assert.match(page, /set, ends in …4f2a/);
  assert.doesNotMatch(page, /cog_live/);
  assert.doesNotMatch(JSON.stringify(t.guilds.auditLog(G)), /cog_live/);
});

test('dev login is only enabled with NODE_ENV=development and DEV_LOGIN_GUILD_ID', async () => {
  assert.equal(devLoginEnabled({ NODE_ENV: 'development', DEV_LOGIN_GUILD_ID: G }), true);
  assert.equal(devLoginEnabled({ NODE_ENV: 'production', DEV_LOGIN_GUILD_ID: G }), false);
  assert.equal(devLoginEnabled({ NODE_ENV: 'development' }), false);
  assert.equal(devLoginEnabled({ DEV_LOGIN_GUILD_ID: G }), false);
  const t = setup();
  const prod = createWebApp({
    publicUrl: PUBLIC,
    discordClientId: '1',
    discordClientSecret: 's',
    botPermissions: 1n,
    devinApiUrl: 'https://devin.test',
    secrets: t.secrets,
    guilds: t.guilds,
    sessions: new SessionStore(t.db),
    directory: { hasGuild: () => false, guildName: () => null, member: async () => null, roles: async () => [], channels: async () => [] }
  });
  assert.equal((await prod.request(`${PUBLIC}/auth/dev`)).status, 404);
});

test('the channels page saves the mention settings and rejects bad context counts', async () => {
  const t = setup();
  const { session, csrf } = await signIn(t);
  const path = `/g/${G}/channels`;
  const page = await (await t.request(path, { headers: { cookie: session } })).text();
  assert.match(page, /name="context_messages"[^>]*value="10"/);
  assert.match(page, /Only forward messages that @mention Devin/);
  assert.equal((await post(t, path, session, { _csrf: csrf, context_messages: '51' })).status, 400);
  assert.equal((await post(t, path, session, { _csrf: csrf, context_messages: '-1' })).status, 400);
  assert.equal(t.guilds.settings(G)?.contextMessages ?? 10, 10);
  const ok = await post(t, path, session, { _csrf: csrf, context_messages: '0', mention_only: 'on' });
  assert.equal(ok.status, 302);
  assert.equal(t.guilds.settings(G)?.contextMessages, 0);
  assert.equal(t.guilds.settings(G)?.mentionOnlyReplies, true);
  assert.match(t.guilds.auditLog(G)[0].detail, /context messages: 0; only @mentions forwarded: yes/);
});
