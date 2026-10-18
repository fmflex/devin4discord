import { setTimeout as sleep } from 'node:timers/promises';
import { Bridge } from './bridge.ts';
import { loadAgent, loadConfig } from './config.ts';
import { createClient, discordChat, wireDiscord } from './discord.ts';
import { TaskStore } from './store.ts';

const config = loadConfig();
const agent = loadAgent();
const store = new TaskStore(config.databasePath);
const client = createClient();
const bridge = new Bridge({
  agent,
  store,
  chat: discordChat(client),
  instructions: config.instructions,
  ignorePrefix: config.ignorePrefix
});

wireDiscord(client, bridge, config);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('Shutting down.');
  await client.destroy();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await client.login(config.discordToken);

while (!stopping) {
  await sleep(config.pollIntervalMs);
  if (client.isReady()) await bridge.syncAll();
}
