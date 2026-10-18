import { safeEqual } from '../crypto.ts';
import type { OAuthGuild } from './sessions.ts';

export const DISCORD_API = 'https://discord.com/api/v10';
export const OAUTH_SCOPES = 'identify guilds';

const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

export function authorizeUrl(input: { clientId: string; redirectUri: string; state: string }) {
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: OAUTH_SCOPES,
    state: input.state,
    prompt: 'none'
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

/** The "Add to Discord" link; preselects `guildId` when given. */
export function inviteUrl(clientId: string, permissions: bigint, guildId?: string) {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'bot applications.commands',
    permissions: permissions.toString()
  });
  if (guildId) {
    params.set('guild_id', guildId);
    params.set('disable_guild_select', 'true');
  }
  return `https://discord.com/oauth2/authorize?${params}`;
}

/**
 * The `state` from the callback must equal the one stored in the signed
 * cookie when sign-in began. `expected` is false when the signature failed.
 */
export function checkOAuthState(
  expected: string | undefined | false,
  received: string | undefined | null
): boolean {
  return Boolean(expected && received && safeEqual(expected, received));
}

/** Whether the OAuth guild list says the user could invite the bot there. */
export function canInvite(guild: OAuthGuild) {
  if (guild.owner) return true;
  try {
    const bits = BigInt(guild.permissions);
    return (bits & ADMINISTRATOR) !== 0n || (bits & MANAGE_GUILD) !== 0n;
  } catch {
    return false;
  }
}

async function discordJson<T>(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`Discord ${new URL(url).pathname} failed with ${response.status}`);
  return (await response.json()) as T;
}

export type DiscordIdentity = {
  user: { id: string; username: string; avatar: string | null };
  guilds: OAuthGuild[];
};

/** Exchanges the callback `code` and reads the user and their servers. */
export async function signIn(
  fetchImpl: typeof fetch,
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string }
): Promise<DiscordIdentity> {
  const token = await discordJson<{ access_token: string; token_type: string }>(
    fetchImpl,
    `${DISCORD_API}/oauth2/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri
      })
    }
  );
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const user = await discordJson<{ id: string; username: string; global_name?: string | null; avatar: string | null }>(
    fetchImpl,
    `${DISCORD_API}/users/@me`,
    { headers }
  );
  const guilds = await discordJson<OAuthGuild[]>(fetchImpl, `${DISCORD_API}/users/@me/guilds`, {
    headers
  });
  return {
    user: { id: user.id, username: user.global_name || user.username, avatar: user.avatar },
    guilds: guilds.map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      owner: guild.owner,
      permissions: guild.permissions
    }))
  };
}
