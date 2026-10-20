import type { MemberSnapshot } from './permissions.ts';

export type RoleInfo = {
  id: string;
  name: string;
  /** RGB integer; 0 means no colour. */
  color: number;
  position: number;
  /** Bot and integration roles can't be assigned to people. */
  managed: boolean;
};

/** Read = View Channel + Read Message History; post = View Channel + Send Messages (in threads: Send Messages in Threads). */
export type ChannelAccess = { read: boolean; post: boolean };

export type ChannelInfo = {
  id: string;
  name: string;
  kind: 'text' | 'announcement' | 'forum';
  category: string | null;
  position: number;
  /** @everyone can view it; absent when unknown. */
  public?: boolean;
  /** The bot's own Discord permissions here; absent when unknown. */
  bot?: ChannelAccess;
  /** The Discord permissions of the member passed to `channels`; absent when none was. */
  viewer?: ChannelAccess;
};

/** Live server data read through the bot, so the UI never trusts the OAuth guild list alone. */
export interface Directory {
  hasGuild(guildId: string): boolean;
  guildName(guildId: string): string | null;
  /** Null when the user isn't in the server. */
  member(guildId: string, userId: string): Promise<MemberSnapshot | null>;
  roles(guildId: string): Promise<RoleInfo[]>;
  /** With `viewerId`, each channel also carries that member's own access (none if they left the server). */
  channels(guildId: string, viewerId?: string): Promise<ChannelInfo[]>;
  /** What a member may do in a channel or thread by their own Discord permissions; none when unknown. */
  access(guildId: string, userId: string, channelId: string): Promise<ChannelAccess>;
}
