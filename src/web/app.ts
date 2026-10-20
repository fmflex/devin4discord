import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { randomToken, safeEqual, type Secrets } from '../crypto.ts';
import { verifyDevinCredentials } from '../devin.ts';
import { MAX_BODY_BYTES as MAX_MCP_BODY_BYTES, newMcpToken } from '../mcp.ts';
import type { Directory } from '../directory.ts';
import { DEFAULT_CONTEXT_MESSAGES, MAX_CONTEXT_MESSAGES, type Actor, type GuildStore } from '../guilds.ts';
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
import { SESSION_TTL_MS, type SessionStore, type WebSession } from './sessions.ts';
import {
  CSS,
  auditPage,
  channelsPage,
  devinPage,
  errorPage,
  landingPage,
  mcpPage,
  permissionsPage,
  pickerPage,
  type DevinForm,
  type PageOptions,
  type MentionSettings,
  type PickerRow
} from './views.ts';

export const SESSION_COOKIE = 'd4d_session';
export const STATE_COOKIE = 'd4d_oauth_state';
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
    if (!discordId || !devinId || extra || !/^\d{15,22}$/.test(discordId)) {
      throw new Error(`"${line}" should be a Discord user ID and a Devin user ID.`);
    }
    map[discordId] = devinId;
  }
  return map;
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

  app.get('/healthz', (c) => c.text('ok'));

  app.get('/auth/login', async (c) => {
    const state = randomToken();
    await setSignedCookie(c, STATE_COOKIE, state, secret, { ...COOKIE_OPTIONS, maxAge: 600 });
    return c.redirect(authorizeUrl({ clientId: deps.discordClientId, redirectUri, state }));
  });

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
      return c.html(errorPage(null, 'Sign-in cancelled', 'Discord did not complete the sign-in.'), 400);
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
    if (!session) return c.html(landingPage());
    const rows: PickerRow[] = [];
    for (const guild of session.guilds) {
      const row = {
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        configured: false,
        inviteUrl: inviteUrl(deps.discordClientId, deps.botPermissions, guild.id)
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
    return c.html(pickerPage(session, rows, inviteUrl(deps.discordClientId, deps.botPermissions)));
  });

  // Every /g/:guildId page: signed in, bot in the server, and the bot confirms the user may configure it.
  const guard: MiddlewareHandler<Env> = async (c, next) => {
    const session = c.get('session');
    if (!session) return c.redirect('/');
    const guildId = c.req.param('guildId') ?? '';
    if (!/^\d{15,22}$/.test(guildId) || !deps.directory.hasGuild(guildId)) {
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
      instructions: deps.guilds.settings(guildId)?.instructions ?? ''
    };
  }

  app.get('/g/:guildId/devin', (c) => {
    const { session, guild } = ctx(c);
    return c.html(devinPage(session, guild, devinForm(guild.id), noticeFrom(c)));
  });

  app.post('/g/:guildId/devin', async (c) => {
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
      instructions: field(form, 'instructions')
    };
    const fail = (text: string) =>
      c.html(devinPage(session, guild, submitted, { kind: 'error', text }), 400);
    try {
      if (!/^[\w-]{3,100}$/.test(orgId)) return fail('Enter the organization ID, like org-abc123.');
      if (!newKey && !existing) return fail('Enter the Devin API key.');
      const repos = parseRepos(submitted.repos);
      const userMap = parseUserMap(submitted.userMap);
      const apiKey = newKey || deps.secrets.decrypt(existing!.apiKeyEncrypted, guild.id);
      const changes: string[] = [];
      if (newKey || orgId !== existing?.orgId) {
        await verifyDevinCredentials({ apiKey, orgId, baseUrl: deps.devinApiUrl }, fetchImpl);
        if (newKey) changes.push(`key ending …${newKey.slice(-4)}`);
        if (orgId !== existing?.orgId) changes.push(`org ${orgId}`);
      }
      if (repos.join(',') !== (existing?.defaultRepos ?? []).join(',')) {
        changes.push(`repos: ${repos.join(', ') || 'none'}`);
      }
      if (JSON.stringify(userMap) !== JSON.stringify(existing?.userMap ?? {})) {
        changes.push(`${Object.keys(userMap).length} Devin user mappings`);
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
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    return c.redirect(`/g/${guild.id}/devin?saved=1`);
  });

  app.post('/g/:guildId/devin/remove', (c) => {
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
    return c.html(permissionsPage(session, guild, roles, deps.guilds.roleRules(guild.id), noticeFrom(c)));
  });

  app.post('/g/:guildId/permissions', async (c) => {
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
      return c.html(permissionsPage(session, guild, roles, [...before.values()], { kind: 'error', text }), 400);
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

  app.get('/g/:guildId/channels', async (c) => {
    const { session, guild } = ctx(c);
    const channels = await deps.directory.channels(guild.id);
    return c.html(
      channelsPage(
        session,
        guild,
        channels,
        deps.guilds.allowedChannels(guild.id),
        deps.guilds.settings(guild.id)?.taskChannelId ?? null,
        mentionSettings(deps.guilds, guild.id),
        noticeFrom(c)
      )
    );
  });

  app.post('/g/:guildId/channels', async (c) => {
    const { guild, actor } = ctx(c);
    const form = (await c.req.parseBody({ all: true })) as Form;
    const channels = await deps.directory.channels(guild.id);
    const names = new Map(channels.map((channel) => [channel.id, channel.name]));
    const allowed = fields(form, 'allowed').filter((id) => names.has(id));
    const taskChannel = field(form, 'task_channel');
    const taskChannelId = names.has(taskChannel) ? taskChannel : null;
    const contextRaw = field(form, 'context_messages');
    const contextMessages = contextRaw === '' ? DEFAULT_CONTEXT_MESSAGES : Number(contextRaw);
    if (!Number.isInteger(contextMessages) || contextMessages < 0 || contextMessages > MAX_CONTEXT_MESSAGES) {
      const text = `Context messages must be a whole number from 0 to ${MAX_CONTEXT_MESSAGES}.`;
      return c.html(
        channelsPage(ctx(c).session, guild, channels, allowed, taskChannelId, mentionSettings(deps.guilds, guild.id), { kind: 'error', text }),
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
      `allowed: ${allowed.map(label).join(', ') || 'all'}; task channel: ${taskChannelId ? label(taskChannelId) : 'source channel'}; context messages: ${contextMessages}; only @mentions forwarded: ${mentionOnlyReplies ? 'yes' : 'no'}`
    );
    return c.redirect(`/g/${guild.id}/channels?saved=1`);
  });

  const mcpUrl = `${deps.publicUrl}/mcp`;

  async function mcpChannelSettings(guildId: string) {
    return {
      channels: await deps.directory.channels(guildId),
      read: deps.guilds.mcpReadChannels(guildId),
      post: deps.guilds.mcpPostChannels(guildId),
      allowed: deps.guilds.allowedChannels(guildId)
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
        noticeFrom(c)
      )
    );
  });

  app.post('/g/:guildId/mcp/token', async (c) => {
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
        null
      )
    );
  });

  app.post('/g/:guildId/mcp/channels', async (c) => {
    const { guild, actor } = ctx(c);
    const form = (await c.req.parseBody({ all: true })) as Form;
    const { channels } = await mcpChannelSettings(guild.id);
    const names = new Map(channels.map((channel) => [channel.id, channel.name]));
    const postableIds = new Set(
      channels
        .filter((channel) => channel.kind === 'text' || channel.kind === 'announcement')
        .map((channel) => channel.id)
    );
    const readable = fields(form, 'read').filter((id) => names.has(id));
    const postable = fields(form, 'post').filter((id) => postableIds.has(id));
    deps.guilds.setMcpChannels(guild.id, readable, postable);
    const label = (id: string) => `#${names.get(id)}`;
    deps.guilds.audit(
      guild.id,
      actor,
      'mcp.channels',
      `read: ${readable.map(label).join(', ') || 'Channels tab'}; post: ${postable.map(label).join(', ') || 'none'}`
    );
    return c.redirect(`/g/${guild.id}/mcp?saved=1`);
  });

  app.post('/g/:guildId/mcp/remove', (c) => {
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
