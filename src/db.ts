import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Schema migrations, applied in order and tracked in `pragma user_version`.
 * Never edit a released migration; append a new one.
 */
export const MIGRATIONS: string[] = [
  // 1: the single-server starter schema.
  `create table if not exists tasks (
     task_id text primary key,
     agent text not null,
     thread_id text not null unique,
     source_message_id text,
     opener_id text not null,
     title text not null,
     url text not null,
     state_label text,
     cursor text,
     pull_requests text not null default '[]',
     active integer not null default 1,
     created_at integer not null,
     updated_at integer not null
   );
   create index if not exists tasks_source_idx on tasks (source_message_id);
   create index if not exists tasks_active_idx on tasks (active, updated_at);`,

  // 2: multi-tenant servers. Older tasks get their guild_id backfilled from
  // Discord on start-up.
  `alter table tasks add column guild_id text;
   create index tasks_guild_opener_idx on tasks (guild_id, opener_id, created_at);

   create table guilds (
     guild_id text primary key,
     name text not null default '',
     task_channel_id text,
     instructions text not null default '',
     created_at integer not null,
     updated_at integer not null
   );

   create table guild_devin (
     guild_id text primary key references guilds (guild_id) on delete cascade,
     api_key_encrypted text not null,
     api_key_hint text not null,
     org_id text not null,
     default_repos text not null default '[]',
     user_map text not null default '{}',
     updated_at integer not null
   );

   create table guild_roles (
     guild_id text not null references guilds (guild_id) on delete cascade,
     role_id text not null,
     start_tasks integer not null default 0,
     reply integer not null default 0,
     manage_tasks integer not null default 0,
     settings integer not null default 0,
     max_acu integer,
     tasks_per_day integer,
     concurrent_tasks integer,
     primary key (guild_id, role_id)
   );

   create table guild_channels (
     guild_id text not null references guilds (guild_id) on delete cascade,
     channel_id text not null,
     primary key (guild_id, channel_id)
   );

   create table audit_log (
     id integer primary key autoincrement,
     guild_id text not null,
     actor_id text not null,
     actor_name text not null,
     action text not null,
     detail text not null default '',
     created_at integer not null
   );
   create index audit_log_guild_idx on audit_log (guild_id, id);

   create table web_sessions (
     id_hash text primary key,
     user_id text not null,
     username text not null,
     avatar text,
     guilds text not null default '[]',
     csrf_token text not null,
     created_at integer not null,
     expires_at integer not null
   );`,

  // 3: mentions, stop and sleep.
  `alter table tasks add column stopped_by text;
   alter table tasks add column slept_by text;
   alter table guilds add column context_messages integer not null default 10;
   alter table guilds add column mention_only_replies integer not null default 0;`,

  // 4: per-server MCP token (only its hash is stored).
  `create table guild_mcp (
     guild_id text primary key,
     token_hash text not null unique,
     token_hint text not null,
     created_at integer not null
   );`,

  // 5: channels the MCP token may post in outside task threads.
  `create table guild_mcp_post_channels (
     guild_id text not null references guilds (guild_id) on delete cascade,
     channel_id text not null,
     primary key (guild_id, channel_id)
   );`
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Opens (creating if needed) and migrates the database. `path` may be ":memory:". */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync) {
  const { user_version: current } = db.prepare('pragma user_version').get() as {
    user_version: number;
  };
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('begin');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`pragma user_version = ${version + 1}`);
      db.exec('commit');
    } catch (error) {
      db.exec('rollback');
      throw error;
    }
  }
}
