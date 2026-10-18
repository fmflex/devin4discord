# devin4discord

Hand Discord messages to a coding agent and follow the work in a Discord thread.
Devin is the first supported agent. Others can be added as adapters.

- **Start a task** in one of three ways:
  - React to a message with 🤖.
  - Right-click a message → Apps → **Send to Devin**.
  - Run `/agent start task:<…>`.

  The agent gets the message text, its images and files, and a link back to it.
- **Follow along:** the bot opens a thread per task and posts the agent's messages, PR links and status changes there. The admin who started the task is added to the thread and pinged on new PRs and when the agent needs a reply.
- **Give feedback:** just type in the thread, images included. Admin messages are forwarded to the agent (marked 📨). Messages that start with `//` are not forwarded.
- **Overview:** `/agent status` inside a thread, `/agent list` anywhere.

Only members with Administrator, or one of `ALLOWED_ROLE_IDS`, can trigger anything. Agent keys stay in your own `.env`, and each team runs its own copy.

## Setup

1. **Discord app.** Create one at https://discord.com/developers/applications.
   - **Bot:** copy the token and enable **Message Content Intent**.
   - **Installation:** use the `bot` and `applications.commands` scopes, with these permissions:
     - View Channels
     - Send Messages
     - Send Messages in Threads
     - Create Public Threads
     - Read Message History
     - Add Reactions
   - Invite the bot to your server.

   Use a separate Discord application for this bot. On start-up it replaces the application's commands, so sharing a token with another bot would delete that bot's commands.
2. **Agent key.** For Devin: Settings → Devin API → Service users. Create a user with permission to create, view and message sessions, then note its key and your org ID.
3. **Configure.** Run `cp .env.example .env` and fill in `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `DEVIN_API_KEY` and `DEVIN_ORG_ID`. Everything else is optional and documented in `.env.example`.
4. **Run:**

   ```sh
   docker compose up -d --build
   docker compose logs -f
   ```

   The bot registers its commands on start-up. State is a SQLite file in the `bridge-data` volume.

Without Docker, Node 24+ also works: `npm ci && npm start`.

## Hosting

The bot keeps an outgoing connection to Discord open and polls the agent's API. It needs no open ports, domain or HTTPS, but it must run all the time. Serverless platforms like Lambda or Vercel functions don't fit.

| Where | Rough cost | Notes |
| --- | --- | --- |
| Railway / Fly.io / Render | ~$5/mo | Deploy from the Dockerfile and mount a volume at `/data`. |
| AWS EC2 `t4g.nano` / Lightsail | ~$3–5/mo | Install Docker, then `docker compose up -d`. You patch the OS. |
| Any always-on machine | free | Home server, Raspberry Pi (arm64 works), an existing VPS. |

Run exactly one copy per bot token. Two copies would both relay every message.

## Adding an agent

Implement `AgentAdapter` from `src/agents/types.ts`:

- `startTask`
- `sendMessage`
- `getUpdate` (new messages after a cursor, status and PR URLs)

Then add a case for it in `loadAgent` in `src/config.ts`. Use `src/agents/devin.ts` as the reference.

## Development

```sh
npm ci
npm run typecheck
npm test
```

The tests use a fake agent, a fake Discord layer and an in-memory database. They make no network calls.
