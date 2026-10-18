import type { Secrets } from './crypto.ts';
import { DevinClient } from './devin.ts';
import type { GuildStore } from './guilds.ts';

/** Builds each server's Devin client from its saved settings, cached until they change. */
export function devinResolver(
  guilds: GuildStore,
  secrets: Secrets,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
) {
  const cache = new Map<string, { updatedAt: number; client: DevinClient }>();
  return (guildId: string): DevinClient | null => {
    const settings = guilds.devin(guildId);
    if (!settings) {
      cache.delete(guildId);
      return null;
    }
    const cached = cache.get(guildId);
    if (cached?.updatedAt === settings.updatedAt) return cached.client;
    const client = new DevinClient(
      {
        apiKey: secrets.decrypt(settings.apiKeyEncrypted, guildId),
        orgId: settings.orgId,
        baseUrl,
        repos: settings.defaultRepos,
        userMap: settings.userMap
      },
      fetchImpl
    );
    cache.set(guildId, { updatedAt: settings.updatedAt, client });
    return client;
  };
}
