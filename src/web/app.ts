import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { randomToken, safeEqual, type Secrets } from '../crypto.ts';
import { DEVIN_USER_ID, verifyDevinCredentials, verifyDevinOrgUser } from '../devin.ts';
import type { AdminStats } from '../admin.ts';
import { verifyGithubToken } from '../github.ts';
import { MAX_BODY_BYTES as MAX_MCP_BODY_BYTES, newMcpToken } from '../mcp.ts';
import type { Directory } from '../directory.ts';
import { DEFAULT_CONTEXT_MESSAGES, MAX_CONTEXT_MESSAGES, type Actor, type GuildStore, type McpMode } from '../guilds.ts';
import {
  ADMIN_DEFAULT,
  ADMIN_ROLE,
  PERMISSIONS,
  adminRule,
  canConfigure,
  sameRule,
  type Limits,
  type MemberSnapshot,
  type Permission,
  type RoleRule
} from '../permissions.ts';
import {
  authorizeUrl,
  canInvite,
  checkOAuthState,
  inviteUrl,
  signIn,
  type DiscordIdentity
} from './oauth.ts';
import { readFileSync } from 'node:fs';
import { docsPage } from './docs.ts';
import { SESSION_TTL_MS, type SessionStore, type WebSession } from './sessions.ts';
import { MAX_WEBHOOK_SECRET, webhookUrl } from '../webhooks.ts';
import {
  CSS,
  adminPage,
  auditPage,
  channelsPage,
  devinPage,
  errorPage,
  landingPage,
  MAX_CHANNEL_QUERY,
  mcpPage,
  permissionsPage,
  pickerPage,
  watchPage,
  MAX_WATCH_ACU,
  MAX_WATCH_COUNT,
  type DevinForm,
  type PageOptions,
  type MentionSettings,
  type PickerRow
} from './views.ts';

const ASSETS: Record<string, Uint8Array<ArrayBuffer>> = Object.fromEntries(
  ['logo.svg', 'logo.png', 'favicon.png', 'apple-touch-icon.png', 'avatar.png'].map((name) => [
    name,
    new Uint8Array(readFileSync(new URL(`./assets/${name}`, import.meta.url)))
  ])
);

/** Pages anyone can read, listed in the sitemap. */
const PUBLIC_PAGES = ['/', '/docs'];

export const SESSION_COOKIE = 'd4d_session';
export const STATE_COOKIE = 'd4d_oauth_state';
const SNOWFLAKE = /^\d{15,22}$/;
const GUILD_JOIN_WAIT_MS = 5000;
/** Every setup form is a few fields of text; anything bigger is rejected before it is read in full. */
export const MAX_FORM_BYTES = 64 * 1024;

export type WebDeps = {
  publicUrl: string;
  discordClientId: string;
  discordClientSecret: string;
  botPermissions: bigint;
  devinApiUrl: string;
  secrets: Secrets;
  guilds: GuildStore;
  sessions: SessionStore;
  directory: Directory;
  /** Used for Discord OAuth and the Devin key check. */
  fetch?: typeof fetch;
  /** The per-server MCP endpoint served at `/mcp`; see `createMcpHandler`. */
  mcp?: (request: Request) => Promise<Response>;
  /** The host admin page at `/admin`, for the Discord users in `userIds` only. */
  admin?: { userIds: string[]; stats: () => AdminStats };
  /** Development only: `/auth/dev` signs in as this identity without Discord. */
  devLogin?: DiscordIdentity;
};

type Env = {
  Variables: {
    session: WebSession | null;
    sessionId: string | null;
    guildId: string;
    guildName: string;
    member: MemberSnapshot;
  };
};

const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' } as const;

type Form = Record<string, string | File | (string | File)[]>;

function mentionSettings(guilds: GuildStore, guildId: string): MentionSettings {
  const settings = guilds.settings(guildId);
  return {
    contextMessages: settings?.contextMessages ?? DEFAULT_CONTEXT_MESSAGES,
    mentionOnlyReplies: settings?.mentionOnlyReplies ?? false
  };
}

function field(form: Form, name: string): string {
  const value = form[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first.trim() : '';
}

function fields(form: Form, name: string): string[] {
  const value = form[name];
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.filter((item): item is string => typeof item === 'string');
}

function noticeFrom(c: Context): PageOptions['notice'] {
  return c.req.query('saved') ? { kind: 'ok', text: 'Saved.' } : null;
}

function parseLimit(raw: string, min: number): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`Limits must be whole numbers of at least ${min}.`);
  return value;
}

function parseRepos(raw: string): string[] {
  const repos = raw.split(/[\s,]+/).filter(Boolean);
  for (const repo of repos) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" isn't an owner/repo name.`);
  }
  return [...new Set(repos)];
}

function parseUserMap(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [discordId, devinId, extra] = line.split(/[\s:,]+/);
    if (!discordId || !devinId || extra || !/^\d{15,22}$/.test(discordId) || !DEVIN_USER_ID.test(devinId)) {
      throw new Error(`"${line}" should be a Discord user ID and a Devin user ID (user-…).`);
    }
    if (discordId in map) throw new Error(`Discord user ${discordId} is listed more than once.`);
    map[discordId] = devinId;
  }
  return map;
}

/** Every added, changed and removed mapping, for the audit log. Empty when nothing changed. */
function userMapChanges(before: Record<string, string>, after: Record<string, string>): string[] {
  const changes: string[] = [];
  for (const [discordId, devinId] of Object.entries(after)) {
    const old = before[discordId];
    if (old === undefined) changes.push(`added ${discordId} → ${devinId}`);
    else if (old !== devinId) changes.push(`changed ${discordId}: ${old} → ${devinId}`);
  }
  for (const [discordId, devinId] of Object.entries(before)) {
    if (!(discordId in after)) changes.push(`removed ${discordId} → ${devinId}`);
  }
  return changes;
}

function describeRule(name: string, rule: RoleRule) {
  const limits = [
    rule.limits.maxAcu !== null ? `${rule.limits.maxAcu} ACU` : '',
    rule.limits.tasksPerDay !== null ? `${rule.limits.tasksPerDay}/day` : '',
    rule.limits.concurrentTasks !== null ? `${rule.limits.concurrentTasks} concurrent` : ''
  ].filter(Boolean);
  const perms = rule.permissions.length ? rule.permissions.join(', ') : 'none';
  return `${name}: ${perms}${limits.length ? ` (${limits.join(', ')})` : ''}`;
}

export function createWebApp(deps: WebDeps) {
  const app = new Hono<Env>();
  const fetchImpl = deps.fetch ?? fetch;
  const redirectUri = `${deps.publicUrl}/auth/callback`;
  const secret = deps.secrets.cookieSecret;
  const isHostAdmin = (session: WebSession | null) => Boolean(session && deps.admin?.userIds.includes(session.userId));

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'https://cdn.discordapp.com'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"]
      },
      referrerPolicy: 'same-origin'
    })
  );

  // Bearer-token API for Devin; registered before the cookie session and CSRF checks, which it doesn't use.
  app.on(
    ['GET', 'POST', 'DELETE'],
    '/mcp',
    bodyLimit({
      maxSize: MAX_MCP_BODY_BYTES,
      onError: (c) => c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large.' } }, 413)
    }),
    (c) => (deps.mcp ? deps.mcp(c.req.raw) : c.json({ error: 'MCP is not available.' }, 404))
  );

  app.use(async (c, next) => {
    c.set('session', null);
    c.set('sessionId', null);
    const id = await getSignedCookie(c, secret, SESSION_COOKIE);
    if (id) {
      const session = deps.sessions.get(id);
      if (session) {
        c.set('session', session);
        c.set('sessionId', id);
      }
    }
    await next();
  });

  // CSRF: every POST needs the session's token, and a same-origin Origin header when one is sent.
  // The session and Origin are checked before the body is read, and the body is size-capped before it is parsed.
  const rejectForm = (c: Context<Env>) =>
    c.html(errorPage(c.get('session'), 'Request rejected', 'The form expired or came from another site. Reload the page and try again.'), 403);
  const formLimit = bodyLimit({
    maxSize: MAX_FORM_BYTES,
    onError: (c) => c.html(errorPage(c.get('session'), 'Request too large', 'That form was too big to accept.'), 413)
  });
  app.use(async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const origin = c.req.header('origin');
    if (!c.get('session') || (origin && origin !== deps.publicUrl)) return rejectForm(c);
    return next();
  });
  app.use((c, next) => (c.req.method === 'POST' ? formLimit(c, next) : next()));
  app.use(async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const session = c.get('session');
    const form = (await c.req.parseBody({ all: true })) as Form;
    const token = field(form, '_csrf');
    if (!session || !token || !safeEqual(token, session.csrfToken)) return rejectForm(c);
    return next();
  });

  app.get('/assets/app.css', (c) => {
    c.header('Content-Type', 'text/css; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(CSS);
  });

  for (const [name, bytes] of Object.entries(ASSETS)) {
    app.get(`/assets/${name}`, (c) => {
      c.header('Content-Type', name.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
      c.header('Cache-Control', 'public, max-age=86400');
      return c.body(bytes);
    });
  }
  app.get('/favicon.ico', (c) => c.redirect('/assets/favicon.png', 301));

  app.get('/docs', (c) => c.html(docsPage(c.get('session'), deps.publicUrl)));

  app.get('/robots.txt', (c) => {
    c.header('Cache-Control', 'public, max-age=86400');
    return c.text(
      ['User-agent: *', 'Allow: /', 'Disallow: /auth/', 'Disallow: /g/', 'Disallow: /admin', 'Disallow: /mcp', '', `Sitemap: ${deps.publicUrl}/sitemap.xml`, ''].join('\n')
    );
  });

  app.get('/sitemap.xml', (c) => {
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    const urls = PUBLIC_PAGES.map((path) => `  <url><loc>${deps.publicUrl}${path}</loc></url>`);
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  });

  app.get('/healthz', (c) => c.text('ok'));

  async function beginOAuth(c: Context<Env>) {
    const state = randomToken();
    await setSignedCookie(c, STATE_COOKIE, state, secret, { ...COOKIE_OPTIONS, maxAge: 600 });
    return state;
  }

  app.get('/auth/login', async (c) => {
    const state = await beginOAuth(c);
    return c.redirect(authorizeUrl({ clientId: deps.discordClientId, redirectUri, state }));
  });

  app.get('/auth/invite', async (c) => {
    const guild = c.req.query('guild');
    const state = await beginOAuth(c);
    return c.redirect(
      inviteUrl({
        clientId: deps.discordClientId,
        permissions: deps.botPermissions,
        redirectUri,
        state,
        guildId: guild && SNOWFLAKE.test(guild) ? guild : undefined
      })
    );
  });

  // Discord adds the bot before redirecting, but the gateway's guild event can land a moment later.
  async function botJoined(guildId: string) {
    for (let waited = 0; waited < GUILD_JOIN_WAIT_MS; waited += 250) {
      if (deps.directory.hasGuild(guildId)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return deps.directory.hasGuild(guildId);
  }

  async function startSession(c: Context<Env>, identity: DiscordIdentity) {
    const old = c.get('sessionId');
    if (old) deps.sessions.delete(old);
    const id = deps.sessions.create(identity.user, identity.guilds);
    await setSignedCookie(c, SESSION_COOKIE, id, secret, {
      ...COOKIE_OPTIONS,
      maxAge: SESSION_TTL_MS / 1000
    });
  }

  app.get('/auth/callback', async (c) => {
    const expected = await getSignedCookie(c, secret, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, COOKIE_OPTIONS);
    if (!checkOAuthState(expected, c.req.query('state'))) {
      return c.html(errorPage(null, 'Sign-in failed', 'The sign-in link expired or was not started here. Try again.'), 400);
    }
    const code = c.req.query('code');
    if (!code) {
      return c.html(errorPage(c.get('session'), 'Cancelled', 'Discord did not finish. Nothing was changed.'), 400);
    }
    let identity: DiscordIdentity;
    try {
      identity = await signIn(fetchImpl, {
        clientId: deps.discordClientId,
        clientSecret: deps.discordClientSecret,
        code,
        redirectUri
      });
    } catch (error) {
      console.error('Discord sign-in failed:', error instanceof Error ? error.message : error);
      return c.html(errorPage(null, 'Sign-in failed', 'Discord rejected the sign-in. Try again.'), 502);
    }
    await startSession(c, identity);
    const added = c.req.query('guild_id');
    if (added && SNOWFLAKE.test(added) && identity.guilds.some((g) => g.id === added) && (await botJoined(added))) {
      return c.redirect(`/g/${added}/devin`);
    }
    return c.redirect('/');
  });

  if (deps.devLogin) {
    const identity = deps.devLogin;
    app.get('/auth/dev', async (c) => {
      await startSession(c, identity);
      return c.redirect('/');
    });
  }

  app.post('/auth/logout', (c) => {
    const id = c.get('sessionId');
    if (id) deps.sessions.delete(id);
    deleteCookie(c, SESSION_COOKIE, COOKIE_OPTIONS);
    return c.redirect('/');
  });

  app.get('/', async (c) => {
    const session = c.get('session');
    if (!session) return c.html(landingPage({ invite: '/auth/invite', publicUrl: deps.publicUrl }));
    const rows: PickerRow[] = [];
    for (const guild of session.guilds) {
      const row = {
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        configured: false,
        inviteUrl: `/auth/invite?guild=${guild.id}`
      };
      if (deps.directory.hasGuild(guild.id)) {
        const member = await deps.directory.member(guild.id, session.userId).catch(() => null);
        if (canConfigure(member, deps.guilds.roleRules(guild.id))) {
          rows.push({ ...row, action: 'configure', configured: deps.guilds.isConfigured(guild.id) });
        }
      } else if (canInvite(guild)) {
        rows.push({ ...row, action: 'invite' });
      }
    }
    rows.sort((a, b) => (a.action === b.action ? a.name.localeCompare(b.name) : a.action === 'configure' ? -1 : 1));
    return c.html(pickerPage(session, rows, '/auth/invite', isHostAdmin(session)));
  });

  // Host-wide stats across every server; anyone not on ADMIN_USER_IDS gets the same 404 as a missing page.
  app.get('/admin', (c) => {
    const session = c.get('session');
    if (!session) return c.redirect('/');
    if (!deps.admin || !isHostAdmin(session)) return c.html(errorPage(session, 'Not found', 'There is no page here.'), 404);
    c.header('Cache-Control', 'no-store');
    return c.html(adminPage(session, deps.admin.stats()));
  });

  // Every /g/:guildId page: signed in, bot in the server, and the bot confirms the user may configure it.
  const guard: MiddlewareHandler<Env> = async (c, next) => {
    const session = c.get('session');
    if (!session) return c.redirect('/');
    const guildId = c.req.param('guildId') ?? '';
    if (!SNOWFLAKE.test(guildId) || !deps.directory.hasGuild(guildId)) {
      return c.html(errorPage(session, 'Server not found', 'The bot is not in that server.'), 404);
    }
    const member = await deps.directory.member(guildId, session.userId);
    if (!canConfigure(member, deps.guilds.roleRules(guildId)) || !member) {
      return c.html(errorPage(session, 'Not allowed', "You can't configure this server."), 403);
    }
    const name = deps.directory.guildName(guildId) ?? guildId;
    deps.guilds.ensure(guildId, name);
    c.set('guildId', guildId);
    c.set('guildName', name);
    c.set('member', member);
    return next();
  };
  app.use('/g/:guildId', guard);
  app.use('/g/:guildId/*', guard);

  // Delegated `settings` holders may only change channels they can see. Anything that grants rights,
  // moves the Devin account or exposes channels through MCP is for Discord Administrators.
  const adminOnly: MiddlewareHandler<Env> = async (c, next) => {
    if (c.get('member').isAdmin) return next();
    return c.html(errorPage(c.get('session'), 'Not allowed', 'Only Discord Administrators can change this.'), 403);
  };

  const ctx = (c: Context<Env>) => ({
    session: c.get('session') as WebSession,
    guild: { id: c.get('guildId'), name: c.get('guildName') },
    actor: { id: c.get('member').id, name: c.get('member').name } satisfies Actor
  });

  app.get('/g/:guildId', (c) => c.redirect(`/g/${c.get('guildId')}/devin`));

  function devinForm(guildId: string): DevinForm {
    const devin = deps.guilds.devin(guildId);
    return {
      keyHint: devin?.apiKeyHint ?? null,
      orgId: devin?.orgId ?? '',
      repos: (devin?.defaultRepos ?? []).join('\n'),
      userMap: Object.entries(devin?.userMap ?? {})
        .map(([discordId, devinId]) => `${discordId} ${devinId}`)
        .join('\n'),
      instructions: deps.guilds.settings(guildId)?.instructions ?? '',
      github: githubForm(guildId)
    };
  }

  function githubForm(guildId: string) {
    const github = deps.guilds.github(guildId);
    return github ? { hint: github.tokenHint, login: github.login } : null;
  }

  app.get('/g/:guildId/devin', (c) => {
    const { session, guild } = ctx(c);
    return c.html(devinPage(session, guild, devinForm(guild.id), noticeFrom(c), c.get('member').isAdmin));
  });

  app.post('/g/:guildId/devin', adminOnly, async (c) => {
    const { session, guild, actor } = ctx(c);
    const form = (await c.req.parseBody({ all: true })) as Form;
    const existing = deps.guilds.devin(guild.id);
    const newKey = field(form, 'api_key');
    const orgId = field(form, 'org_id');
    const submitted: DevinForm = {
      keyHint: existing?.apiKeyHint ?? null,
      orgId,
      repos: field(form, 'repos'),
      userMap: field(form, 'user_map'),
      instructions: field(form, 'instructions'),
      github: githubForm(guild.id)
    };
    const fail = (text: string) => c.html(devinPage(session, guild, submitted, { kind: 'error', text }, true), 400);
    try {
      if (!/^[\w-]{3,100}$/.test(orgId)) return fail('Enter the organization ID, like org-abc123.');
      if (!newKey && !existing) return fail('Enter the Devin API key.');
      const repos = parseRepos(submitted.repos);
      const userMap = parseUserMap(submitted.userMap);
      const mapChanges = userMapChanges(existing?.userMap ?? {}, userMap);
      const apiKey = newKey || deps.secrets.decrypt(existing!.apiKeyEncrypted, guild.id);
      const credentialsChanged = Boolean(newKey) || orgId !== existing?.orgId;
      const changes: string[] = [];
      if (credentialsChanged) {
        await verifyDevinCredentials({ apiKey, orgId, baseUrl: deps.devinApiUrl }, fetchImpl);
        if (newKey) changes.push(`key ending …${newKey.slice(-4)}`);
        if (orgId !== existing?.orgId) changes.push(`org ${orgId}`);
      }
      if (mapChanges.length || credentialsChanged) {
        for (const userId of new Set(Object.values(userMap))) {
          await verifyDevinOrgUser({ apiKey, orgId, baseUrl: deps.devinApiUrl, userId }, fetchImpl);
        }
      }
      if (repos.join(',') !== (existing?.defaultRepos ?? []).join(',')) {
        changes.push(`repos: ${repos.join(', ') || 'none'}`);
      }
      deps.guilds.saveDevin(guild.id, {
        apiKeyEncrypted: newKey ? deps.secrets.encrypt(newKey, guild.id) : existing!.apiKeyEncrypted,
        apiKeyHint: newKey ? newKey.slice(-4) : existing!.apiKeyHint,
        orgId,
        defaultRepos: repos,
        userMap
      });
      if (submitted.instructions !== (deps.guilds.settings(guild.id)?.instructions ?? '')) {
        deps.guilds.setInstructions(guild.id, submitted.instructions);
        changes.push('instructions');
      }
      if (changes.length) deps.guilds.audit(guild.id, actor, 'devin.update', changes.join('; '));
      if (mapChanges.length) deps.guilds.audit(guild.id, actor, 'devin.user_map', mapChanges.join('; '));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    return c.redirect(`/g/${guild.id}/devin?saved=1`);
  });

  app.post('/g/:guildId/github', adminOnly, async (c) => {
    const { session, guild, actor } = ctx(c);
    const form = (await c.req.parseBody({ all: true })) as Form;
    const token = field(form, 'github_token');
    const fail = (text: string) =>
      c.html(devinPage(session, guild, devinForm(guild.id), { kind: 'error', text }, true), 400);
    if (!/^[\w-]{20,255}$/.test(token)) return fail('Enter a GitHub token, like github_pat_….');
    try {
      const { login } = await verifyGithubToken(token, fetchImpl);
      deps.guilds.saveGithub(guild.id, {
        tokenEncrypted: deps.secrets.encrypt(token, guild.id),
        tokenHint: token.slice(-4),
        login
      });
      deps.guilds.audit(guild.id, actor, 'github.update', `token ending …${token.slice(-4)} (${login})`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    return c.redirect(`/g/${guild.id}/devin?saved=1`);
  });

  app.post('/g/:guildId/github/remove', adminOnly, (c) => {
    const { guild, actor } = ctx(c);
    if (deps.guilds.github(guild.id)) {
      deps.guilds.clearGithub(guild.id);
      deps.guilds.audit(guild.id, actor, 'github.remove', 'GitHub token removed');
    }
    return c.redirect(`/g/${guild.id}/devin?saved=1`);
  });

  app.post('/g/:guildId/devin/remove', adminOnly, (c) => {
    const { guild, actor } = ctx(c);
    if (deps.guilds.devin(guild.id)) {
      deps.guilds.clearDevin(guild.id);
      deps.guilds.audit(guild.id, actor, 'devin.remove', 'API key removed');
    }
    return c.redirect(`/g/${guild.id}/devin?saved=1`);
  });

  async function assignableRoles(guildId: string) {
    const roles = await deps.directory.roles(guildId);
    return roles.filter((role) => !role.managed).sort((a, b) => b.position - a.position);
  }

  app.get('/g/:guildId/permissions', async (c) => {
    const { session, guild } = ctx(c);
    const roles = await assignableRoles(guild.id);
    return c.html(permissionsPage(session, guild, roles, deps.guilds.roleRules(guild.id), noticeFrom(c), c.get('member').isAdmin));
  });

  app.post('/g/:guildId/permissions', adminOnly, async (c) => {
    const { session, guild, actor } = ctx(c);
    const form = (await c.req.parseBody({ all: true })) as Form;
    const roles = await assignableRoles(guild.id);
    const before = new Map(deps.guilds.roleRules(guild.id).map((rule) => [rule.roleId, rule]));
    const rules: RoleRule[] = [];
    let admin = ADMIN_DEFAULT;
    try {
      admin = {
        roleId: ADMIN_ROLE,
        permissions: PERMISSIONS.filter((p) => p === 'settings' || fields(form, `p_${ADMIN_ROLE}`).includes(p)),
        limits: {
          maxAcu: parseLimit(field(form, `acu_${ADMIN_ROLE}`), 1),
          tasksPerDay: parseLimit(field(form, `day_${ADMIN_ROLE}`), 0),
          concurrentTasks: parseLimit(field(form, `conc_${ADMIN_ROLE}`), 0)
        }
      };
      for (const role of roles) {
        const permissions = PERMISSIONS.filter((p: Permission) => fields(form, `p_${role.id}`).includes(p));
        const limits: Limits = {
          maxAcu: parseLimit(field(form, `acu_${role.id}`), 1),
          tasksPerDay: parseLimit(field(form, `day_${role.id}`), 0),
          concurrentTasks: parseLimit(field(form, `conc_${role.id}`), 0)
        };
        rules.push({ roleId: role.id, permissions, limits });
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return c.html(permissionsPage(session, guild, roles, [...before.values()], { kind: 'error', text }, true), 400);
    }
    const changed = rules
      .map((rule) => {
        const old = before.get(rule.roleId);
        const empty = !rule.permissions.length;
        if (!old && empty) return null;
        if (old && sameRule(old, rule)) return null;
        const name = roles.find((role) => role.id === rule.roleId)?.name ?? rule.roleId;
        return describeRule(name, rule);
      })
      .filter(Boolean);
    if (!sameRule(adminRule([...before.values()]), admin)) changed.unshift(describeRule('Administrator', admin));
    // The default Administrator rule isn't stored, so it keeps following ADMIN_DEFAULT.
    deps.guilds.setRoleRules(guild.id, sameRule(admin, ADMIN_DEFAULT) ? rules : [...rules, admin]);
    if (changed.length) deps.guilds.audit(guild.id, actor, 'permissions.update', changed.join('; '));
    return c.redirect(`/g/${guild.id}/permissions?saved=1`);
  });

  function channelQuery(c: Context<Env>) {
    return (c.req.query('q') ?? '').trim().slice(0, MAX_CHANNEL_QUERY);
  }

  /** After a filtered save, only the channels that were shown may change; null means all of them. */
  function listScope(form: Form): Set<string> | null {
    return field(form, 'scoped') ? new Set(fields(form, 'shown')) : null;
  }

  function savedRedirect(path: string, form: Form) {
    const query = field(form, 'q').slice(0, MAX_CHANNEL_QUERY);
    return `${path}?saved=1${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  }

  /** Channel IDs this member may change on the Channels tab; null means all of them. */
  async function editableChannels(c: Context<Env>): Promise<Set<string> | null> {
    const member = c.get('member');
    if (member.isAdmin) return null;
    return new Set(await deps.directory.visibleChannels(c.get('guildId'), member.id));
  }

  app.get('/g/:guildId/channels', async (c) => {
    const { session, guild } = ctx(c);
    const channels = await deps.directory.channels(guild.id);
    const editable = await editableChannels(c);
    return c.html(
      channelsPage(
        session,
        guild,
        channels,
        deps.guilds.allowedChannels(guild.id),
        deps.guilds.settings(guild.id)?.taskChannelId ?? null,
        mentionSettings(deps.guilds, guild.id),
        noticeFrom(c),
        editable,
        channelQuery(c)
      )
    );
  });

  app.post('/g/:guildId/channels', async (c) => {
    const { guild, actor } = ctx(c);
    const form = (await c.req.parseBody({ all: true })) as Form;
    const channels = await deps.directory.channels(guild.id);
    const names = new Map(channels.map((channel) => [channel.id, channel.name]));
    // Members who aren't Administrators can't add or remove channels Discord hides from them,
    // since the Allowed list is also the MCP read list's fallback.
    const editable = await editableChannels(c);
    const scope = listScope(form);
    const canEdit = (id: string) => !editable || editable.has(id);
    const changeable = (id: string) => canEdit(id) && (!scope || scope.has(id));
    const before = deps.guilds.allowedChannels(guild.id);
    const submitted = fields(form, 'allowed').filter((id) => names.has(id) && (!scope || scope.has(id)));
    const ignored = new Set(submitted.filter((id) => !canEdit(id) && !before.includes(id)));
    const allowed = [
      ...new Set([...submitted.filter(changeable), ...before.filter((id) => names.has(id) && !changeable(id))])
    ];
    const currentTaskChannel = deps.guilds.settings(guild.id)?.taskChannelId ?? null;
    const taskChannel = field(form, 'task_channel');
    let taskChannelId = names.has(taskChannel) ? taskChannel : null;
    // A disabled radio isn't submitted, so a missing field keeps the current task channel.
    if (!fields(form, 'task_channel').length) taskChannelId = currentTaskChannel;
    if (taskChannelId && taskChannelId !== currentTaskChannel && !canEdit(taskChannelId)) {
      ignored.add(taskChannelId);
      taskChannelId = currentTaskChannel;
    }
    const contextRaw = field(form, 'context_messages');
    const contextMessages = contextRaw === '' ? DEFAULT_CONTEXT_MESSAGES : Number(contextRaw);
    if (!Number.isInteger(contextMessages) || contextMessages < 0 || contextMessages > MAX_CONTEXT_MESSAGES) {
      const text = `Context messages must be a whole number from 0 to ${MAX_CONTEXT_MESSAGES}.`;
      return c.html(
        channelsPage(ctx(c).session, guild, channels, allowed, taskChannelId, mentionSettings(deps.guilds, guild.id), { kind: 'error', text }, editable, field(form, 'q').slice(0, MAX_CHANNEL_QUERY)),
        400
      );
    }
    const mentionOnlyReplies = field(form, 'mention_only') === 'on';
    deps.guilds.setChannels(guild.id, allowed, taskChannelId);
    deps.guilds.setMentionSettings(guild.id, contextMessages, mentionOnlyReplies);
    const label = (id: string) => `#${names.get(id)}`;
    deps.guilds.audit(
      guild.id,
      actor,
      'channels.update',
      `allowed: ${allowed.map(label).join(', ') || 'all'}; task channel: ${taskChannelId ? label(taskChannelId) : 'source channel'}; context messages: ${contextMessages}; only @mentions forwarded: ${mentionOnlyReplies ? 'yes' : 'no'}` +
        (ignored.size ? `; ignored channels the editor can't view: ${[...ignored].map(label).join(', ')}` : '')
    );
    return c.redirect(savedRedirect(`/g/${guild.id}/channels`, form));
  });

  function webhookView(guildId: string) {
    const webhook = deps.guilds.webhook(guildId);
    return webhook
      ? {
          hint: webhook.urlHint,
          hasSecret: webhook.secretEncrypted !== null,
          includeThreads: webhook.includeThreads,
          includeBots: webhook.includeBots
        }
      : null;
  }

  async function renderWatch(c: Context<Env>, notice: PageOptions['notice'], query = channelQuery(c)) {
    const { session, guild } = ctx(c);
    return watchPage(
      session,
      guild,
      await deps.directory.channels(guild.id),
      deps.guilds.watchChannels(guild.id),
      deps.guilds.watchLimits(guild.id),
      webhookView(guild.id),
      notice,
      c.get('member').isAdmin,
      query
    );
  }

  app.get('/g/:guildId/watch', async (c) => c.html(await renderWatch(c, noticeFrom(c))));

  // Auto-start spends ACUs on any member's message and the webhook sends channel text off Discord,
  // so both are for Discord Administrators.
  app.post('/g/:guildId/watch/channels', adminOnly, async (c) => {
    const { guild, actor } = ctx(c);
    const form = (await c.req.parseBody({ all: true })) as Form;
    const channels = await deps.directory.channels(guild.id);
    const names = new Map(channels.map((channel) => [channel.id, channel.name]));
    const scope = listScope(form);
    const inScope = (id: string) => names.has(id) && (!scope || scope.has(id));
    const before = new Map(deps.guilds.watchChannels(guild.id).map((entry) => [entry.channelId, entry]));
    const limit = (name: string, max: number) => {
      const value = Number(field(form, name));
      return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
    };
    const limits = {
      maxAcu: limit('max_acu', MAX_WATCH_ACU),
      tasksPerDay: limit('tasks_per_day', MAX_WATCH_COUNT),
      concurrentTasks: limit('concurrent_tasks', MAX_WATCH_COUNT)
    };
    if (limits.maxAcu === null || limits.tasksPerDay === null || limits.concurrentTasks === null) {
      const text = `Limits must be whole numbers: ACU per task 1–${MAX_WATCH_ACU}, tasks 1–${MAX_WATCH_COUNT}.`;
      return c.html(await renderWatch(c, { kind: 'error', text }, field(form, 'q').slice(0, MAX_CHANNEL_QUERY)), 400);
    }
    const autoStart = new Set(fields(form, 'auto_start').filter(inScope));
    const anyone = new Set(fields(form, 'anyone').filter(inScope));
    const webhook = new Set(fields(form, 'webhook').filter(inScope));
    const watch = channels.map((channel) => {
      const old = before.get(channel.id);
      return inScope(channel.id)
        ? {
            channelId: channel.id,
            autoStart: autoStart.has(channel.id),
            webhook: webhook.has(channel.id),
            anyone: autoStart.has(channel.id) && anyone.has(channel.id)
          }
        : { channelId: channel.id, autoStart: old?.autoStart ?? false, webhook: old?.webhook ?? false, anyone: old?.anyone ?? false };
    });
    deps.guilds.setWatchChannels(guild.id, watch);
    deps.guilds.setWatchLimits(guild.id, { maxAcu: limits.maxAcu, tasksPerDay: limits.tasksPerDay, concurrentTasks: limits.concurrentTasks });
    const label = (id: string) => `#${names.get(id)}`;
    const list = (key: 'autoStart' | 'webhook' | 'anyone') =>
      watch.filter((entry) => entry[key]).map((entry) => label(entry.channelId)).join(', ') || 'none';
    deps.guilds.audit(
      guild.id,
      actor,
      'watch.channels',
      `auto-start: ${list('autoStart')}; anyone: ${list('anyone')}; webhook: ${list('webhook')}; anyone limits: ${limits.maxAcu} ACU, ${limits.tasksPerDay}/day, ${limits.concurrentTasks} at once`
    );
    return c.redirect(savedRedirect(`/g/${guild.id}/watch`, form));
  });

  app.post('/g/:guildId/watch/webhook', adminOnly, async (c) => {
    const { guild, actor } = ctx(c);
    const form = (await c.req.parseBody({ all: true })) as Form;
    const current = deps.guilds.webhook(guild.id);
    const rawUrl = field(form, 'url').trim();
    const secret = field(form, 'secret').trim();
    const fail = async (text: string) => c.html(await renderWatch(c, { kind: 'error', text }, ''), 400);
    if (!rawUrl && !current) return fail('Enter the webhook URL.');
    let urlEncrypted = current?.urlEncrypted ?? '';
    let urlHint = current?.urlHint ?? '';
    if (rawUrl) {
      let url: URL;
      try {
        url = webhookUrl(rawUrl);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      urlEncrypted = deps.secrets.encrypt(url.href, guild.id);
      urlHint = url.host;
    }
    if (secret.length > MAX_WEBHOOK_SECRET) return fail(`The secret can be at most ${MAX_WEBHOOK_SECRET} characters.`);
    const includeThreads = field(form, 'include_threads') === 'on';
    const includeBots = field(form, 'include_bots') === 'on';
    deps.guilds.saveWebhook(guild.id, {
      urlEncrypted,
      urlHint,
      secretEncrypted: secret ? deps.secrets.encrypt(secret, guild.id) : current?.secretEncrypted ?? null,
      includeThreads,
      includeBots
    });
    deps.guilds.audit(
      guild.id,
      actor,
      'webhook.update',
      `host: ${urlHint}${rawUrl ? ' (URL changed)' : ''}; secret: ${secret ? 'changed' : current?.secretEncrypted ? 'kept' : 'none'}; threads: ${includeThreads ? 'yes' : 'no'}; bots: ${includeBots ? 'yes' : 'no'}`
    );
    return c.redirect(`/g/${guild.id}/watch?saved=1`);
  });

  app.post('/g/:guildId/watch/webhook/remove', adminOnly, (c) => {
    const { guild, actor } = ctx(c);
    const current = deps.guilds.webhook(guild.id);
    if (current) {
      deps.guilds.clearWebhook(guild.id);
      deps.guilds.audit(guild.id, actor, 'webhook.remove', `host: ${current.urlHint}`);
    }
    return c.redirect(`/g/${guild.id}/watch?saved=1`);
  });

  const mcpUrl = `${deps.publicUrl}/mcp`;

  async function mcpChannelSettings(guildId: string) {
    return {
      channels: await deps.directory.channels(guildId),
      read: deps.guilds.mcpReadChannels(guildId),
      post: deps.guilds.mcpPostChannels(guildId),
      allowed: deps.guilds.allowedChannels(guildId),
      modes: deps.guilds.mcpModes(guildId)
    };
  }

  app.get('/g/:guildId/mcp', async (c) => {
    const { session, guild } = ctx(c);
    const settings = await mcpChannelSettings(guild.id);
    return c.html(
      mcpPage(
        session,
        guild,
        mcpUrl,
        settings,
        deps.guilds.mcpToken(guild.id),
        null,
        noticeFrom(c),
        c.get('member').isAdmin,
        channelQuery(c)
      )
    );
  });

  app.post('/g/:guildId/mcp/token', adminOnly, async (c) => {
    const { session, guild, actor } = ctx(c);
    const rotated = Boolean(deps.guilds.mcpToken(guild.id));
    const { token, hash, hint } = newMcpToken();
    deps.guilds.setMcpToken(guild.id, hash, hint);
    deps.guilds.audit(guild.id, actor, 'mcp.token', `${rotated ? 'rotated' : 'created'}, ends in …${hint}`);
    c.header('Cache-Control', 'no-store');
    const settings = await mcpChannelSettings(guild.id);
    return c.html(
      mcpPage(
        session,
        guild,
        mcpUrl,
        settings,
        deps.guilds.mcpToken(guild.id),
        token,
        null,
        true
      )
    );
  });

  app.post('/g/:guildId/mcp/channels', adminOnly, async (c) => {
    const { guild, actor } = ctx(c);
    const form = (await c.req.parseBody({ all: true })) as Form;
    const { channels } = await mcpChannelSettings(guild.id);
    const names = new Map(channels.map((channel) => [channel.id, channel.name]));
    const scope = listScope(form);
    const changed = (name: string, before: string[]) => {
      const inScope = (id: string) => names.has(id) && (!scope || scope.has(id));
      return [...new Set([...before.filter((id) => names.has(id) && !inScope(id)), ...fields(form, name).filter(inScope)])];
    };
    const readable = changed('read', deps.guilds.mcpReadChannels(guild.id));
    const postable = changed('post', deps.guilds.mcpPostChannels(guild.id));
    const mode = (name: string): McpMode => (field(form, name) === 'bot' ? 'bot' : 'custom');
    const modes = { read: mode('read_mode'), post: mode('post_mode') };
    deps.guilds.setMcpChannels(guild.id, readable, postable, modes);
    const label = (id: string) => `#${names.get(id)}`;
    const BOT_SCOPE = "wherever the bot's Discord permissions allow";
    deps.guilds.audit(
      guild.id,
      actor,
      'mcp.channels',
      `read: ${modes.read === 'bot' ? BOT_SCOPE : readable.map(label).join(', ') || 'Channels tab'}; post: ${modes.post === 'bot' ? BOT_SCOPE : postable.map(label).join(', ') || 'none'}`
    );
    return c.redirect(savedRedirect(`/g/${guild.id}/mcp`, form));
  });

  app.post('/g/:guildId/mcp/remove', adminOnly, (c) => {
    const { guild, actor } = ctx(c);
    if (deps.guilds.mcpToken(guild.id)) {
      deps.guilds.clearMcpToken(guild.id);
      deps.guilds.audit(guild.id, actor, 'mcp.remove', 'MCP token revoked');
    }
    return c.redirect(`/g/${guild.id}/mcp?saved=1`);
  });

  app.get('/g/:guildId/audit', (c) => {
    const { session, guild } = ctx(c);
    return c.html(auditPage(session, guild, deps.guilds.auditLog(guild.id)));
  });

  app.onError((error, c) => {
    console.error('Web request failed:', error);
    return c.html(errorPage(c.get('session') ?? null, 'Something went wrong', 'Try again in a moment.'), 500);
  });

  return app;
}
