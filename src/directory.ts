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

export type ChannelInfo = {
  id: string;
  name: string;
  kind: 'text' | 'announcement' | 'forum';
  category: string | null;
  position: number;
};

/** Live server data read through the bot, so the UI never trusts the OAuth guild list alone. */
export interface Directory {
  hasGuild(guildId: string): boolean;
  guildName(guildId: string): string | null;
  /** Null when the user isn't in the server. */
  member(guildId: string, userId: string): Promise<MemberSnapshot | null>;
  roles(guildId: string): Promise<RoleInfo[]>;
  channels(guildId: string): Promise<ChannelInfo[]>;
}
