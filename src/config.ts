import { join } from 'node:path';
import { DevinAdapter } from './agents/devin.ts';
import type { AgentAdapter } from './agents/types.ts';

export type Config = {
  discordToken: string;
  /** Register commands in this server only (instant); global otherwise. */
  guildId: string | null;
  /** Channel where task threads are opened; the source channel otherwise. */
  taskChannelId: string | null;
  /** Roles allowed to use the bot, on top of members with Administrator. */
  allowedRoleIds: string[];
  /** Reacting with this emoji (unicode, or a custom emoji's ID) starts a task. */
  triggerEmoji: string | null;
  /** Thread messages starting with this are not forwarded to the agent. */
  ignorePrefix: string;
  pollIntervalMs: number;
  /** Extra instructions appended to every task prompt. */
  instructions: string;
  databasePath: string;
};

const DEFAULT_INSTRUCTIONS =
  'Work out what is being asked, fix it and open a pull request. If it is unclear or not actionable, say why and what you need.';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  return env[name]?.trim() || null;
}

function list(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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

/** Parses `discordId:agentUserId,discordId:agentUserId`. */
export function parseUserMap(raw: string | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of list(raw)) {
    const [discordId, agentUserId] = entry.split(':').map((part) => part.trim());
    if (discordId && agentUserId) map.set(discordId, agentUserId);
  }
  return map;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const trigger = env.TRIGGER_EMOJI === undefined ? '🤖' : env.TRIGGER_EMOJI.trim();
  return {
    discordToken: required(env, 'DISCORD_TOKEN'),
    guildId: optional(env, 'DISCORD_GUILD_ID'),
    taskChannelId: optional(env, 'TASK_CHANNEL_ID'),
    allowedRoleIds: list(optional(env, 'ALLOWED_ROLE_IDS')),
    triggerEmoji: trigger || null,
    ignorePrefix: env.IGNORE_PREFIX ?? '//',
    pollIntervalMs: (positiveNumber(env, 'POLL_INTERVAL_SECONDS') ?? 30) * 1000,
    instructions: optional(env, 'TASK_INSTRUCTIONS') ?? DEFAULT_INSTRUCTIONS,
    databasePath: join(optional(env, 'DATA_DIR') ?? './data', 'tasks.db')
  };
}

export function loadAgent(env: NodeJS.ProcessEnv = process.env): AgentAdapter {
  const agent = (optional(env, 'AGENT') ?? 'devin').toLowerCase();
  switch (agent) {
    case 'devin':
      return new DevinAdapter({
        apiKey: required(env, 'DEVIN_API_KEY'),
        orgId: required(env, 'DEVIN_ORG_ID'),
        baseUrl: optional(env, 'DEVIN_API_BASE_URL') ?? 'https://api.devin.ai',
        maxAcuLimit: positiveNumber(env, 'DEVIN_MAX_ACU'),
        repos: list(optional(env, 'DEVIN_REPOS')),
        tags: list(optional(env, 'DEVIN_TAGS')),
        userMap: parseUserMap(optional(env, 'DEVIN_USER_MAP'))
      });
    default:
      throw new Error(`Unknown AGENT "${agent}". Supported: devin.`);
  }
}
