import type { DatabaseSync } from 'node:sqlite';
import { randomToken, sha256 } from '../crypto.ts';

/** A server from the user's OAuth `guilds` list. `permissions` is a bitfield string. */
export type OAuthGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
};

export type WebSession = {
  userId: string;
  username: string;
  avatar: string | null;
  guilds: OAuthGuild[];
  csrfToken: string;
  expiresAt: number;
};

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Web sign-in sessions. Only a hash of the session ID is stored. */
export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Returns the new session's ID, to be put in the signed cookie. */
  create(user: { id: string; username: string; avatar: string | null }, guilds: OAuthGuild[]) {
    const id = randomToken();
    const now = Date.now();
    this.db.prepare('delete from web_sessions where expires_at < ?').run(now);
    this.db
      .prepare(
        `insert into web_sessions (id_hash, user_id, username, avatar, guilds, csrf_token, created_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sha256(id),
        user.id,
        user.username,
        user.avatar,
        JSON.stringify(guilds),
        randomToken(),
        now,
        now + SESSION_TTL_MS
      );
    return id;
  }

  get(id: string): WebSession | null {
    const raw = this.db
      .prepare('select * from web_sessions where id_hash = ? and expires_at > ?')
      .get(sha256(id), Date.now()) as
      | {
          user_id: string;
          username: string;
          avatar: string | null;
          guilds: string;
          csrf_token: string;
          expires_at: number;
        }
      | undefined;
    return raw
      ? {
          userId: raw.user_id,
          username: raw.username,
          avatar: raw.avatar,
          guilds: JSON.parse(raw.guilds) as OAuthGuild[],
          csrfToken: raw.csrf_token,
          expiresAt: raw.expires_at
        }
      : null;
  }

  delete(id: string) {
    this.db.prepare('delete from web_sessions where id_hash = ?').run(sha256(id));
  }
}
