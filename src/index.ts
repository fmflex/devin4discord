import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { collectAdminStats } from './admin.ts';
import { Bot } from './bot.ts';
import { Bridge } from './bridge.ts';
import { loadConfig } from './config.ts';
import { Secrets } from './crypto.ts';
import { openDatabase } from './db.ts';
import {
  BOT_PERMISSIONS,
  IGNORE_PREFIX,
  createClient,
  discordChat,
  discordDirectory,
  discordReader,
  wireDiscord
} from './discord.ts';
import { githubResolver } from './github.ts';
import { GuildStore } from './guilds.ts';
import { HostHealth } from './health.ts';
import { createMcpHandler } from './mcp.ts';
import { PRUNE_INTERVAL_MS, pruneOldData } from './retention.ts';
import { TaskStore } from './store.ts';
import { devinResolver } from './tenants.ts';
import { createWebApp } from './web/app.ts';
import { Watcher } from './webhooks.ts';
import { SessionStore } from './web/sessions.ts';

const health = new HostHealth();
health.captureConsole();
const config = loadConfig();
const db = openDatabase(config.databasePath);
const secrets = new Secrets(config.masterKey);
const tasks = new TaskStore(db);
const guilds = new GuildStore(db);
const sessions = new SessionStore(db);
const client = createClient();
const devin = devinResolver(guilds, secrets, config.devinApiUrl);
const bridge = new Bridge({
  devin,
  store: tasks,
  chat: discordChat(client),
  ignorePrefix: IGNORE_PREFIX
});
const bot = new Bot({ bridge, guilds, tasks, publicUrl: config.publicUrl, github: githubResolver(guilds, secrets) });

wireDiscord(client, bot, tasks, new Watcher({ guilds, secrets }));

const directory = discordDirectory(client);
const app = createWebApp({
  publicUrl: config.publicUrl,
  discordClientId: config.discordClientId,
  discordClientSecret: config.discordClientSecret,
  botPermissions: BOT_PERMISSIONS,
  devinApiUrl: config.devinApiUrl,
  secrets,
  guilds,
  sessions,
  directory,
  admin: {
    userIds: config.adminUserIds,
    stats: () =>
      collectAdminStats({
        db,
        databasePath: config.databasePath,
        health,
        bot: client.isReady()
          ? {
              ready: true,
              pingMs: client.ws.ping >= 0 ? Math.round(client.ws.ping) : null,
              guilds: client.guilds.cache.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount }))
            }
          : null
      })
  },
  mcp: createMcpHandler({ publicUrl: config.publicUrl, guilds, tasks, directory, reader: discordReader(client), devin })
});
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`Setup UI listening on port ${port} (${config.publicUrl}).`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('Shutting down.');
  server.close();
  await client.destroy();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
// A failed Discord or Devin call in an event handler must not take the whole bot down.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason instanceof Error ? reason.message : String(reason));
});
process.on('SIGINT', shutdown);

try {
  await client.login(config.discordToken);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Discord login failed: ${message}`);
  if (/disallowed intents/i.test(message)) {
    console.error('Turn on "Message Content Intent" under Bot -> Privileged Gateway Intents in the Discord Developer Portal.');
  }
  process.exit(1);
}

let lastPrune = 0;
while (!stopping) {
  if (Date.now() - lastPrune >= PRUNE_INTERVAL_MS) {
    lastPrune = Date.now();
    try {
      const pruned = pruneOldData({ tasks, guilds, sessions });
      health.recordPrune(pruned.tasks + pruned.audit + pruned.sessions);
      if (pruned.tasks || pruned.audit || pruned.sessions) console.log('Pruned old data:', pruned);
    } catch (error) {
      health.recordPrune(0, error);
      console.error('Pruning old data failed:', error);
    }
  }
  await sleep(config.pollIntervalMs);
  if (client.isReady()) await bridge.syncAll();
}
