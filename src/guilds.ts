import type { DatabaseSync } from 'node:sqlite';
import { PERMISSIONS, type Limits, type Permission, type RoleRule } from './permissions.ts';

export type GuildSettings = {
  guildId: string;
  name: string;
  /** Where task threads open; the source channel when null. */
  taskChannelId: string | null;
  /** Appended to every task prompt; a default is used when empty. */
  instructions: string;
  /** Recent channel messages sent with an @mention as untrusted context. */
  contextMessages: number;
  /** In task threads, only forward messages that @mention the bot. */
  mentionOnlyReplies: boolean;
};

export const DEFAULT_CONTEXT_MESSAGES = 10;
export const MAX_CONTEXT_MESSAGES = 50;

export type DevinSettings = {
  /** AES-256-GCM ciphertext from `Secrets.encrypt`, bound to the guild ID. */
  apiKeyEncrypted: string;
  /** The key's last four characters, shown in the UI. */
  apiKeyHint: string;
  orgId: string;
  defaultRepos: string[];
  /** Discord user ID -> Devin user ID, so those users' tasks run as them. */
  userMap: Record<string, string>;
  updatedAt: number;
};

/** The GitHub token `/devin merge` uses. */
export type GithubSettings = {
  /** AES-256-GCM ciphertext from `Secrets.encrypt`, bound to the guild ID. */
  tokenEncrypted: string;
  /** The token's last four characters, shown in the UI. */
  tokenHint: string;
  /** The GitHub account the token belongs to. */
  login: string;
  updatedAt: number;
};

/** Where MCP may read or post: the ticked lists, or anywhere the bot's own Discord permissions allow. */
export type McpMode = 'custom' | 'bot';
export type McpModes = { read: McpMode; post: McpMode };

/** A channel the bot watches: new messages there start tasks, go to the server's webhook, or both. */
export type WatchChannel = {
  channelId: string;
  autoStart: boolean;
  webhook: boolean;
  /** With auto-start: members without Start tasks may start tasks here too, within `watchLimits`. */
  anyone: boolean;
};

export const DEFAULT_WATCH_LIMITS = { maxAcu: 5, tasksPerDay: 3, concurrentTasks: 1 } as const;

export type WebhookSettings = {
  /** AES-256-GCM ciphertext of the URL, bound to the guild ID (URLs often carry a token). */
  urlEncrypted: string;
  /** The URL's host, shown in the UI and the audit log. */
  urlHint: string;
  /** Sent as `X-Webhook-Secret`; null sends none. */
  secretEncrypted: string | null;
  /** Also send messages in threads under a watched channel. */
  includeThreads: boolean;
  /** Also send messages from other bots and Discord webhooks (never the bot's own). */
  includeBots: boolean;
  updatedAt: number;
};

export type AuditEntry = {
  id: number;
  actorId: string;
  actorName: string;
  action: string;
  detail: string;
  createdAt: number;
};

export type Actor = { id: string; name: string };

type RoleRaw = {
  role_id: string;
  start_tasks: number;
  reply: number;
  manage_tasks: number;
  merge_prs: number;
  settings: number;
  max_acu: number | null;
  tasks_per_day: number | null;
  concurrent_tasks: number | null;
};

/** Per-server configuration set through the web UI. */
export class GuildStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Creates the server's row if missing and refreshes its name. */
  ensure(guildId: string, name?: string) {
    const now = Date.now();
    this.db
      .prepare(
        `insert into guilds (guild_id, name, created_at, updated_at) values (?, ?, ?, ?)
         on conflict (guild_id) do update set name = coalesce(nullif(excluded.name, ''), name)`
      )
      .run(guildId, name ?? '', now, now);
  }

  settings(guildId: string): GuildSettings | null {
    const raw = this.db
      .prepare(
        'select guild_id, name, task_channel_id, instructions, context_messages, mention_only_replies from guilds where guild_id = ?'
      )
      .get(guildId) as
      | {
          guild_id: string;
          name: string;
          task_channel_id: string | null;
          instructions: string;
          context_messages: number;
          mention_only_replies: number;
        }
      | undefined;
    return raw
      ? {
          guildId: raw.guild_id,
          name: raw.name,
          taskChannelId: raw.task_channel_id,
          instructions: raw.instructions,
          contextMessages: raw.context_messages,
          mentionOnlyReplies: raw.mention_only_replies === 1
        }
      : null;
  }

  /** Configured means a Devin key and org ID are saved. */
  isConfigured(guildId: string) {
    return this.devin(guildId) !== null;
  }

  devin(guildId: string): DevinSettings | null {
    const raw = this.db.prepare('select * from guild_devin where guild_id = ?').get(guildId) as
      | {
          api_key_encrypted: string;
          api_key_hint: string;
          org_id: string;
          default_repos: string;
          user_map: string;
          updated_at: number;
        }
      | undefined;
    return raw
      ? {
          apiKeyEncrypted: raw.api_key_encrypted,
          apiKeyHint: raw.api_key_hint,
          orgId: raw.org_id,
          defaultRepos: JSON.parse(raw.default_repos) as string[],
          userMap: JSON.parse(raw.user_map) as Record<string, string>,
          updatedAt: raw.updated_at
        }
      : null;
  }

  saveDevin(guildId: string, devin: Omit<DevinSettings, 'updatedAt'>) {
    this.ensure(guildId);
    this.db
      .prepare(
        `insert into guild_devin (guild_id, api_key_encrypted, api_key_hint, org_id, default_repos, user_map, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict (guild_id) do update set
           api_key_encrypted = excluded.api_key_encrypted,
           api_key_hint = excluded.api_key_hint,
           org_id = excluded.org_id,
           default_repos = excluded.default_repos,
           user_map = excluded.user_map,
           updated_at = excluded.updated_at`
      )
      .run(
        guildId,
        devin.apiKeyEncrypted,
        devin.apiKeyHint,
        devin.orgId,
        JSON.stringify(devin.defaultRepos),
        JSON.stringify(devin.userMap),
        Date.now()
      );
  }

  /** Links (or with null, unlinks) a Discord member to a Devin user, so their tasks run as them. */
  setUserLink(guildId: string, discordId: string, devinUserId: string | null) {
    const devin = this.devin(guildId);
    if (!devin) return;
    const userMap = { ...devin.userMap };
    if (devinUserId) userMap[discordId] = devinUserId;
    else delete userMap[discordId];
    // updated_at changes too, so the cached Devin client picks up the new map.
    this.db
      .prepare('update guild_devin set user_map = ?, updated_at = ? where guild_id = ?')
      .run(JSON.stringify(userMap), Math.max(Date.now(), devin.updatedAt + 1), guildId);
  }

  clearDevin(guildId: string) {
    this.db.prepare('delete from guild_devin where guild_id = ?').run(guildId);
  }

  github(guildId: string): GithubSettings | null {
    const raw = this.db.prepare('select * from guild_github where guild_id = ?').get(guildId) as
      | { token_encrypted: string; token_hint: string; login: string; updated_at: number }
      | undefined;
    return raw
      ? { tokenEncrypted: raw.token_encrypted, tokenHint: raw.token_hint, login: raw.login, updatedAt: raw.updated_at }
      : null;
  }

  saveGithub(guildId: string, github: Omit<GithubSettings, 'updatedAt'>) {
    this.ensure(guildId);
    this.db
      .prepare(
        `insert into guild_github (guild_id, token_encrypted, token_hint, login, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict (guild_id) do update set
           token_encrypted = excluded.token_encrypted,
           token_hint = excluded.token_hint,
           login = excluded.login,
           updated_at = excluded.updated_at`
      )
      .run(guildId, github.tokenEncrypted, github.tokenHint, github.login, Date.now());
  }

  clearGithub(guildId: string) {
    this.db.prepare('delete from guild_github where guild_id = ?').run(guildId);
  }

  setInstructions(guildId: string, instructions: string) {
    this.ensure(guildId);
    this.db
      .prepare('update guilds set instructions = ?, updated_at = ? where guild_id = ?')
      .run(instructions, Date.now(), guildId);
  }

  roleRules(guildId: string): RoleRule[] {
    const rows = this.db
      .prepare('select * from guild_roles where guild_id = ?')
      .all(guildId) as RoleRaw[];
    return rows.map((row) => ({
      roleId: row.role_id,
      permissions: PERMISSIONS.filter((permission) => row[permission] === 1),
      limits: {
        maxAcu: row.max_acu,
        tasksPerDay: row.tasks_per_day,
        concurrentTasks: row.concurrent_tasks
      }
    }));
  }

  /** Replaces every role rule. Roles without permissions are not stored. */
  setRoleRules(guildId: string, rules: RoleRule[]) {
    this.ensure(guildId);
    const insert = this.db.prepare(
      `insert into guild_roles (guild_id, role_id, start_tasks, reply, manage_tasks, merge_prs, settings, max_acu, tasks_per_day, concurrent_tasks)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const has = (rule: RoleRule, permission: Permission) =>
      rule.permissions.includes(permission) ? 1 : 0;
    this.transaction(() => {
      this.db.prepare('delete from guild_roles where guild_id = ?').run(guildId);
      for (const rule of rules) {
        if (!rule.permissions.length) continue;
        const limits: Limits = rule.limits;
        insert.run(
          guildId,
          rule.roleId,
          has(rule, 'start_tasks'),
          has(rule, 'reply'),
          has(rule, 'manage_tasks'),
          has(rule, 'merge_prs'),
          has(rule, 'settings'),
          limits.maxAcu,
          limits.tasksPerDay,
          limits.concurrentTasks
        );
      }
    });
  }

  /** Channels where triggers work; empty means every channel. */
  allowedChannels(guildId: string): string[] {
    return (
      this.db
        .prepare('select channel_id from guild_channels where guild_id = ? order by channel_id')
        .all(guildId) as { channel_id: string }[]
    ).map((row) => row.channel_id);
  }

  setChannels(guildId: string, allowed: string[], taskChannelId: string | null) {
    this.ensure(guildId);
    const insert = this.db.prepare(
      'insert or ignore into guild_channels (guild_id, channel_id) values (?, ?)'
    );
    this.transaction(() => {
      this.db.prepare('delete from guild_channels where guild_id = ?').run(guildId);
      for (const channelId of allowed) insert.run(guildId, channelId);
      this.db
        .prepare('update guilds set task_channel_id = ?, updated_at = ? where guild_id = ?')
        .run(taskChannelId, Date.now(), guildId);
    });
  }

  /** Channels Devin may read through MCP; empty means follow the Channels tab. */
  mcpReadChannels(guildId: string): string[] {
    return (
      this.db
        .prepare('select channel_id from guild_mcp_read_channels where guild_id = ? order by channel_id')
        .all(guildId) as { channel_id: string }[]
    ).map((row) => row.channel_id);
  }

  /** Channels Devin may post in through MCP; empty means none. */
  mcpPostChannels(guildId: string): string[] {
    return (
      this.db
        .prepare('select channel_id from guild_mcp_post_channels where guild_id = ? order by channel_id')
        .all(guildId) as { channel_id: string }[]
    ).map((row) => row.channel_id);
  }

  mcpModes(guildId: string): McpModes {
    const row = this.db
      .prepare('select mcp_read_mode, mcp_post_mode from guilds where guild_id = ?')
      .get(guildId) as { mcp_read_mode: string; mcp_post_mode: string } | undefined;
    return {
      read: row?.mcp_read_mode === 'bot' ? 'bot' : 'custom',
      post: row?.mcp_post_mode === 'bot' ? 'bot' : 'custom'
    };
  }

  setMcpChannels(
    guildId: string,
    read: string[],
    post: string[],
    modes: McpModes = { read: 'custom', post: 'custom' }
  ) {
    this.ensure(guildId);
    const insertRead = this.db.prepare(
      'insert or ignore into guild_mcp_read_channels (guild_id, channel_id) values (?, ?)'
    );
    const insertPost = this.db.prepare(
      'insert or ignore into guild_mcp_post_channels (guild_id, channel_id) values (?, ?)'
    );
    this.transaction(() => {
      this.db.prepare('delete from guild_mcp_read_channels where guild_id = ?').run(guildId);
      this.db.prepare('delete from guild_mcp_post_channels where guild_id = ?').run(guildId);
      for (const channelId of read) insertRead.run(guildId, channelId);
      for (const channelId of post) insertPost.run(guildId, channelId);
      this.db
        .prepare('update guilds set mcp_read_mode = ?, mcp_post_mode = ?, updated_at = ? where guild_id = ?')
        .run(modes.read, modes.post, Date.now(), guildId);
    });
  }

  setMentionSettings(guildId: string, contextMessages: number, mentionOnlyReplies: boolean) {
    this.ensure(guildId);
    this.db
      .prepare(
        'update guilds set context_messages = ?, mention_only_replies = ?, updated_at = ? where guild_id = ?'
      )
      .run(contextMessages, mentionOnlyReplies ? 1 : 0, Date.now(), guildId);
  }

  watchChannels(guildId: string): WatchChannel[] {
    const rows = this.db
      .prepare('select channel_id, auto_start, webhook, anyone from guild_watch_channels where guild_id = ? order by channel_id')
      .all(guildId) as { channel_id: string; auto_start: number; webhook: number; anyone: number }[];
    return rows.map((row) => ({
      channelId: row.channel_id,
      autoStart: row.auto_start === 1,
      webhook: row.webhook === 1,
      anyone: row.anyone === 1
    }));
  }

  /** The watch settings of one channel; null when it isn't watched. Called for every guild message. */
  watchChannel(guildId: string, channelId: string): WatchChannel | null {
    const row = this.db
      .prepare('select auto_start, webhook, anyone from guild_watch_channels where guild_id = ? and channel_id = ?')
      .get(guildId, channelId) as { auto_start: number; webhook: number; anyone: number } | undefined;
    return row
      ? { channelId, autoStart: row.auto_start === 1, webhook: row.webhook === 1, anyone: row.anyone === 1 }
      : null;
  }

  /** Limits for members without Start tasks in "anyone" channels. */
  watchLimits(guildId: string): Limits {
    const row = this.db
      .prepare('select watch_max_acu, watch_tasks_per_day, watch_concurrent_tasks from guilds where guild_id = ?')
      .get(guildId) as { watch_max_acu: number; watch_tasks_per_day: number; watch_concurrent_tasks: number } | undefined;
    return row
      ? { maxAcu: row.watch_max_acu, tasksPerDay: row.watch_tasks_per_day, concurrentTasks: row.watch_concurrent_tasks }
      : { ...DEFAULT_WATCH_LIMITS };
  }

  setWatchLimits(guildId: string, limits: { maxAcu: number; tasksPerDay: number; concurrentTasks: number }) {
    this.ensure(guildId);
    this.db
      .prepare(
        'update guilds set watch_max_acu = ?, watch_tasks_per_day = ?, watch_concurrent_tasks = ?, updated_at = ? where guild_id = ?'
      )
      .run(limits.maxAcu, limits.tasksPerDay, limits.concurrentTasks, Date.now(), guildId);
  }

  /** Replaces every watched channel. Channels with nothing ticked are not stored; "anyone" needs auto-start. */
  setWatchChannels(guildId: string, channels: WatchChannel[]) {
    this.ensure(guildId);
    const insert = this.db.prepare(
      'insert or replace into guild_watch_channels (guild_id, channel_id, auto_start, webhook, anyone) values (?, ?, ?, ?, ?)'
    );
    this.transaction(() => {
      this.db.prepare('delete from guild_watch_channels where guild_id = ?').run(guildId);
      for (const channel of channels) {
        if (!channel.autoStart && !channel.webhook) continue;
        insert.run(
          guildId,
          channel.channelId,
          channel.autoStart ? 1 : 0,
          channel.webhook ? 1 : 0,
          channel.autoStart && channel.anyone ? 1 : 0
        );
      }
    });
  }

  webhook(guildId: string): WebhookSettings | null {
    const row = this.db.prepare('select * from guild_webhook where guild_id = ?').get(guildId) as
      | {
          url_encrypted: string;
          url_hint: string;
          secret_encrypted: string | null;
          include_threads: number;
          include_bots: number;
          updated_at: number;
        }
      | undefined;
    return row
      ? {
          urlEncrypted: row.url_encrypted,
          urlHint: row.url_hint,
          secretEncrypted: row.secret_encrypted,
          includeThreads: row.include_threads === 1,
          includeBots: row.include_bots === 1,
          updatedAt: row.updated_at
        }
      : null;
  }

  saveWebhook(guildId: string, webhook: Omit<WebhookSettings, 'updatedAt'>) {
    this.ensure(guildId);
    this.db
      .prepare(
        `insert into guild_webhook (guild_id, url_encrypted, url_hint, secret_encrypted, include_threads, include_bots, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict (guild_id) do update set
           url_encrypted = excluded.url_encrypted,
           url_hint = excluded.url_hint,
           secret_encrypted = excluded.secret_encrypted,
           include_threads = excluded.include_threads,
           include_bots = excluded.include_bots,
           updated_at = excluded.updated_at`
      )
      .run(
        guildId,
        webhook.urlEncrypted,
        webhook.urlHint,
        webhook.secretEncrypted,
        webhook.includeThreads ? 1 : 0,
        webhook.includeBots ? 1 : 0,
        Date.now()
      );
  }

  clearWebhook(guildId: string) {
    this.db.prepare('delete from guild_webhook where guild_id = ?').run(guildId);
  }

  /** The server's MCP token, without the token itself. */
  mcpToken(guildId: string): { hint: string; createdAt: number } | null {
    const row = this.db
      .prepare('select token_hint, created_at from guild_mcp where guild_id = ?')
      .get(guildId) as { token_hint: string; created_at: number } | undefined;
    return row ? { hint: row.token_hint, createdAt: row.created_at } : null;
  }

  /** Replaces the server's MCP token; the old one stops working. */
  setMcpToken(guildId: string, tokenHash: string, hint: string) {
    this.ensure(guildId);
    this.db
      .prepare(
        `insert into guild_mcp (guild_id, token_hash, token_hint, created_at) values (?, ?, ?, ?)
         on conflict (guild_id) do update set token_hash = excluded.token_hash, token_hint = excluded.token_hint, created_at = excluded.created_at`
      )
      .run(guildId, tokenHash, hint, Date.now());
  }

  clearMcpToken(guildId: string) {
    this.db.prepare('delete from guild_mcp where guild_id = ?').run(guildId);
  }

  /** The server an MCP token belongs to, looked up by the token's hash. */
  guildForMcpToken(tokenHash: string): string | null {
    const row = this.db
      .prepare('select guild_id from guild_mcp where token_hash = ?')
      .get(tokenHash) as { guild_id: string } | undefined;
    return row?.guild_id ?? null;
  }

  audit(guildId: string, actor: Actor, action: string, detail = '') {
    this.db
      .prepare(
        'insert into audit_log (guild_id, actor_id, actor_name, action, detail, created_at) values (?, ?, ?, ?, ?, ?)'
      )
      .run(guildId, actor.id, actor.name, action, detail, Date.now());
  }

  /** Deletes audit entries written before `before`; returns how many. */
  pruneAudit(before: number): number {
    return Number(this.db.prepare('delete from audit_log where created_at < ?').run(before).changes);
  }

  auditLog(guildId: string, limit = 200): AuditEntry[] {
    const rows = this.db
      .prepare('select * from audit_log where guild_id = ? order by id desc limit ?')
      .all(guildId, limit) as {
      id: number;
      actor_id: string;
      actor_name: string;
      action: string;
      detail: string;
      created_at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action,
      detail: row.detail,
      createdAt: row.created_at
    }));
  }

  private transaction(work: () => void) {
    this.db.exec('begin');
    try {
      work();
      this.db.exec('commit');
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }
}
