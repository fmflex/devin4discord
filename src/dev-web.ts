/**
 * Development only: runs the setup UI against a seeded fake server so pages can
 * be viewed without a Discord app. Discord REST and the Devin key check are
 * mocked. Refuses to start unless NODE_ENV=development and DEV_LOGIN_GUILD_ID
 * are set; the production entry point (src/index.ts) never loads this file.
 */
import { serve } from '@hono/node-server';
import { Secrets } from './crypto.ts';
import { openDatabase } from './db.ts';
import type { ChannelInfo, Directory, RoleInfo } from './directory.ts';
import { BOT_PERMISSIONS } from './discord.ts';
import { GuildStore } from './guilds.ts';
import { createWebApp } from './web/app.ts';
import type { DiscordIdentity } from './web/oauth.ts';
import { SessionStore } from './web/sessions.ts';

export function devLoginEnabled(env: NodeJS.ProcessEnv) {
  return env.NODE_ENV === 'development' && Boolean(env.DEV_LOGIN_GUILD_ID?.trim());
}

export function devFixtures(guildId: string) {
  const userId = '100000000000000001';
  const identity: DiscordIdentity = {
    user: { id: userId, username: 'Dev Admin', avatar: null },
    guilds: [
      { id: guildId, name: 'Rice Rotations', icon: null, owner: true, permissions: '2147483647' },
      { id: '200000000000000002', name: 'Side Project', icon: null, owner: true, permissions: '8' },
      { id: '200000000000000003', name: 'Gaming Friends', icon: null, owner: false, permissions: '0' }
    ]
  };
  const roles: RoleInfo[] = [
    { id: guildId, name: '@everyone', color: 0, position: 0, managed: false },
    { id: '300000000000000001', name: 'Admin', color: 0xe74c3c, position: 5, managed: false },
    { id: '300000000000000002', name: 'Moderator', color: 0x3498db, position: 4, managed: false },
    { id: '300000000000000003', name: 'Contributor', color: 0x2ecc71, position: 3, managed: false },
    { id: '300000000000000004', name: 'Supporter', color: 0xf1c40f, position: 2, managed: false },
    { id: '300000000000000005', name: 'Devin', color: 0, position: 6, managed: true }
  ];
  const channels: ChannelInfo[] = [
    { id: '400000000000000001', name: 'announcements', kind: 'announcement', category: 'Info', position: 0 },
    { id: '400000000000000002', name: 'general', kind: 'text', category: 'Community', position: 1000 },
    { id: '400000000000000003', name: 'bug-reports', kind: 'forum', category: 'Community', position: 1001 },
    { id: '400000000000000004', name: 'dev-help', kind: 'text', category: 'Development', position: 2000 },
    { id: '400000000000000005', name: 'devin-tasks', kind: 'text', category: 'Development', position: 2001 }
  ];
  const directory: Directory = {
    hasGuild: (id) => id === guildId,
    guildName: (id) => (id === guildId ? 'Rice Rotations' : null),
    member: async (id, memberId) =>
      id === guildId && memberId === userId
        ? { id: userId, name: 'Dev Admin', roleIds: [guildId, '300000000000000001'], isAdmin: true, canManageGuild: true }
        : null,
    roles: async () => roles,
    channels: async () => channels
  };
  return { identity, directory };
}

/** Accepts any Devin key; the dev server never contacts Devin. */
const mockDevinFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ principal_type: 'service_user', service_user_name: 'dev', items: [] }), {
    headers: { 'Content-Type': 'application/json' }
  });

if (import.meta.main) {
  if (!devLoginEnabled(process.env)) {
    console.error('dev-web only runs with NODE_ENV=development and DEV_LOGIN_GUILD_ID set.');
    process.exit(1);
  }
  const guildId = process.env.DEV_LOGIN_GUILD_ID!.trim();
  const port = Number(process.env.PORT ?? 3000);
  const db = openDatabase(process.env.DEV_DATABASE ?? ':memory:');
  const { identity, directory } = devFixtures(guildId);
  const app = createWebApp({
    publicUrl: `http://localhost:${port}`,
    discordClientId: '000000000000000000',
    discordClientSecret: 'dev',
    botPermissions: BOT_PERMISSIONS,
    devinApiUrl: 'https://api.devin.ai',
    secrets: new Secrets('development-only-master-key-not-secret'),
    guilds: new GuildStore(db),
    sessions: new SessionStore(db),
    directory,
    fetch: mockDevinFetch,
    devLogin: identity
  });
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Dev setup UI: http://localhost:${port}/auth/dev`);
  });
}
