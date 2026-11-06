import type { GuildStore } from './guilds.ts';
import type { TaskStore } from './store.ts';
import type { SessionStore } from './web/sessions.ts';

/** How long activity data (audit log, finished tasks) is kept. Server settings are kept until changed. */
export const RETENTION_DAYS = 30;
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export function pruneOldData(
  stores: { tasks: TaskStore; guilds: GuildStore; sessions: SessionStore },
  now = Date.now()
) {
  const before = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return {
    tasks: stores.tasks.pruneInactive(before),
    audit: stores.guilds.pruneAudit(before),
    sessions: stores.sessions.pruneExpired(now)
  };
}
