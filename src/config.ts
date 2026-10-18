import { join } from 'node:path';
import { DEFAULT_DEVIN_API_URL } from './devin.ts';

/** Host-level settings. Everything per server lives in the database. */
export type Config = {
  discordToken: string;
  discordClientId: string;
  discordClientSecret: string;
  masterKey: string;
  /** Where the web UI is reached, without a trailing slash. */
  publicUrl: string;
  port: number;
  databasePath: string;
  devinApiUrl: string;
  pollIntervalMs: number;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  return env[name]?.trim() || null;
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = optional(env, name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

export function publicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PUBLIC_URL must be a URL like https://devin.example.com.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('PUBLIC_URL must use https (http is only allowed for localhost).');
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    discordToken: required(env, 'DISCORD_TOKEN'),
    discordClientId: required(env, 'DISCORD_CLIENT_ID'),
    discordClientSecret: required(env, 'DISCORD_CLIENT_SECRET'),
    masterKey: required(env, 'MASTER_KEY'),
    publicUrl: publicUrl(required(env, 'PUBLIC_URL')),
    port: positiveNumber(env, 'PORT') ?? 3000,
    databasePath: join(optional(env, 'DATA_DIR') ?? './data', 'tasks.db'),
    devinApiUrl: optional(env, 'DEVIN_API_BASE_URL') ?? DEFAULT_DEVIN_API_URL,
    pollIntervalMs: (positiveNumber(env, 'POLL_INTERVAL_SECONDS') ?? 30) * 1000
  };
}
