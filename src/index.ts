import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from '@hono/node-server';
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
import { GuildStore } from './guilds.ts';
import { createMcpHandler } from './mcp.ts';
import { TaskStore } from './store.ts';
import { devinResolver } from './tenants.ts';
import { createWebApp } from './web/app.ts';
import { SessionStore } from './web/sessions.ts';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const secrets = new Secrets(config.masterKey);
const tasks = new TaskStore(db);
const guilds = new GuildStore(db);
const sessions = new SessionStore(db);
const client = createClient();
const bridge = new Bridge({
  devin: devinResolver(guilds, secrets, config.devinApiUrl),
  store: tasks,
  chat: discordChat(client),
  ignorePrefix: IGNORE_PREFIX
});
const bot = new Bot({ bridge, guilds, tasks, publicUrl: config.publicUrl });

wireDiscord(client, bot, tasks);

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
  mcp: createMcpHandler({ publicUrl: config.publicUrl, guilds, tasks, directory, reader: discordReader(client) })
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

while (!stopping) {
  await sleep(config.pollIntervalMs);
  if (client.isReady()) await bridge.syncAll();
}
