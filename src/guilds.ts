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

  clearDevin(guildId: string) {
    this.db.prepare('delete from guild_devin where guild_id = ?').run(guildId);
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
      `insert into guild_roles (guild_id, role_id, start_tasks, reply, manage_tasks, settings, max_acu, tasks_per_day, concurrent_tasks)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

  setMentionSettings(guildId: string, contextMessages: number, mentionOnlyReplies: boolean) {
    this.ensure(guildId);
    this.db
      .prepare(
        'update guilds set context_messages = ?, mention_only_replies = ?, updated_at = ? where guild_id = ?'
      )
      .run(contextMessages, mentionOnlyReplies ? 1 : 0, Date.now(), guildId);
  }

  audit(guildId: string, actor: Actor, action: string, detail = '') {
    this.db
      .prepare(
        'insert into audit_log (guild_id, actor_id, actor_name, action, detail, created_at) values (?, ?, ?, ?, ?, ?)'
      )
      .run(guildId, actor.id, actor.name, action, detail, Date.now());
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
