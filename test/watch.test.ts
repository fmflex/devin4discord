import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Secrets } from '../src/crypto.ts';
import { openDatabase } from '../src/db.ts';
import { GuildStore } from '../src/guilds.ts';
import {
  MAX_WEBHOOKS_IN_FLIGHT,
  Watcher,
  isPublicAddress,
  publicOnlyLookup,
  webhookUrl,
  type ChannelEvent,
  type WatchedMessage
} from '../src/webhooks.ts';

const G = '900000000000000001';
const WATCHED = '400000000000000001';

test('only public addresses pass', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.100.100.100',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'not-an-ip'
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test('webhook URLs must be https on a public host', () => {
  assert.equal(webhookUrl('https://api.devin.ai/hooks/abc?x=1').host, 'api.devin.ai');
  for (const bad of [
    'http://example.com/hook',
    'ftp://example.com',
    'not a url',
    'https://user:pass@example.com/',
    'https://localhost/hook',
    'https://bridge.internal/hook',
    'https://127.0.0.1/hook',
    'https://[::1]/hook',
    'https://169.254.169.254/latest',
    `https://example.com/${'a'.repeat(2100)}`
  ]) {
    assert.throws(() => webhookUrl(bad), Error, bad);
  }
});

test('the connect-time lookup refuses hosts that resolve to a private address', async () => {
  const lookup = (addresses: string[]) =>
    new Promise<string>((resolve, reject) =>
      publicOnlyLookup((_host, cb) => cb(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))))(
        'hook.example.com',
        {},
        (error, address) => (error ? reject(error) : resolve(String(address)))
      )
    );
  assert.equal(await lookup(['93.184.216.34']), '93.184.216.34');
  await assert.rejects(lookup(['93.184.216.34', '10.0.0.5']), /non-public/);
  await assert.rejects(lookup(['::1']), /non-public/);
  await assert.rejects(lookup([]), /non-public/);
});

function event(): ChannelEvent {
  return {
    type: 'message.created',
    guild: { id: G, name: 'Test' },
    channel: { id: WATCHED, name: 'feedback', parentId: null, isThread: false },
    message: {
      id: 'm1',
      link: 'https://discord.com/channels/x',
      content: 'The rotation skips Shank',
      author: { id: '42', name: 'Player', bot: false },
      attachments: [],
      createdAt: '2026-11-07T00:00:00.000Z'
    }
  };
}

function setup() {
  const guilds = new GuildStore(openDatabase(':memory:'));
  const secrets = new Secrets('test-master-key-test-master-key-1234');
  const posts: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  let status = 200;
  let gate: Promise<void> | null = null;
  const watcher = new Watcher({
    guilds,
    secrets,
    post: async (url, body, headers) => {
      if (gate) await gate;
      posts.push({ url: url.href, body: JSON.parse(body), headers });
      return status;
    }
  });
  const message = (overrides: Partial<WatchedMessage> = {}): WatchedMessage => ({
    guildId: G,
    channel: { id: WATCHED, parentId: null },
    fromSelf: false,
    fromBot: false,
    event,
    ...overrides
  });
  const saveWebhook = (options: { includeThreads?: boolean; includeBots?: boolean; secret?: string | null } = {}) =>
    guilds.saveWebhook(G, {
      urlEncrypted: secrets.encrypt('https://hooks.example.com/devin', G),
      urlHint: 'hooks.example.com',
      secretEncrypted: options.secret === null ? null : secrets.encrypt(options.secret ?? 's3cret', G),
      includeThreads: options.includeThreads ?? false,
      includeBots: options.includeBots ?? false
    });
  return {
    guilds,
    watcher,
    posts,
    message,
    saveWebhook,
    setStatus: (code: number) => (status = code),
    hold: () => {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    }
  };
}

test('messages in webhook channels are POSTed with the secret header', async () => {
  const t = setup();
  assert.equal(await t.watcher.notify(t.message()), 'skipped', 'not watched yet');
  t.guilds.setWatchChannels(G, [{ channelId: WATCHED, autoStart: false, webhook: true, anyone: false }]);
  assert.equal(await t.watcher.notify(t.message()), 'skipped', 'no webhook yet');
  t.saveWebhook();
  assert.equal(await t.watcher.notify(t.message()), 'sent');
  assert.deepEqual(t.posts[0], {
    url: 'https://hooks.example.com/devin',
    body: event(),
    headers: { 'X-Webhook-Secret': 's3cret' }
  });
  t.saveWebhook({ secret: null });
  await t.watcher.notify(t.message());
  assert.deepEqual(t.posts[1].headers, {});
  t.guilds.setWatchChannels(G, [{ channelId: WATCHED, autoStart: true, webhook: false, anyone: false }]);
  assert.equal(await t.watcher.notify(t.message()), 'skipped', 'auto-start alone sends nothing');
});

test('the bot itself, private threads, and threads or bots unless opted in are never sent', async () => {
  const t = setup();
  t.guilds.setWatchChannels(G, [{ channelId: WATCHED, autoStart: false, webhook: true, anyone: false }]);
  t.saveWebhook();
  const thread = { id: 'thread-1', parentId: WATCHED };
  assert.equal(await t.watcher.notify(t.message({ fromSelf: true, fromBot: true })), 'skipped');
  assert.equal(await t.watcher.notify(t.message({ fromBot: true })), 'skipped');
  assert.equal(await t.watcher.notify(t.message({ channel: thread })), 'skipped');
  assert.equal(await t.watcher.notify(t.message({ channel: { id: 'other', parentId: null } })), 'skipped');
  t.saveWebhook({ includeThreads: true, includeBots: true });
  assert.equal(await t.watcher.notify(t.message({ fromSelf: true, fromBot: true })), 'skipped');
  assert.equal(await t.watcher.notify(t.message({ channel: { ...thread, isPrivate: true } })), 'skipped');
  assert.equal(await t.watcher.notify(t.message({ fromBot: true })), 'sent');
  assert.equal(await t.watcher.notify(t.message({ channel: thread })), 'sent');
  assert.equal(t.posts.length, 2);
});

test('failed calls are reported and calls beyond the in-flight cap are dropped', async () => {
  const t = setup();
  t.guilds.setWatchChannels(G, [{ channelId: WATCHED, autoStart: false, webhook: true, anyone: false }]);
  t.saveWebhook();
  t.setStatus(500);
  assert.equal(await t.watcher.notify(t.message()), 'failed');
  t.setStatus(204);
  const release = t.hold();
  const pending = Array.from({ length: MAX_WEBHOOKS_IN_FLIGHT }, () => t.watcher.notify(t.message()));
  assert.equal(await t.watcher.notify(t.message()), 'dropped');
  release();
  assert.deepEqual(await Promise.all(pending), Array(MAX_WEBHOOKS_IN_FLIGHT).fill('sent'));
  assert.equal(await t.watcher.notify(t.message()), 'sent');
});
