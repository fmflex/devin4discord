import type { DatabaseSync } from 'node:sqlite';
import { statSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_VERSION } from './db.ts';
import type { HostHealth, LoggedError, PruneStatus } from './health.ts';
import { PRUNE_INTERVAL_MS, RETENTION_DAYS } from './retention.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;
const GB = 1024 * MB;

/** What the Discord gateway says right now; null when the bot isn't connected. */
export type BotStatus = {
  ready: boolean;
  pingMs: number | null;
  guilds: { id: string; name: string; memberCount: number }[];
};

export type Warning = { level: 'warn' | 'bad'; text: string };

export type ServerUsage = {
  guildId: string;
  name: string;
  configured: boolean;
  inDiscord: boolean | null;
  memberCount: number | null;
  tasks30d: number;
  users30d: number;
  active: number;
  lastTaskAt: number | null;
};

export type AdminStats = {
  generatedAt: number;
  retentionDays: number;
  servers: {
    botIn: number | null;
    members: number | null;
    known: number;
    configured: number;
    github: number;
    mcp: number;
    webhook: number;
    watched: number;
    userMaps: number;
    notConfigured: number | null;
    leftWithSettings: number | null;
  };
  tasks: {
    stored: number;
    active: number;
    sleeping: number;
    stopped: number;
    last24h: number;
    last7d: number;
    last30d: number;
    users7d: number;
    users30d: number;
    servers7d: number;
    servers30d: number;
    withPr30d: number;
    longRunning: number;
    withoutServer: number;
    states: { label: string; count: number }[];
  };
  daily: { day: string; tasks: number; users: number }[];
  actions: { action: string; count: number }[];
  topServers: ServerUsage[];
  web: { activeSessions: number; signedInUsers: number; signedInUsers7d: number };
  database: {
    path: string;
    fileBytes: number;
    walBytes: number;
    usedBytes: number;
    freeBytes: number;
    diskFreeBytes: number | null;
    diskTotalBytes: number | null;
    schemaVersion: number;
    tables: { name: string; rows: number; bytes: number | null }[];
  };
  host: {
    uptimeMs: number;
    rssBytes: number;
    heapUsedBytes: number;
    node: string;
    discordReady: boolean;
    discordPingMs: number | null;
    lastPrune: PruneStatus | null;
    errors1h: number;
    errors24h: number;
    recentErrors: LoggedError[];
    topErrors: { text: string; count: number; lastAt: number }[];
  };
  warnings: Warning[];
};

export const LIMITS = {
  dbWarnBytes: 250 * MB,
  dbBadBytes: GB,
  walWarnBytes: 64 * MB,
  freeWarnRatio: 0.25,
  freeWarnBytes: 10 * MB,
  diskBadBytes: GB,
  diskWarnRatio: 0.1,
  rssWarnBytes: 768 * MB,
  activeWarn: 200,
  errorsHourWarn: 1,
  errorsHourBad: 50,
  longRunningDays: 7
};

function fileSize(path: string) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function count(db: DatabaseSync, sql: string, ...params: (string | number)[]) {
  return Number((db.prepare(sql).get(...params) as { n: number | bigint }).n);
}

/** Same error message with IDs and numbers blanked, so repeats group together. */
function errorKey(text: string) {
  return text.replace(/\d+/g, '#').slice(0, 160);
}

function bytes(n: number) {
  return n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / MB)} MB`;
}

export function collectAdminStats(deps: {
  db: DatabaseSync;
  databasePath: string;
  health: HostHealth;
  bot: BotStatus | null;
  now?: number;
}): AdminStats {
  const { db, health, bot } = deps;
  const now = deps.now ?? Date.now();
  const since24h = now - DAY;
  const since7d = now - 7 * DAY;
  const since30d = now - 30 * DAY;
  const inDiscord = bot ? new Map(bot.guilds.map((g) => [g.id, g])) : null;

  const configuredIds = new Set(
    (db.prepare('select guild_id from guild_devin').all() as { guild_id: string }[]).map((r) => r.guild_id)
  );
  const knownGuilds = db.prepare('select guild_id, name from guilds').all() as { guild_id: string; name: string }[];
  const servers: AdminStats['servers'] = {
    botIn: bot ? bot.guilds.length : null,
    members: bot ? bot.guilds.reduce((sum, g) => sum + g.memberCount, 0) : null,
    known: knownGuilds.length,
    configured: configuredIds.size,
    github: count(db, 'select count(*) as n from guild_github'),
    mcp: count(db, 'select count(*) as n from guild_mcp'),
    webhook: count(db, 'select count(*) as n from guild_webhook'),
    watched: count(db, 'select count(distinct guild_id) as n from guild_watch_channels'),
    userMaps: count(db, "select count(*) as n from guild_devin where user_map not in ('{}', '')"),
    notConfigured: inDiscord ? [...inDiscord.keys()].filter((id) => !configuredIds.has(id)).length : null,
    leftWithSettings: inDiscord ? [...configuredIds].filter((id) => !inDiscord.has(id)).length : null
  };

  const tasks: AdminStats['tasks'] = {
    stored: count(db, 'select count(*) as n from tasks'),
    active: count(db, 'select count(*) as n from tasks where active = 1'),
    sleeping: count(db, 'select count(*) as n from tasks where active = 1 and slept_by is not null'),
    stopped: count(db, 'select count(*) as n from tasks where stopped_by is not null'),
    last24h: count(db, 'select count(*) as n from tasks where created_at >= ?', since24h),
    last7d: count(db, 'select count(*) as n from tasks where created_at >= ?', since7d),
    last30d: count(db, 'select count(*) as n from tasks where created_at >= ?', since30d),
    users7d: count(db, 'select count(distinct opener_id) as n from tasks where created_at >= ?', since7d),
    users30d: count(db, 'select count(distinct opener_id) as n from tasks where created_at >= ?', since30d),
    servers7d: count(db, 'select count(distinct guild_id) as n from tasks where created_at >= ?', since7d),
    servers30d: count(db, 'select count(distinct guild_id) as n from tasks where created_at >= ?', since30d),
    withPr30d: count(db, "select count(*) as n from tasks where created_at >= ? and pull_requests != '[]'", since30d),
    longRunning: count(
      db,
      'select count(*) as n from tasks where active = 1 and created_at < ?',
      now - LIMITS.longRunningDays * DAY
    ),
    withoutServer: count(db, 'select count(*) as n from tasks where guild_id is null'),
    states: (
      db
        .prepare(
          "select coalesce(state_label, 'starting') as label, count(*) as n from tasks where active = 1 group by label order by n desc"
        )
        .all() as { label: string; n: number }[]
    ).map((r) => ({ label: r.label, count: Number(r.n) }))
  };

  const dayRows = db
    .prepare(
      `select strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') as day, count(*) as n, count(distinct opener_id) as u
       from tasks where created_at >= ? group by day`
    )
    .all(since30d) as { day: string; n: number; u: number }[];
  const byDay = new Map(dayRows.map((r) => [r.day, r]));
  const daily: AdminStats['daily'] = [];
  for (let i = 30; i >= 0; i--) {
    const day = new Date(now - i * DAY).toISOString().slice(0, 10);
    const row = byDay.get(day);
    daily.push({ day, tasks: Number(row?.n ?? 0), users: Number(row?.u ?? 0) });
  }

  const actions = (
    db
      .prepare('select action, count(*) as n from audit_log where created_at >= ? group by action order by n desc, action')
      .all(since30d) as { action: string; n: number }[]
  ).map((r) => ({ action: r.action, count: Number(r.n) }));

  const usage = db
    .prepare(
      `select guild_id, count(*) as n, count(distinct opener_id) as u, sum(active) as a, max(created_at) as last
       from tasks where guild_id is not null and (created_at >= ? or active = 1) group by guild_id`
    )
    .all(since30d) as { guild_id: string; n: number; u: number; a: number; last: number }[];
  const recent = new Map(
    (
      db
        .prepare(
          'select guild_id, count(*) as n, count(distinct opener_id) as u from tasks where guild_id is not null and created_at >= ? group by guild_id'
        )
        .all(since30d) as { guild_id: string; n: number; u: number }[]
    ).map((r) => [r.guild_id, r])
  );
  const names = new Map(knownGuilds.map((g) => [g.guild_id, g.name]));
  const topServers: ServerUsage[] = usage
    .map((r) => {
      const live = inDiscord?.get(r.guild_id);
      return {
        guildId: r.guild_id,
        name: live?.name || names.get(r.guild_id) || r.guild_id,
        configured: configuredIds.has(r.guild_id),
        inDiscord: inDiscord ? Boolean(live) : null,
        memberCount: live?.memberCount ?? null,
        tasks30d: Number(recent.get(r.guild_id)?.n ?? 0),
        users30d: Number(recent.get(r.guild_id)?.u ?? 0),
        active: Number(r.a ?? 0),
        lastTaskAt: r.last ?? null
      };
    })
    .sort((a, b) => b.tasks30d - a.tasks30d || b.active - a.active || a.name.localeCompare(b.name))
    .slice(0, 25);

  const web: AdminStats['web'] = {
    activeSessions: count(db, 'select count(*) as n from web_sessions where expires_at > ?', now),
    signedInUsers: count(db, 'select count(distinct user_id) as n from web_sessions where expires_at > ?', now),
    signedInUsers7d: count(
      db,
      'select count(distinct user_id) as n from web_sessions where expires_at > ? and created_at >= ?',
      now,
      since7d
    )
  };

  const pageSize = count(db, 'select page_size as n from pragma_page_size');
  const pages = count(db, 'select page_count as n from pragma_page_count');
  const freePages = count(db, 'select freelist_count as n from pragma_freelist_count');
  const tableNames = (
    db.prepare("select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  let tableBytes: Map<string, number> | null = null;
  try {
    // dbstat is optional in SQLite builds; sizes include each table's indexes.
    const rows = db
      .prepare(
        `select coalesce(i.tbl_name, s.name) as name, sum(s.pgsize) as b
         from dbstat s left join sqlite_schema i on i.name = s.name and i.type = 'index' group by 1`
      )
      .all() as { name: string; b: number }[];
    tableBytes = new Map(rows.map((r) => [r.name, Number(r.b)]));
  } catch {
    tableBytes = null;
  }
  const tables = tableNames
    .map((name) => ({
      name,
      rows: count(db, `select count(*) as n from "${name.replaceAll('"', '""')}"`),
      bytes: tableBytes ? (tableBytes.get(name) ?? 0) : null
    }))
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || b.rows - a.rows);
  const onDisk = deps.databasePath !== ':memory:';
  let diskFreeBytes: number | null = null;
  let diskTotalBytes: number | null = null;
  if (onDisk) {
    try {
      const fs = statfsSync(dirname(deps.databasePath));
      diskFreeBytes = Number(fs.bavail) * Number(fs.bsize);
      diskTotalBytes = Number(fs.blocks) * Number(fs.bsize);
    } catch {
      // Unknown filesystem; leave it blank.
    }
  }
  const database: AdminStats['database'] = {
    path: deps.databasePath,
    fileBytes: onDisk ? fileSize(deps.databasePath) : pages * pageSize,
    walBytes: onDisk ? fileSize(`${deps.databasePath}-wal`) : 0,
    usedBytes: (pages - freePages) * pageSize,
    freeBytes: freePages * pageSize,
    diskFreeBytes,
    diskTotalBytes,
    schemaVersion: SCHEMA_VERSION,
    tables
  };

  const errors24 = health.errorsSince(since24h);
  const groups = new Map<string, { text: string; count: number; lastAt: number }>();
  for (const error of errors24) {
    const key = errorKey(error.text);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { text: error.text, count: 1, lastAt: error.at });
  }
  const memory = process.memoryUsage();
  const host: AdminStats['host'] = {
    uptimeMs: now - health.startedAt,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    node: process.version,
    discordReady: bot?.ready ?? false,
    discordPingMs: bot?.pingMs ?? null,
    lastPrune: health.lastPrune,
    errors1h: errors24.filter((e) => e.at >= now - HOUR).length,
    errors24h: errors24.length,
    recentErrors: errors24.slice(0, 20),
    topErrors: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 10)
  };

  const stats: AdminStats = {
    generatedAt: now,
    retentionDays: RETENTION_DAYS,
    servers,
    tasks,
    daily,
    actions,
    topServers,
    web,
    database,
    host,
    warnings: []
  };
  stats.warnings = adminWarnings(stats);
  return stats;
}

/** The things worth a look, worst first. */
export function adminWarnings(stats: AdminStats): Warning[] {
  const warnings: Warning[] = [];
  const { database: db, host, tasks, servers } = stats;
  if (!host.discordReady) warnings.push({ level: 'bad', text: 'The bot is not connected to Discord: nothing is relayed until it reconnects.' });
  if (host.errors1h >= LIMITS.errorsHourBad) {
    warnings.push({ level: 'bad', text: `${host.errors1h} errors logged in the last hour. See Errors below.` });
  } else if (host.errors1h >= LIMITS.errorsHourWarn) {
    warnings.push({ level: 'warn', text: `${host.errors1h} error${host.errors1h === 1 ? '' : 's'} logged in the last hour. See Errors below.` });
  }
  if (host.lastPrune?.error) {
    warnings.push({ level: 'bad', text: `The last cleanup of old data failed: ${host.lastPrune.error}` });
  } else if (!host.lastPrune && host.uptimeMs > 2 * PRUNE_INTERVAL_MS) {
    warnings.push({ level: 'warn', text: 'Old data hasn\u2019t been cleaned up since start-up.' });
  }
  if (db.diskFreeBytes !== null && db.diskTotalBytes) {
    if (db.diskFreeBytes < LIMITS.diskBadBytes) {
      warnings.push({ level: 'bad', text: `Only ${bytes(db.diskFreeBytes)} free on the data disk. SQLite stops writing when it's full.` });
    } else if (db.diskFreeBytes / db.diskTotalBytes < LIMITS.diskWarnRatio) {
      warnings.push({ level: 'warn', text: `The data disk is ${Math.round(100 - (100 * db.diskFreeBytes) / db.diskTotalBytes)}% full (${bytes(db.diskFreeBytes)} free).` });
    }
  }
  if (db.fileBytes >= LIMITS.dbBadBytes) {
    warnings.push({ level: 'bad', text: `The database is ${bytes(db.fileBytes)}. Check which table grows below.` });
  } else if (db.fileBytes >= LIMITS.dbWarnBytes) {
    warnings.push({ level: 'warn', text: `The database is ${bytes(db.fileBytes)}. Check which table grows below.` });
  }
  if (db.freeBytes >= LIMITS.freeWarnBytes && db.freeBytes / Math.max(1, db.usedBytes + db.freeBytes) >= LIMITS.freeWarnRatio) {
    warnings.push({ level: 'warn', text: `${bytes(db.freeBytes)} of the database file is free space left by deleted rows. A VACUUM would give it back.` });
  }
  if (db.walBytes >= LIMITS.walWarnBytes) {
    warnings.push({ level: 'warn', text: `The write-ahead log is ${bytes(db.walBytes)}; something may be holding a long read open.` });
  }
  if (host.rssBytes >= LIMITS.rssWarnBytes) {
    warnings.push({ level: 'warn', text: `The bot is using ${bytes(host.rssBytes)} of memory.` });
  }
  if (tasks.active >= LIMITS.activeWarn) {
    warnings.push({ level: 'warn', text: `${tasks.active} tasks are active. Each one is polled from Devin every poll interval.` });
  }
  if (tasks.longRunning) {
    warnings.push({ level: 'warn', text: `${tasks.longRunning} active task${tasks.longRunning === 1 ? ' was' : 's were'} started over ${LIMITS.longRunningDays} days ago and ${tasks.longRunning === 1 ? 'is' : 'are'} still polled.` });
  }
  if (tasks.withoutServer) {
    warnings.push({ level: 'warn', text: `${tasks.withoutServer} task${tasks.withoutServer === 1 ? ' has' : 's have'} no server; they are skipped until their server is found.` });
  }
  if (servers.leftWithSettings) {
    warnings.push({ level: 'warn', text: `${servers.leftWithSettings} server${servers.leftWithSettings === 1 ? '' : 's'} removed the bot but still ${servers.leftWithSettings === 1 ? 'has its' : 'have their'} Devin key stored.` });
  }
  return warnings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
}
