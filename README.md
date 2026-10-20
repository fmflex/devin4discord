# devin4discord

Hand Discord messages to Devin and follow the work in a Discord thread. One hosted bot serves any number of Discord servers; each server connects its own Devin organization and picks who may use it in a web UI.

- **Start a task** in one of four ways:
  - Mention the bot: `@Devin fix the login page`. The thread opens on that message.
  - React to a message with 🤖.
  - Right-click a message → Apps → **Send to Devin**.
  - Run `/devin start task:<…>`.

  Devin gets the message text, its images and files, a link back to it and who asked. With a mention, Devin also gets the message being replied to (if any) and the last 10 messages in the channel (set per server on the **Channels** page). That context is marked UNTRUSTED in the prompt: Devin uses it as background and is told never to follow instructions in it. Only the requester's own message counts as instructions. Role mentions and `@everyone` don't trigger the bot.
- **Follow along:** the bot opens a thread per task and posts Devin's messages, PR links and status changes there. The member who started the task is added to the thread and pinged on new PRs and when Devin needs a reply.
- **Give feedback:** type in the thread, images included. Messages from members allowed to reply are forwarded to Devin (marked 📨). Messages that start with `//` are not forwarded. Mentioning the bot in a task thread is a reply, not a new task. For busy threads, turn on **Only forward messages that @mention Devin** on the **Channels** page.
- **Stop or sleep:** `@Devin stop` / `@Devin sleep` in the thread, the **Stop** / **Sleep** buttons on the bot's first message in the thread, or `/devin stop` / `/devin sleep`. Stop ends the Devin session for good and the thread stops syncing. Sleep pauses it; the next forwarded reply wakes Devin. The bot posts who did it in the thread and writes it to the audit log. Members who aren't allowed get a private "you can't do that".
- **Overview:** `/devin status` inside a thread, `/devin list` anywhere (only tasks in threads you can see).

## Who can do what

Access is set per server by Discord role on the **Permissions** page:

| Permission | Allows |
| --- | --- |
| Start tasks | `@Devin`, 🤖, **Send to Devin**, `/devin start`; replying in your own task threads |
| Reply to tasks | Messages in any task thread are forwarded to Devin |
| Manage tasks | Stop and sleep any task, and reply to any task |
| Change settings | Use the setup UI for this server |

The member who started a task can always stop it or put it to sleep. Members with **Administrator** can do everything with no limits until you change the **Administrator** row on the Permissions page; they always keep Change settings, and **Manage Server** can always change settings. Each role can also cap ACUs per task, tasks per user per day and concurrent tasks; a member with several roles gets the most generous limit. The **Channels** page limits where tasks can start and picks the channel task threads open in.

Tasks are created by the server's Devin service user and tagged `discord`, `discord-guild:<id>` and `discord-user:<id>`. The prompt names the Discord member. A member runs as a Devin user only when the server maps them on the Devin page.

Until a server saves a Devin key, every trigger there gets a private reply pointing to the setup UI. Every settings change and task start is written to the server's **Audit log**.

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
| `read_task_thread` | Read the task's thread (needs the Devin session ID) |
| `post_to_task_thread` | Post in it, pinging nobody. Not allowed once the task is stopped |
| `post_to_channel` | Post in a channel the server allows Devin to post in, or in a thread under it; nobody is pinged |
| `add_reaction` | React to a message in it |
| `list_channels` | List the channels it may read and post in |
| `read_channel` | Read a channel ticked under Read or one of its threads |
| `get_message` | Read one message, e.g. from a link |

The token decides which server a call is for. The MCP page picks separate Read and Post channel lists. Read defaults to the Channels tab's Allowed list (every channel when that's empty); Post defaults to none. Task threads are always readable and postable through the task-thread tools. Everything read is returned inside an UNTRUSTED block, the same as mention context. The endpoint speaks Streamable HTTP with JSON responses (`POST` only; `GET` returns 405). It rejects requests whose `Origin` isn't `PUBLIC_URL`.

`PUBLIC_URL` is the MCP URL too, so on a quick tunnel you have to update it in Devin whenever the tunnel URL changes.

## Hosting it

`.env` holds only host settings; everything per server is stored in SQLite, with Devin keys encrypted (AES-256-GCM, key derived from `MASTER_KEY`).

1. **Discord app.** Create one at https://discord.com/developers/applications. Use a separate app for this bot: on start-up it replaces the app's commands.
   - **Bot:** reset and copy the token. Enable **Message Content Intent**.
   - **OAuth2:** copy the client ID and client secret. Under **Redirects** add `<PUBLIC_URL>/auth/callback`, e.g. `https://devin.example.com/auth/callback`.
   - **Installation:** set the install link to **None**. Servers add the bot from the setup UI's **Add to Discord** button, which asks for View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions and Embed Links.
2. **Configure.** `cp .env.example .env`, then fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `MASTER_KEY` (`openssl rand -base64 48`) and `PUBLIC_URL`. Back up `MASTER_KEY`: without it, saved Devin keys can't be read.
3. **Run:**

   ```sh
   docker compose up -d --build
   docker compose logs -f
   ```

   State is a SQLite file in the `bridge-data` volume. The web UI listens on port 3000 inside the compose network and is published only through the tunnel.
4. **Tunnel.**
   - **Quick tunnel** (default, `COMPOSE_PROFILES=quick-tunnel`): `docker compose logs tunnel` shows a `https://<words>.trycloudflare.com` URL. Set it as `PUBLIC_URL`, add `<that URL>/auth/callback` to the Discord app's redirects and run `docker compose up -d bridge`. The URL changes whenever the tunnel container restarts.
   - **Named tunnel**: in Cloudflare Zero Trust → Networks → Tunnels, create a tunnel with a public hostname pointing to `http://bridge:3000`. Set `COMPOSE_PROFILES=named-tunnel`, `TUNNEL_TOKEN` and `PUBLIC_URL=https://<hostname>`, then `docker compose up -d`.
5. **Set up a server.** Open `PUBLIC_URL`, sign in with Discord, click **Add to Discord** for the server, then **Configure**: paste a Devin service user key (Devin → Settings → Service users) and the org ID. Give the service user's role **`UseDevinSessions`** (create sessions), **`ViewOrgSessions`** (follow them) and **`ManageOrgSessions`** (send messages, stop and sleep), plus **`ImpersonateOrgSessions`** if you map Discord members to Devin users. See [Devin API calls](#devin-api-calls). The key is checked with read-only API calls before it's saved and is never shown again.

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
| Follow a task | `GET …/sessions/{id}`, `GET …/sessions/{id}/messages` | `ViewOrgSessions` |
| Reply (also wakes a sleeping session) | [`POST …/sessions/{id}/messages`](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages) | `ManageOrgSessions` |
| Stop | [`DELETE …/sessions/{id}`](https://docs.devin.ai/api-reference/v3/sessions/delete-organizations-sessions) | Its creator, or `ManageOrgSessions` |
| Sleep | [`POST …/sessions/{id}/archive`](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-archive) | `ManageOrgSessions` |
| Wake after sleep | [`POST …/sessions/{id}/unarchive`](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-unarchive), after the reply | `ManageOrgSessions` |

v3 has no sleep-only call. Archive is documented as "archive session and put it to sleep if currently running", and a message to a sleeping archived session resumes it, so Sleep archives the session and the next reply unarchives it. A stopped session can't be resumed. Sessions created for a mapped Devin user aren't created by the service user, so stopping them also needs `ManageOrgSessions`.
