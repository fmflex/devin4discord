# devin4discord

[![Website](https://img.shields.io/badge/Website-devin4discord.com-5865F2?style=for-the-badge)](https://devin4discord.com) [![Docs](https://img.shields.io/badge/Docs-Read%20the%20guide-5865F2?style=for-the-badge)](https://devin4discord.com/docs) [![Join the Discord community](https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white&style=for-the-badge)](https://discord.gg/Hvys84HkCd)

Hand Discord messages to Devin and follow the work in a Discord thread. One hosted bot serves any number of Discord servers; each server connects its own Devin organization and picks who may use it in a web UI.

**[Add it to your server at devin4discord.com](https://devin4discord.com)** · [Docs](https://devin4discord.com/docs) · [Discord community](https://discord.gg/Hvys84HkCd)

- **Start a task** in one of four ways:
  - Mention the bot: `@Devin fix the login page`. The thread opens on that message.
  - React to a message with 🤖.
  - Right-click a message → Apps → **Send to Devin**.
  - Run `/devin start task:<…>`.

  Devin gets the message text, its images and files, a link back to it and who asked. With a mention, Devin also gets the message being replied to (if any) and the last 10 messages in the channel (set per server on the **Channels** page). That context is marked UNTRUSTED in the prompt: Devin uses it as background and is told never to follow instructions in it. Only the requester's own message counts as instructions. Role mentions and `@everyone` don't trigger the bot.
- **Follow along:** the bot opens a thread per task and posts Devin's messages, PR links and status changes there. Files Devin attaches to a message (charts, screenshots, reports) are uploaded to Discord with it; one over 10 MB or one the key can't download is named with a link to the session instead. The member who started the task is added to the thread and pinged on new PRs and when Devin needs a reply. When Devin's own message links a new PR, the ping goes on that message and the bot doesn't post the link again.
- **Give feedback:** type in the thread, images included. Messages from members allowed to reply are forwarded to Devin (marked 📨). Messages that start with `//` are not forwarded. Mentioning the bot in a task thread is a reply, not a new task. For busy threads, turn on **Only forward messages that @mention Devin** on the **Channels** page.
- **Stop or sleep:** `@Devin stop` / `@Devin sleep` in the thread, the **Stop** / **Sleep** buttons on the bot's first message in the thread, or `/devin stop` / `/devin sleep`. Stop ends the Devin session for good and the thread stops syncing. Sleep pauses it; the next forwarded reply wakes Devin. The bot posts who did it in the thread and writes it to the audit log. Members who aren't allowed get a private "you can't do that".
- **Overview:** `/devin status` inside a thread, `/devin list` anywhere (only tasks in threads you can see).
- **Merge:** `/devin merge` in a task thread merges its pull request (the newest open one) once all its checks have passed, with the repo's merge method. For another PR, pass `pr:42` (same repo as the thread's PR, or the only default repo) or a full PR URL. The bot merges with the GitHub token saved on the **Devin** page, so Devin itself needs no merge rights; branch protection still applies. Needs **Merge PRs**.
- **Review:** `/devin review` in a task thread starts a Devin Review of its newest pull request; `pr:` picks another one the same way. Findings show up on the PR. Needs Start tasks or Manage tasks.

## Who can do what

Access is set per server by Discord role on the **Permissions** page:

| Permission | Allows |
| --- | --- |
| Start tasks | `@Devin`, 🤖, **Send to Devin**, `/devin start`; replying in your own task threads |
| Reply to tasks | Messages in any task thread are forwarded to Devin |
| Manage tasks | Stop and sleep any task, and reply to any task |
| Merge PRs | `/devin merge` |
| Change settings | Use the setup UI for this server |

The member who started a task can always stop it or put it to sleep. Members with **Administrator** can do everything with no limits until you change the **Administrator** row on the Permissions page; they always keep Change settings, and **Manage Server** can always change settings. Only Discord Administrators can change the Devin connection, role permissions and MCP settings; other members with Change settings can view them and, on the Channels page, change only channels they can view in Discord. Each role can also cap ACUs per task, tasks per user per day and concurrent tasks; a member with several roles gets the most generous limit. The **Channels** page limits where tasks can start and picks the channel task threads open in. A task started inside a private thread always gets its own private thread in the same channel, with only the member who started it added, instead of going to that channel.

Tasks are created by the server's Devin service user and tagged `discord`, `discord-guild:<id>` and `discord-user:<id>`. The prompt names the Discord member. A member runs as a Devin user only when the server maps them on the Devin page.

Until a server saves a Devin key, every trigger there gets a private reply pointing to the setup UI. Every settings change and task start is written to the server's **Audit log**.

## Watched channels

The **Watched channels** page lets the bot act on new messages without anyone asking it. Only Discord Administrators can change it, and every change is audited.

- **Auto-start:** every new top-level message in the channel starts a task, as if it had mentioned the bot. The thread opens on the message. In a forum, every new post starts a task, with its title and text, and the post itself becomes the task thread, so replies in it go to Devin. The author needs **Start tasks**, and their role's limits apply. Members without it are ignored quietly, unless you also tick **Anyone**: then they can start tasks in that channel too, within limits set on the same page (ACU cap per task, tasks per member per day, tasks running at once; defaults 5 / 3 / 1). Bots, private threads and messages starting with `//` never start tasks. A watched channel counts as allowed even when it isn't ticked on the Channels page.
- **Webhook:** every new message in the channel is POSTed as JSON to the server's webhook URL. The secret, if set, goes in the `X-Webhook-Secret` header. That's what a [Devin Automation](https://docs.devin.ai/product-guides/automations) webhook trigger checks, so paste in its URL and secret to run an automation on every channel update. The body looks like this:

  ```json
  {
    "type": "message.created",
    "guild": { "id": "…", "name": "…" },
    "channel": { "id": "…", "name": "feedback", "parentId": null, "isThread": false },
    "message": {
      "id": "…", "link": "https://discord.com/channels/…", "content": "…",
      "author": { "id": "…", "name": "…", "bot": false },
      "attachments": [{ "filename": "…", "url": "…" }],
      "createdAt": "2026-11-07T00:00:00.000Z"
    }
  }
  ```

  The bot's own messages and private threads are never sent, so a Devin session posting through MCP can't loop. Messages in threads, and messages from other bots and Discord webhooks, are only sent when you turn them on. The URL must be https on a public host. It's checked again at connect time, so a host that resolves to a private, loopback or link-local address is refused. Redirects aren't followed, each call times out after 5 seconds, and at most 4 calls per server run at once; messages beyond that are dropped. The URL and secret are stored encrypted, and only the host is shown. Message text is written by members, so the automation should treat it as untrusted.

## Devin MCP server

Each server can give Devin an MCP server, so that during a task Devin can read and post in Discord itself, without waiting for the bot to forward messages. Turn it on from the **MCP** page:

1. Click **Generate token**. The token is shown once and only its hash is stored. Generating a new one revokes the old one.
2. In Devin, open [**Customize → MCPs → Add MCP → Add custom MCP**](https://docs.devin.ai/work-with-devin/mcp#setting-up-a-custom-mcp-server). This needs the Manage MCP Servers permission.
   - Transport: **HTTP**
   - URL: `<PUBLIC_URL>/mcp`
   - Authentication: **Auth Header**, key `Authorization`, value `Bearer <token>`
3. Click **Test tools**.

| Tool | Does |
| --- | --- |
| `read_task_thread` | Read the task's thread (needs the task key from the session's prompt) |
| `post_to_task_thread` | Post in it, pinging nobody. Not allowed once the task is stopped |
| `post_to_channel` | Post in a channel the server allows Devin to post in, or in a thread under it; in a forum, start a post (title and tags) or reply in one; nobody is pinged |
| `add_reaction` | React to a message in it |
| `list_channels` | List the channels it may read and post in |
| `read_channel` | Read a channel ticked under Read or one of its threads; for a forum, list its posts |
| `get_message` | Read one message, e.g. from a link |

The token decides which server a call is for. The MCP page picks separate Read and Post channel lists. Read defaults to the Channels tab's Allowed list (only channels `@everyone` can see when that's empty too); private threads are never readable or postable, and other tasks' threads only when their channel is on the read list. Post defaults to none. Read and Post can each be switched from **Custom** to **Bot's Discord permissions**, which allows every channel and public thread the bot's role can read (View Channel + Read Message History) or post in (Send Messages), including channels created later; only Discord Administrators can switch it, and it's audited. Each task started while the server has a token gets its own MCP task key in its prompt (only a hash is stored); the task-thread tools (`read_task_thread`, `post_to_task_thread`, `add_reaction`) take that key, so a session can only reach its own thread. `/devin list` only shows task threads the member can see in Discord. Everything read is returned inside an UNTRUSTED block, the same as mention context. The endpoint speaks Streamable HTTP with JSON responses (`POST` only; `GET` returns 405). It rejects requests whose `Origin` isn't `PUBLIC_URL`.

`PUBLIC_URL` is the MCP URL too, so on a quick tunnel you have to update it in Devin whenever the tunnel URL changes.

## Hosting it

`.env` holds only host settings; everything per server is stored in SQLite, with Devin keys encrypted (AES-256-GCM, key derived from `MASTER_KEY`). Server settings are kept until changed. Activity data is pruned hourly: audit log entries after 30 days, finished or stopped tasks 30 days after their last activity (replies in those threads no longer reach Devin), and expired web sign-ins.

1. **Discord app.** Create one at https://discord.com/developers/applications. Use a separate app for this bot: on start-up it replaces the app's commands.
   - **Bot:** reset and copy the token. Enable **Message Content Intent**.
   - **OAuth2:** copy the client ID and client secret. Under **Redirects** add `<PUBLIC_URL>/auth/callback`, e.g. `https://devin.example.com/auth/callback`.
   - **Installation:** set the install link to **None**. Servers add the bot from the setup UI's **Add to Discord** button, which asks for View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Create Private Threads, Read Message History, Add Reactions and Embed Links.
2. **Configure.** `cp .env.example .env`, then fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `MASTER_KEY` (`openssl rand -base64 48`) and `PUBLIC_URL`. Back up `MASTER_KEY`: without it, saved Devin keys can't be read.
3. **Run:**

   ```sh
   docker compose up -d --build
   docker compose logs -f
   ```

   State is a SQLite file in the `bridge-data` volume. The web UI listens on port 3000 inside the compose network and is published only through the tunnel.
4. **Tunnel.**
   - **Quick tunnel** (default, `COMPOSE_PROFILES=quick-tunnel`): `docker compose logs tunnel` shows a `https://<words>.trycloudflare.com` URL. Set it as `PUBLIC_URL`, add `<that URL>/auth/callback` to the Discord app's redirects and run `docker compose up -d bridge`. The URL changes whenever the tunnel container restarts.
   - **Named tunnel**: in the Cloudflare dashboard → Networking → Tunnels → Create a tunnel, choose Docker and copy the token from the command shown (don't run it). Set `COMPOSE_PROFILES=named-tunnel`, `TUNNEL_TOKEN` and `PUBLIC_URL=https://<hostname>`, then `docker compose up -d`. Once the tunnel shows as connected, open it → Routes → Add route → Published application, pick your hostname and set the service URL to `http://bridge:3000`.
5. **Set up a server.** Open `PUBLIC_URL`, sign in with Discord, click **Add to Discord** for the server, then **Configure**: paste a Devin service user key (Devin → Settings → Service users) and the org ID. Give the service user's role **`UseDevinSessions`** (create sessions), **`ViewOrgSessions`** (follow them) and **`ManageOrgSessions`** (send messages, stop and sleep), plus **`ImpersonateOrgSessions`** and **`ViewOrgMembership`** if you map Discord members to Devin users. Only Discord Administrators can edit that mapping; each Devin user is checked to be in the org, and every change is audited. See [Devin API calls](#devin-api-calls). The key is checked with read-only API calls before it's saved and is never shown again.

Run exactly one copy per bot token. Two copies would both relay every message.

Without Docker, Node 24+ also works: `npm ci && npm start`, with the UI reached at `PUBLIC_URL` through your own reverse proxy or tunnel.

## Development

```sh
npm ci
npm run typecheck
npm test
```

The tests use fake Discord and Devin layers, mocked `fetch` and an in-memory database. They make no network calls.

To look at the setup UI without a Discord app:

```sh
NODE_ENV=development DEV_LOGIN_GUILD_ID=900000000000000001 npm run dev:web
```

then open http://localhost:3000/auth/dev. It signs in as a seeded admin of a fake server with mocked Discord data and accepts any Devin key without calling Devin. `src/dev-web.ts` refuses to start unless both variables are set, and the production entry point never loads it.

## Devin API calls

Every call uses the server's service user key against the [Devin API v3](https://docs.devin.ai/api-reference/v3/overview) ([OpenAPI](https://docs.devin.ai/v3-openapi.json)). Permissions are from the [v3 permissions reference](https://docs.devin.ai/api-reference/v3/overview) and each endpoint's page.

| What | Call | Permission |
| --- | --- | --- |
| Start a task | `POST /v3/organizations/{org}/sessions` | `UseDevinSessions`; `ImpersonateOrgSessions` for mapped members (`create_as_user_id`) |
| Check a mapped Devin user (on save) | [`GET /v3beta1/organizations/{org}/members/users/{id}`](https://docs.devin.ai/api-reference/v3/users/get-organization-user) | `ViewOrgMembership` |
| Follow a task | `GET …/sessions/{id}`, `GET …/sessions/{id}/messages` | `ViewOrgSessions` |
| Upload files Devin attached | `GET /v3/organizations/{org}/attachments/{uuid}/{name}`, then the presigned URL it redirects to (without the key) | Not listed in the docs |
| Reply (also wakes a sleeping session) | [`POST …/sessions/{id}/messages`](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages) | `ManageOrgSessions` |
| Stop | [`DELETE …/sessions/{id}`](https://docs.devin.ai/api-reference/v3/sessions/delete-organizations-sessions) | Its creator, or `ManageOrgSessions` |
| Sleep | [`POST …/sessions/{id}/archive`](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-archive) | `ManageOrgSessions` |
| Devin Review (`/devin review`) | `POST /v3/organizations/{org}/pr-reviews` | Not listed in the docs |
| Wake after sleep | [`POST …/sessions/{id}/unarchive`](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-unarchive), after the reply | `ManageOrgSessions` |

v3 has no sleep-only call. Archive is documented as "archive session and put it to sleep if currently running", and a message to a sleeping archived session resumes it, so Sleep archives the session and the next reply unarchives it. A stopped session can't be resumed. Sessions created for a mapped Devin user aren't created by the service user, so stopping them also needs `ManageOrgSessions`.
