# devin4discord

[![Website](https://img.shields.io/badge/Website-devin4discord.com-5865F2?style=for-the-badge)](https://devin4discord.com) [![Docs](https://img.shields.io/badge/Docs-Read%20the%20guide-5865F2?style=for-the-badge)](https://devin4discord.com/docs) [![Join the Discord community](https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white&style=for-the-badge)](https://discord.gg/Hvys84HkCd)

Hand Discord messages to Devin and follow the work in a Discord thread. One hosted bot serves any number of Discord servers; each server connects its own Devin organization and picks who may use it in a web UI.

**[Add it to your server at devin4discord.com](https://devin4discord.com)** · [Docs](https://devin4discord.com/docs) · [Discord community](https://discord.gg/Hvys84HkCd)

## Features

- **Start from any message:** `@Devin`, a 🤖 reaction, **Apps → Send to Devin** or `/devin start`.
- **One thread per task:** Devin replies like any member, with images inline, plus PR links and pings.
- **Reply in the thread:** your messages and screenshots go straight to Devin.
- **Stop, sleep, merge and review** from Discord, with buttons and `/devin` commands.
- **Run tasks as yourself** with `/devin link`.
- **Watched channels:** auto-start tasks, or send every message to a Devin Automation.
- **Roles and limits:** who can start, reply, stop, merge or configure, plus ACU and task caps.
- **MCP server:** Devin reads and posts in Discord itself, with images, buttons, reactions, threads and polls.
- **Your org, your key:** each server connects its own Devin organization. Everything is audited.

Contents: [Using it](#using-it) · [Who can do what](#who-can-do-what) · [Watched channels](#watched-channels) · [Devin MCP server](#devin-mcp-server) · [Hosting it](#hosting-it) · [Development](#development) · [Devin API calls](#devin-api-calls)

## Using it

- **Start a task** in one of four ways:
  - Mention the bot: `@Devin fix the login page`. The thread opens on that message.
  - React to a message with 🤖.
  - Right-click a message → Apps → **Send to Devin**.
  - Run `/devin start task:<…>`.

  Devin gets the message text, its images and files, a link back to it and who asked. With a mention, Devin also gets the message being replied to (if any) and the last 10 messages in the channel (set per server on the **Channels** page). That context is marked UNTRUSTED in the prompt: Devin uses it as background and is told never to follow instructions in it. Only the requester's own message counts as instructions. Role mentions and `@everyone` don't trigger the bot.
- **Follow along:** the bot opens a thread per task and posts Devin's messages, PR links and status changes there. Devin's messages are posted as plain messages from the bot, so it reads like any member talking. Files Devin attaches to a message (charts, screenshots, reports) are uploaded to Discord with it; one over 10 MB or one the key can't download is named with a link to the session instead. The member who started the task is added to the thread and pinged on new PRs and when Devin needs a reply. When Devin's own message links a new PR, the ping goes on that message and the bot doesn't post the link again.
- **Give feedback:** type in the thread, images included. Messages from members allowed to reply are forwarded to Devin (marked 📨). Messages that start with `//` are not forwarded. Mentioning the bot in a task thread is a reply, not a new task. For busy threads, turn on **Only forward messages that @mention Devin** on the **Channels** page.
- **Stop or sleep:** `@Devin stop` / `@Devin sleep` in the thread, the **Stop** / **Sleep** buttons on the bot's first message in the thread, or `/devin stop` / `/devin sleep`. Stop ends the Devin session for good and the thread stops syncing. Sleep pauses it; the next forwarded reply wakes Devin. The bot posts who did it in the thread and writes it to the audit log. Members who aren't allowed get a private "you can't do that".
- **Overview:** `/devin status` inside a thread, `/devin list` anywhere (only tasks in threads you can see).
- **Merge:** `/devin merge` in a task thread merges its pull request (the newest open one) once all its checks have passed, with the repo's merge method. For another PR, pass `pr:42` (same repo as the thread's PR, or the only default repo) or a full PR URL. The bot merges with the GitHub token saved on the **Devin** page, so Devin itself needs no merge rights; branch protection still applies. Needs **Merge PRs**.
- **Review:** `/devin review` in a task thread starts a Devin Review of its newest pull request; `pr:` picks another one the same way. Findings show up on the PR. Needs Start tasks or Manage tasks.
- **Link your Devin account:** `/devin link` (needs Start tasks) privately gives you a one-time code and a prompt to paste into a new session you start in the Devin web app, signed in as yourself; then click the button under the reply. The bot finds a web app session created by a Devin user (not a service user) after the code was issued whose first message holds the code, and maps you to that user on the Devin page's "Run as Devin users" list, so your tasks and replies are created as you (this needs `ImpersonateOrgSessions` on the service user; without it Devin refuses those tasks with a 403, and the bot says to add it or `/devin unlink`). Codes expire after 30 minutes; one Devin user links to one Discord member; `/devin unlink` undoes it. Both are audited.

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

The tools come in groups. **What Devin can do** on the MCP page switches any group but reading off (all on by default); switched-off tools disappear from Devin's tool list and are refused if called. Only Discord Administrators can change it, and it's audited.

| Group | Tools | Does |
| --- | --- | --- |
| Read Discord (always on) | `read_task_thread`, `list_channels`, `read_channel`, `get_message` | Read the task's thread, list the channels it may use, read an allowed channel or one of its threads (for a forum, list its posts), read one message. Card text, embeds, replies, reactions and poll votes are included |
| Post messages | `post_to_task_thread`, `post_to_channel` | Post in the task's thread or an allowed channel; in a forum, start a post (title and tags) or reply in one. Optional `files` (images and files), `buttons` (clickable link buttons) and `reply_to` |
| Edit and delete its own posts | `edit_message`, `delete_message` | Change or remove a message the bot posted, including Devin's own replies. Messages that start a thread stay |
| Reactions | `add_reaction`, `remove_reaction` | Add or remove the bot's own reaction |
| Threads and pins | `start_thread`, `pin_message` | Open a public thread in an allowed text channel (on a message or on its own); pin or unpin in the task's thread |
| Polls | `create_poll` | Post a Discord poll (2–10 answers, 1 hour to 32 days) |
| Ping the requester | `ping_requester` on `post_to_task_thread` | Ping the member who started the task |

**Where it can act**

- The token decides which server a call is for. The MCP page has separate **Read** and **Post** channel lists.
- Read defaults to the Channels tab's Allowed list, or channels `@everyone` can see when that's empty too. Post defaults to none.
- Read and Post can each switch from **Custom** to **Bot's Discord permissions**: every channel and public thread the bot's role can read (View Channel + Read Message History) or post in (Send Messages), including ones created later. Only Discord Administrators can switch it, and it's audited.
- Post covers everything that writes: posting, reactions, edits and deletes, threads and polls. With none ticked, Devin can only do these in its own task thread.
- Private threads are never readable or postable. Other tasks' threads are only readable when their channel is on the Read list, and only their own task can edit, react or post polls in them.

**Task keys and safety**

- Each task started while the server has a token gets its own MCP task key in its prompt (only a hash is stored). `task_key` picks the task's own thread, so a session can only reach its own thread. Stopped tasks can't post, edit or poll.
- Nothing pings anyone, except `ping_requester` in the task's own thread.
- `edit_message` and `delete_message` only touch messages the bot posted.
- `buttons` only take http(s) links (up to 5, labels up to 80 characters).
- `files` only take Devin attachment URLs (`…/attachments/<id>/<name>`, up to 10, 10 MB each). The bot downloads them with the server's own Devin key and ignores the URL's host, so they can't make it fetch anything else.
- Everything read is returned inside an UNTRUSTED block, the same as mention context. `/devin list` only shows task threads the member can see in Discord.
- The endpoint speaks Streamable HTTP with JSON responses (`POST` only; `GET` returns 405) and rejects requests whose `Origin` isn't `PUBLIC_URL`.

`PUBLIC_URL` is the MCP URL too, so on a quick tunnel you have to update it in Devin whenever the tunnel URL changes.

## Hosting it

`.env` holds only host settings; everything per server is stored in SQLite, with Devin keys encrypted (AES-256-GCM, key derived from `MASTER_KEY`). Server settings are kept until changed. Activity data is pruned hourly: audit log entries after 30 days, finished or stopped tasks 30 days after their last activity (replies in those threads no longer reach Devin), and expired web sign-ins.

1. **Discord app.** Create one at https://discord.com/developers/applications. Use a separate app for this bot: on start-up it replaces the app's commands.
   - **Bot:** reset and copy the token. Enable **Message Content Intent**.
   - **OAuth2:** copy the client ID and client secret. Under **Redirects** add `<PUBLIC_URL>/auth/callback`, e.g. `https://devin.example.com/auth/callback`.
   - **Installation:** set the install link to **None**. Servers add the bot from the setup UI's **Add to Discord** button, which asks for View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Create Private Threads, Read Message History, Add Reactions, Embed Links, Pin Messages and Create Polls. Servers that added the bot before pins and polls existed can give its role **Pin Messages** and **Create Polls** in Discord, or add it again from the setup UI.
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

### Host admin page

Put your Discord user ID in `ADMIN_USER_IDS` in `.env` (comma-separated for several; copy it in Discord with Developer Mode on → right-click your name → **Copy User ID**), restart the bridge and sign in: an **Admin** link appears in the header and opens `<PUBLIC_URL>/admin`. Everyone else gets a 404 there. The page reads straight from the database and the running process:

- **Needs attention:** Discord disconnected, errors in the last hour, a failed or missing data cleanup, low disk space, a large database, free space a `VACUUM` would reclaim, a large write-ahead log, high memory, many active tasks (each is polled from Devin every interval), tasks active for over 7 days, and servers that removed the bot but still have a Devin key stored.
- **Usage:** tasks started in the last 24 hours, 7 and 30 days, with distinct members and servers, the share that opened a PR, tasks per day, active tasks by status and audit-log actions.
- **Servers:** how many servers have the bot, how many are connected to Devin and which features they use, and the most active servers.
- **Database:** file, write-ahead log and free disk sizes, and rows and bytes per table.
- **Host:** uptime, memory, Discord ping, the last cleanup and the last 24 hours of logged errors, grouped.

Usage covers at most the 30 days that activity data is kept. Errors and uptime are held in memory and reset on restart.

Run exactly one copy per bot token. Two copies would both relay every message.

### Deploying updates automatically

To redeploy whenever something is merged to `main`, install the deploy timer once from the checkout on the host:

```sh
sudo sh deploy/install-auto-deploy.sh
journalctl -u devin4discord-deploy -f
```

Every minute, [`deploy/auto-deploy.sh`](deploy/auto-deploy.sh) fetches `origin/main`. When there's a new commit and every GitHub Actions check on it has passed, it fast-forwards the checkout and runs `docker compose up -d --build`. A commit whose CI failed is skipped, and a commit whose CI is still running is retried on the next run. Nothing needs to reach the host from outside, and no secrets are involved. The checkout must stay on `main` with no local commits, so keep host settings in `.env` (including `COMPOSE_PROFILES`). Run the script by hand to deploy straight away. If the host shares an IP that hits GitHub's unauthenticated API limit, put `GITHUB_TOKEN=<read-only token>` in `/etc/devin4discord-deploy.env`.

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
| Pass Discord files to Devin (task start and replies) | [`POST /v3/organizations/{org}/attachments`](https://docs.devin.ai/api-reference/v3/attachments/post-organizations-attachments), after downloading the file from Discord's CDN; `attachment_urls` only accepts the Devin URLs this returns. A file that can't be copied is linked in the message text instead | `UseDevinSessions` |
| Check a mapped Devin user (on save) | [`GET /v3beta1/organizations/{org}/members/users/{id}`](https://docs.devin.ai/api-reference/v3/users/get-organization-user) | `ViewOrgMembership` |
| Follow a task | `GET …/sessions/{id}`, `GET …/sessions/{id}/messages` | `ViewOrgSessions` |
| Upload files Devin attached | `GET /v3/organizations/{org}/attachments/{uuid}/{name}`, then the presigned URL it redirects to (without the key) | Not listed in the docs |
| Reply (also wakes a sleeping session) | [`POST …/sessions/{id}/messages`](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages) | `ManageOrgSessions` |
| Stop | [`DELETE …/sessions/{id}`](https://docs.devin.ai/api-reference/v3/sessions/delete-organizations-sessions) | Its creator, or `ManageOrgSessions` |
| Sleep | [`POST …/sessions/{id}/archive`](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-archive) | `ManageOrgSessions` |
| Devin Review (`/devin review`) | `POST /v3/organizations/{org}/pr-reviews` | Not listed in the docs |
| Wake after sleep | [`POST …/sessions/{id}/unarchive`](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-unarchive), after the reply | `ManageOrgSessions` |

v3 has no sleep-only call. Archive is documented as "archive session and put it to sleep if currently running", and a message to a sleeping archived session resumes it, so Sleep archives the session and the next reply unarchives it. A stopped session can't be resumed. Sessions created for a mapped Devin user aren't created by the service user, so stopping them also needs `ManageOrgSessions`.
