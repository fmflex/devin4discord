# devin4discord security model

## System overview
A single hosted Node 24 service (`src/index.ts`) that bridges any number of Discord servers (guilds) to each guild's own Devin organization. It has three faces: a Discord bot (discord.js gateway), a web setup UI (Hono, `src/web/app.ts`), and a per-guild MCP endpoint (`POST /mcp`, `src/mcp.ts`) that Devin sessions call. State is one SQLite file (`src/db.ts`) in the `bridge-data` volume. It is deployed with `Dockerfile` + `docker-compose.yml` on a single Ubuntu host and published only through a Cloudflare tunnel (quick tunnel `*.trycloudflare.com` or a named tunnel) to `bridge:3000`. No separate infrastructure repository exists; the in-repo Dockerfile, compose file and `.github/workflows/ci.yml` are the infrastructure.

## Components
| Component | Code | Notes |
| --- | --- | --- |
| Web UI | `src/web/app.ts`, `src/web/views.ts`, `src/web/docs.ts`, `src/web/oauth.ts`, `src/web/assets/` | Discord OAuth sign-in, per-guild settings pages `/g/:guildId/*`, landing/docs pages |
| MCP server | `src/mcp.ts` (mounted at `/mcp` in `src/web/app.ts`) | Bearer-token JSON-RPC tools for Devin sessions |
| Discord bot | `src/discord.ts`, `src/bot.ts`, `src/triggers.ts`, `src/permissions.ts`, `src/directory.ts` | Triggers (mention, 🤖, context menu, `/devin`, auto-start in watched channels), role permissions and ACU/rate limits, thread control |
| Channel webhook | `src/webhooks.ts` | Outbound POST of new messages in watched channels to each guild's webhook URL |
| Devin bridge | `src/bridge.ts`, `src/devin.ts`, `src/tenants.ts`, `src/format.ts` | Starts/syncs/stops Devin sessions with each guild's service-user key; builds prompts with UNTRUSTED blocks |
| Storage & secrets | `src/db.ts`, `src/guilds.ts`, `src/store.ts`, `src/crypto.ts`, `src/web/sessions.ts` | SQLite schema, guild settings, audit log, AES-256-GCM secrets, web sessions |
| Deployment | `Dockerfile`, `docker-compose.yml`, `.env.example`, `src/config.ts`, `src/index.ts`, `src/dev-web.ts`, `.github/workflows/ci.yml` | Host config, tunnel, dev-only login harness |

## Trust boundaries and entry points
1. **Internet → web UI** (anyone with the tunnel URL): `/`, `/docs`, `/healthz`, `/auth/login`, `/auth/callback`, `/auth/logout`, static assets. `/auth/dev` exists only when `src/dev-web.ts` runs (`NODE_ENV=development` + `DEV_LOGIN_GUILD_ID`).
2. **Signed-in Discord user → `/g/:guildId/*`**: `guard` in `src/web/app.ts` requires a session, the bot in the guild, and `canConfigure` on a fresh member lookup (`directory.member`). POSTs need a session, same-origin `Origin` if sent, `bodyLimit`, and the `_csrf` token. Pages: Devin key/org/user map (`/devin`), permissions, channels, watched channels and webhook (`/watch`), MCP token and channel lists, audit log. POSTs to `/devin`, `/permissions`, `/watch/*` and `/mcp/*` are `adminOnly` (Discord Administrator); other `settings` holders only change Channels-tab entries they can view (`directory.visibleChannels`).
3. **Internet → `/mcp`**: bearer token hashed (`sha256`) and looked up per guild (`guildForMcpToken`); `Origin` must equal `PUBLIC_URL` when present; body capped by `MAX_MCP_BODY_BYTES`. Task-thread tools additionally need the per-task `d4dt_…` key (`byMcpKey`). Read/post limited to the guild's MCP channel lists, or, when an Administrator sets the read/post mode to `bot` (`mcpModes`), to channels where the bot's own Discord permissions allow it (`ChannelRef.bot`); private threads never readable or postable. Post tools' `files` accept only Devin attachment URLs (`parseAttachmentUrl`), downloaded through the guild's own Devin key (`downloadAttachment`, 10 MB cap) with the URL's host ignored, so MCP can't make the bot fetch other URLs or another org's files. Write tools beyond posting (`add_reaction`, `remove_reaction`, `edit_message`, `delete_message`, `create_poll`, `start_thread`) take either the task key (own thread) or a channel on the post list; a channel that is another task's thread is refused (`tasks.byThread`), so one session can't touch another task's thread. `edit_message`/`delete_message` only act on messages the bot authored and never on thread starters (`ownMessage`). `pin_message` is task-thread only. `buttons` accept only http(s) URLs. Nothing pings except `ping_requester`, which pings only the task's opener in its own thread. Administrators can switch tool groups off (`mcpDisabledGroups`); disabled tools are hidden from `tools/list` and refused in `tools/call`.
4. **Discord members → bot**: mentions, 🤖 reactions, Send to Devin, `/devin start|stop|sleep|status|list|link|unlink`, thread replies, Stop/Sleep buttons. Authorization in `src/bot.ts`/`src/permissions.ts` by role rules (Administrator is a configurable pseudo-role; Manage Server always keeps settings); `canSeeThread` for task details; `guild.members.fetch({ force: true })` for fresh roles (no GuildMembers intent). `/devin link` self-maps a member (with `start_tasks`) to a Devin user only after `DevinClient.findLinkSession` finds a web-app session (origin `webapp`, no `service_user_id`) created by that user after a random in-memory code was issued (30 min TTL) whose first message holds the code; one Devin user per member; audited.
5. **Discord content → Devin prompt / MCP results**: message text, names, filenames, URLs pass through `neutralize()` inside a fresh random `untrustedTag()` (`src/format.ts`).
6. **Guild ↔ guild (tenant isolation)**: every row is keyed by guild ID; secrets are encrypted with the guild ID as AAD; one guild's MCP token, session, or settings must never reach another guild's data or Devin org.
7. **Bridge → Devin API**: each guild's service-user key, optional `create_as_user_id` impersonation for members in the Discord-Administrator-only user map, verified via `GET /v3beta1/organizations/{org}/members/users/{id}`. Discord files sent with a task or reply are downloaded only from `cdn.discordapp.com` / `media.discordapp.net` (https, no redirects, 50 MB cap) and re-uploaded with `POST /v3/organizations/{org}/attachments` (`DevinClient.uploadAttachment`); any other URL is only named in the message text.
8. **Bot → guild webhook URL (outbound)**: `Watcher.notify` POSTs new messages from channels ticked under Webhook on `/g/:guildId/watch` to the guild's Administrator-set URL, with its secret in `X-Webhook-Secret`. URL and secret encrypted with guild-ID AAD; `webhookUrl` requires https and a non-local host; `publicOnlyLookup` refuses any non-public resolved address at connect time (DNS rebinding); no redirects, 5 s timeout, 4 calls in flight per guild. Never sends the bot's own messages (MCP loop) or private threads.
9. **Watched-channel auto-start**: every message in an auto-start channel reaches `Bot.autoStart`. Authors need `start_tasks` and their role limits apply, except in Administrator-set "anyone" channels, where members without it get the guild's watch limits (`watchLimits`). Private threads and bots never auto-start.

## Assets (user: all equally important)
- Each guild's Devin service-user API key (encrypted in `guild_devin`) and the host `MASTER_KEY` (derives AES and cookie HMAC keys), `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`.
- Each guild's Devin org access: creating sessions, messaging/stopping them, impersonating mapped Devin users.
- Discord channel content the bot can read, especially channels and threads not visible to `@everyone`.
- MCP tokens and per-task keys (only hashes stored), web session IDs (hash stored) and CSRF tokens.
- ACU spend and per-role limits (max ACU per task, tasks/day, concurrent tasks).
- Integrity of guild settings and the audit log.

## Attackers (user: all of them matter)
- Admins/members of **another guild** using the same hosted bot (cross-tenant).
- **Ordinary members** of a guild the bot is in (privilege escalation past role rules, limits, thread visibility).
- **Anonymous internet** users reaching the web UI or `/mcp` via the tunnel.
- **Prompt injection** in Discord message content, names, attachments that reaches Devin.
- A **compromised or misbehaving Devin session** calling MCP with a valid token/task key.

## Existing controls
- CSP without `script-src` (`default-src 'none'`), `frame-ancestors 'none'`, `referrer-policy same-origin` (`secureHeaders` in `src/web/app.ts`).
- Signed session cookie; only `sha256` of session IDs, MCP tokens and task keys stored; `safeEqual`/`timingSafeEqual` comparisons.
- OAuth `state` bound to a signed cookie (`src/web/oauth.ts`), scopes `identify guilds`.
- AES-256-GCM with HKDF-derived keys and guild-ID AAD (`src/crypto.ts`); `MASTER_KEY` ≥ 32 chars.
- `PUBLIC_URL` must be https (except localhost) (`src/config.ts`).
- Container runs as `node`, production deps only; CI has `contents: read`.
- Devin key verified with read-only calls before save, never shown again.

## Out of scope / accepted risk
- User: nothing is out of scope; every attacker and asset matters, including DoS, host-level issues and Discord Administrators within their own guild.

## Open questions
- None outstanding.
