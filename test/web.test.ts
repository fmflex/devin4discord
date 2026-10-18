import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Secrets } from '../src/crypto.ts';
import { openDatabase } from '../src/db.ts';
import { devFixtures, devLoginEnabled } from '../src/dev-web.ts';
import type { Directory } from '../src/directory.ts';
import { GuildStore } from '../src/guilds.ts';
import type { MemberSnapshot } from '../src/permissions.ts';
import { SESSION_COOKIE, STATE_COOKIE, createWebApp } from '../src/web/app.ts';
import { checkOAuthState } from '../src/web/oauth.ts';
import { SessionStore } from '../src/web/sessions.ts';

const PUBLIC = 'https://devin.example.com';
const G = '900000000000000001';
const USER = '100000000000000001';
const SETTINGS_ROLE = '300000000000000009';

type Call = { url: string; method: string };

function setup(memberOf: MemberSnapshot | null = { id: USER, name: 'Dev', roleIds: [G], isAdmin: true, canManageGuild: true }) {
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
    channels: async () => [{ id: '400000000000000001', name: 'general', kind: 'text', category: null, position: 0 }]
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
    devLogin: { ...identity, guilds: [{ ...identity.guilds[0], id: G }] }
  });
  const request = (path: string, init: RequestInit = {}) => app.request(`${PUBLIC}${path}`, init);
  return { app, db, guilds, secrets, calls, responses, state, request };
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
