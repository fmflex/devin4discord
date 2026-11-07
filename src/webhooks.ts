import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { ChannelRef } from './bot.ts';
import type { Secrets } from './crypto.ts';
import type { GuildStore } from './guilds.ts';

export const WEBHOOK_TIMEOUT_MS = 5000;
/** Webhook calls in flight per server; messages beyond it are dropped, not queued. */
export const MAX_WEBHOOKS_IN_FLIGHT = 4;
export const MAX_WEBHOOK_URL = 2048;
export const MAX_WEBHOOK_SECRET = 512;
export const WEBHOOK_SECRET_HEADER = 'X-Webhook-Secret';

/** What a watched channel's webhook receives for each new message. */
export type ChannelEvent = {
  type: 'message.created';
  guild: { id: string; name: string };
  channel: { id: string; name: string; parentId: string | null; isThread: boolean };
  message: {
    id: string;
    link: string;
    content: string;
    author: { id: string; name: string; bot: boolean };
    attachments: { filename: string; url: string }[];
    createdAt: string;
  };
};

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

/** False for loopback, private, link-local, carrier-grade NAT, documentation, multicast and reserved addresses. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPublicAddress(mapped[1]);
  if (lower.startsWith('::ffff:')) return false;
  return !BLOCKED.check(lower, 'ipv6');
}

/** Checks a webhook URL from the settings page; throws a message to show the admin. */
export function webhookUrl(raw: string): URL {
  if (raw.length > MAX_WEBHOOK_URL) throw new Error(`The webhook URL can be at most ${MAX_WEBHOOK_URL} characters.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The webhook URL must be a URL like https://example.com/hook.');
  }
  if (url.protocol !== 'https:') throw new Error('The webhook URL must use https.');
  if (url.username || url.password) throw new Error("The webhook URL can't contain a user name or password.");
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('The webhook URL must point to a public host.');
  }
  if (isIP(host) && !isPublicAddress(host)) throw new Error('The webhook URL must point to a public address.');
  return url;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Resolver = (hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

const systemResolver: Resolver = (hostname, callback) => dnsLookup(hostname, { all: true }, callback);

/**
 * A `lookup` for `https.request` that refuses hosts resolving to any non-public address,
 * checked at connect time so a DNS change after saving can't reach the host's own network.
 */
export function publicOnlyLookup(resolve: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    resolve(hostname, (error, addresses) => {
      if (error) return callback(error, []);
      if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
        const refused = new Error(`${hostname} resolves to a non-public address.`) as NodeJS.ErrnoException;
        refused.code = 'EADDRNOTAVAIL';
        return callback(refused, []);
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export type PostJson = (url: URL, body: string, headers: Record<string, string>) => Promise<number>;

/** POSTs without following redirects; resolves to the status code. */
export const postJson: PostJson = (url, body, headers) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
        lookup: publicOnlyLookup() as never,
        timeout: WEBHOOK_TIMEOUT_MS
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${WEBHOOK_TIMEOUT_MS} ms.`)));
    req.on('error', reject);
    req.end(body);
  });

export type WatchedMessage = {
  guildId: string;
  channel: ChannelRef;
  /** The bot's own messages are never sent, so a Devin session posting through MCP can't loop. */
  fromSelf: boolean;
  /** Other bots and Discord webhooks. */
  fromBot: boolean;
  /** Built only when the message is sent. */
  event: () => ChannelEvent;
};

export type NotifyResult = 'skipped' | 'sent' | 'dropped' | 'failed';

/** Sends new messages in watched channels to the server's webhook. */
export class Watcher {
  private readonly guilds: GuildStore;
  private readonly secrets: Secrets;
  private readonly post: PostJson;
  private readonly inFlight = new Map<string, number>();

  constructor(options: { guilds: GuildStore; secrets: Secrets; post?: PostJson }) {
    this.guilds = options.guilds;
    this.secrets = options.secrets;
    this.post = options.post ?? postJson;
  }

  async notify(message: WatchedMessage): Promise<NotifyResult> {
    const { guildId, channel } = message;
    if (message.fromSelf || channel.isPrivate) return 'skipped';
    const watchedId = channel.parentId ?? channel.id;
    if (!this.guilds.watchChannel(guildId, watchedId)?.webhook) return 'skipped';
    const settings = this.guilds.webhook(guildId);
    if (!settings) return 'skipped';
    if (channel.parentId && !settings.includeThreads) return 'skipped';
    if (message.fromBot && !settings.includeBots) return 'skipped';
    const busy = this.inFlight.get(guildId) ?? 0;
    if (busy >= MAX_WEBHOOKS_IN_FLIGHT) {
      console.error(`Webhook for server ${guildId} dropped a message: ${busy} calls already in flight.`);
      return 'dropped';
    }
    this.inFlight.set(guildId, busy + 1);
    try {
      const url = webhookUrl(this.secrets.decrypt(settings.urlEncrypted, guildId));
      const headers: Record<string, string> = {};
      if (settings.secretEncrypted) {
        headers[WEBHOOK_SECRET_HEADER] = this.secrets.decrypt(settings.secretEncrypted, guildId);
      }
      const status = await this.post(url, JSON.stringify(message.event()), headers);
      if (status < 200 || status >= 300) {
        console.error(`Webhook for server ${guildId} (${settings.urlHint}) answered ${status}.`);
        return 'failed';
      }
      return 'sent';
    } catch (error) {
      console.error(
        `Webhook for server ${guildId} (${settings.urlHint}) failed:`,
        error instanceof Error ? error.message : String(error)
      );
      return 'failed';
    } finally {
      const left = (this.inFlight.get(guildId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(guildId, left);
      else this.inFlight.delete(guildId);
    }
  }
}
