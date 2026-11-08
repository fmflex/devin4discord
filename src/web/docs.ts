import { html } from 'hono/html';
import { DEFAULT_INSTRUCTIONS } from '../format.ts';
import { MAX_CONTEXT_MESSAGES } from '../guilds.ts';
import type { WebSession } from './sessions.ts';
import { COMMUNITY_URL, DOCS, REPO_URL, doc, layout } from './views.ts';

type Html = ReturnType<typeof html>;

type Section = { id: string; title: string; body: Html };

const SECTIONS: Section[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    body: html`<p>You need two things: <strong>Administrator</strong> in the Discord server, and a Devin organization with API access.</p>
      <ol class="steps">
        <li><strong>Create a service user in Devin.</strong> Go to <strong>Settings → Devin API → Service users</strong>, create one and copy its key (it starts with <code>cog_</code> and is only shown once). Give its role:
          <ul>
            <li><code>UseDevinSessions</code>: start tasks</li>
            <li><code>ViewOrgSessions</code>: follow them</li>
            <li><code>ManageOrgSessions</code>: send replies, stop and sleep</li>
            <li><code>ImpersonateOrgSessions</code> and <code>ViewOrgMembership</code>: only if you use <a href="#devin-settings">Run as Devin users</a></li>
          </ul>
        </li>
        <li><strong>Add the bot.</strong> Sign in on the home page and click <strong>Add to Discord</strong> next to your server. Discord asks for View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Create Private Threads, Read Message History, Add Reactions and Embed Links. Keep them all. Discord then brings you back here, signed in, to the server's setup.</li>
        <li><strong>Connect Devin.</strong> Click <strong>Configure</strong>, paste the key and your organization ID (<code>org-…</code>, shown on the same Devin API page), and save. The key is checked with a read-only call first.</li>
        <li><strong>Decide who can use it</strong> on the <a href="#permissions">Permissions</a> page. Out of the box, only members with Administrator can start tasks.</li>
        <li><strong>Try it.</strong> In a channel, send <code>@Devin say hi</code>. A thread opens and Devin answers there.</li>
      </ol>
      <p>${doc(DOCS.serviceUsers, 'Devin docs: service users')}</p>`
  },
  {
    id: 'starting-tasks',
    title: 'Starting a task',
    body: html`<p>There are four ways to start one. They all do the same thing.</p>
      <table class="grid">
        <thead><tr><th>How</th><th>Good for</th></tr></thead>
        <tbody>
          <tr><td>Mention: <code>@Devin fix the login redirect</code></td><td>Asking in the flow of a conversation. The thread opens on your message.</td></tr>
          <tr><td>React to a message with 🤖</td><td>Handing over someone else's bug report as-is.</td></tr>
          <tr><td>Right-click a message → <strong>Apps → Send to Devin</strong></td><td>Same as the reaction, without leaving a visible emoji.</td></tr>
          <tr><td><code>/devin start task:… file:…</code></td><td>A fresh request, with an optional file attached.</td></tr>
        </tbody>
      </table>
      <p>Devin gets the message text, its images and files, a link back to the message and who asked. With a mention, it also gets the message you replied to and the last few messages in the channel (up to ${MAX_CONTEXT_MESSAGES}, set on the <a href="#channels">Channels</a> page).</p>
      <p>That extra context is marked <strong>untrusted</strong>: Devin reads it as background and is told never to follow instructions in it. Only the person who asked gives orders. Role mentions and <code>@everyone</code> don't trigger the bot.</p>
      <p>If the server isn't connected to Devin yet, or you don't have permission, the bot replies privately and nothing is started.</p>`
  },
  {
    id: 'threads',
    title: 'Task threads',
    body: html`<p>Every task gets its own thread. The bot posts Devin's messages, PR links and status changes there, and adds whoever asked to the thread.</p>
      <ul class="steps">
        <li><strong>Pings:</strong> the person who asked is pinged when Devin opens a PR or is waiting on an answer. Nothing else pings.</li>
        <li><strong>Replying:</strong> just type in the thread. Messages from members allowed to reply go to Devin, images included, and get a 📨 reaction once delivered.</li>
        <li><strong>Side chat:</strong> start a message with <code>//</code> and it stays in Discord.</li>
        <li><strong>Busy threads:</strong> turn on <strong>Only forward messages that @mention Devin</strong> on the Channels page. Then only messages with <code>@Devin</code> reach Devin.</li>
        <li><strong>Mentions inside a thread</strong> are replies to that task, not new tasks.</li>
      </ul>`
  },
  {
    id: 'stop-sleep',
    title: 'Stop and sleep',
    body: html`<p><strong>Sleep</strong> pauses Devin. The next reply in the thread wakes it up where it left off. Use it when you're waiting on something and don't want it to keep running.</p>
      <p><strong>Stop</strong> ends the Devin session for good. The thread stays, but stops syncing.</p>
      <p>Use the <strong>Stop</strong> / <strong>Sleep</strong> buttons on the bot's first message in the thread, <code>@Devin stop</code> / <code>@Devin sleep</code>, or <code>/devin stop</code> / <code>/devin sleep</code>. The bot says who did it in the thread and in the audit log.</p>
      <p>The person who started a task can always stop or sleep it. Anyone else needs <strong>Manage tasks</strong>.</p>`
  },
  {
    id: 'commands',
    title: 'Slash commands',
    body: html`<table class="grid">
        <thead><tr><th>Command</th><th>Does</th></tr></thead>
        <tbody>
          <tr><td><code>/devin start task:… file:…</code></td><td>Start a task. The file is optional.</td></tr>
          <tr><td><code>/devin status</code></td><td>In a task thread: its status and PRs.</td></tr>
          <tr><td><code>/devin list</code></td><td>Recent tasks, only from threads you can see.</td></tr>
          <tr><td><code>/devin link</code></td><td>Link your Devin account: it gives you a prompt with a one-time code to start in the Devin web app, then a button to finish. Your tasks then run as you in Devin, which needs <code>ImpersonateOrgSessions</code> on the service user.</td></tr>
          <tr><td><code>/devin unlink</code></td><td>Undo the link.</td></tr>
          <tr><td><code>/devin stop</code></td><td>In a task thread: stop the task for good.</td></tr>
          <tr><td><code>/devin sleep</code></td><td>In a task thread: pause it until the next reply.</td></tr>
          <tr><td><code>/devin merge pr:…</code></td><td>In a task thread: merge its PR once its checks pass. <code>pr</code> (a number or URL) picks another PR.</td></tr>
          <tr><td><code>/devin review pr:…</code></td><td>In a task thread: get a Devin Review of its PR. <code>pr</code> picks another PR.</td></tr>
        </tbody>
      </table>`
  },
  {
    id: 'permissions',
    title: 'Permissions and limits',
    body: html`<p>Access is set per Discord role on the <strong>Permissions</strong> page.</p>
      <table class="grid">
        <thead><tr><th>Permission</th><th>Lets the role</th></tr></thead>
        <tbody>
          <tr><td>Start tasks</td><td>Use @Devin, 🤖, Send to Devin and <code>/devin start</code>, and reply in their own task threads.</td></tr>
          <tr><td>Reply to tasks</td><td>Have their messages in any task thread forwarded to Devin.</td></tr>
          <tr><td>Manage tasks</td><td>Stop, sleep and reply to any task.</td></tr>
          <tr><td>Merge PRs</td><td>Merge pull requests with <code>/devin merge</code>.</td></tr>
          <tr><td>Change settings</td><td>Use this site for the server.</td></tr>
        </tbody>
      </table>
      <p>Each role can also have limits: <strong>ACUs per task</strong>, <strong>tasks per day</strong> per member and <strong>tasks running at once</strong> per member. Empty means no limit. Sleeping tasks count as running; stopped and finished ones don't. A member with several roles gets the most generous value of each.</p>
      <p>Members with Discord's <strong>Administrator</strong> permission have their own row. They can do everything with no limits until you change that row. They, and members with <strong>Manage Server</strong>, can always change settings, so nobody gets locked out.</p>
      <p>Only Discord Administrators can change the Devin connection, role permissions and MCP settings. Other members with Change settings can view them, and on the Channels page they can only change channels Discord lets them view.</p>`
  },
  {
    id: 'channels',
    title: 'Channels',
    body: html`<ul class="steps">
        <li><strong>Allowed:</strong> where tasks can be started. Threads inside an allowed channel count too. None ticked means every channel the bot can see.</li>
        <li><strong>Task channel:</strong> where threads open. By default that's the channel the request came from. Pick one channel (say <code>#devin-tasks</code>) to keep them all in one place.</li>
        <li><strong>Context messages:</strong> how many earlier channel messages (0–${MAX_CONTEXT_MESSAGES}) go along with an @Devin mention. Default 10.</li>
        <li><strong>Only forward messages that @mention Devin:</strong> see <a href="#threads">Task threads</a>.</li>
      </ul>
      <p>The bot's Discord role still decides what it can actually see. If it can't view a channel in Discord, nothing here changes that.</p>`
  },
  {
    id: 'watched-channels',
    title: 'Watched channels',
    body: html`<p>Only Discord Administrators can change these. Every change is in the audit log.</p>
      <ul class="steps">
        <li><strong>Auto-start:</strong> every new top-level message in the channel starts a task, no @Devin needed, with the thread on the message. In a forum, every new post starts one and the post becomes the task thread. The author needs <strong>Start tasks</strong> and their role's limits apply; anyone else is ignored quietly.</li>
        <li><strong>Anyone:</strong> with Auto-start, members without Start tasks may start tasks in that channel too, within the limits on the same page (ACU per task, tasks per day, running at once).</li>
        <li><strong>Webhook:</strong> every new message is POSTed as JSON to the server's webhook, with the secret in <code>X-Webhook-Secret</code>. Paste a Devin Automation's webhook URL and secret there to run it on every channel update. The bot's own messages and private threads are never sent; threads and other bots only when turned on.</li>
      </ul>
      <p>${doc(DOCS.automations, 'Devin docs: Automations')}</p>`
  },
  {
    id: 'devin-settings',
    title: 'Devin settings',
    body: html`<ul class="steps">
        <li><strong>API key and organization ID:</strong> see <a href="#getting-started">Getting started</a>. Leave the key field empty when saving to keep the current one. <strong>Remove key</strong> disconnects the server.</li>
        <li><strong>Default repos:</strong> <code>owner/repo</code>, one per line. Every task starts with them so Devin is in the right code from the start.</li>
        <li><strong>Run as Devin users:</strong> by default every task is created by the service user. Map a Discord member to their Devin user (<code>123456789012345678 user-…</code>, one per line) and their tasks and replies are made as them in Devin. Only Discord Administrators can edit this list, each Devin user is checked to be in the org, and every change is audited.</li>
        <li><strong>Extra instructions:</strong> added to every task's prompt, for example "open PRs as drafts" or your branch naming. When empty, this is used: <em>${DEFAULT_INSTRUCTIONS}</em></li>
      </ul>
      <p>Tasks are tagged <code>discord</code>, <code>discord-guild:&lt;id&gt;</code> and <code>discord-user:&lt;id&gt;</code> in Devin, so you can filter them there.</p>
      <p>${doc(DOCS.discordIds, 'Discord: finding user IDs')}</p>`
  },
  {
    id: 'mcp',
    title: 'MCP server for Devin',
    body: html`<p>The bot forwards messages in both directions on its own. The MCP server is extra: it lets Devin use Discord directly during a task, for example to re-read the thread, look at a linked message or post a summary in <code>#changelog</code>.</p>
      <ol class="steps">
        <li>On the <strong>MCP</strong> page, click <strong>Generate token</strong> and copy it. It's shown once, and generating a new one revokes the old one.</li>
        <li>In Devin, go to <strong>Customize → MCPs → Add MCP → Add custom MCP</strong>. Transport <strong>HTTP</strong>, URL from the MCP page, authentication <strong>Auth Header</strong> with key <code>Authorization</code> and value <code>Bearer &lt;token&gt;</code>.</li>
        <li>Click <strong>Test tools</strong>.</li>
      </ol>
      <table class="grid">
        <thead><tr><th>Tool</th><th>Does</th></tr></thead>
        <tbody>
          <tr><td><code>read_task_thread</code></td><td>Read the task's own thread</td></tr>
          <tr><td><code>post_to_task_thread</code></td><td>Post in it, with images or files, link buttons or as a reply; can ping whoever started the task (not after the task is stopped)</td></tr>
          <tr><td><code>add_reaction</code> / <code>remove_reaction</code></td><td>Add or remove its own reaction, in its thread or a channel allowed under Post</td></tr>
          <tr><td><code>edit_message</code> / <code>delete_message</code></td><td>Change or remove a message the bot posted, in its thread or a channel allowed under Post</td></tr>
          <tr><td><code>pin_message</code></td><td>Pin or unpin a message in its thread</td></tr>
          <tr><td><code>start_thread</code></td><td>Open a public thread in a text channel allowed under Post, on a message or on its own</td></tr>
          <tr><td><code>create_poll</code></td><td>Post a Discord poll in its thread or a channel allowed under Post</td></tr>
          <tr><td><code>list_channels</code></td><td>List the channels it may read and post in</td></tr>
          <tr><td><code>read_channel</code></td><td>Read a channel allowed under Read, or a public thread in it; for a forum, list its posts</td></tr>
          <tr><td><code>get_message</code></td><td>Read one message, for example from a link</td></tr>
          <tr><td><code>post_to_channel</code></td><td>Post in a channel allowed under Post; in a forum, start a post (with a title and tags) or reply in one; images, files, link buttons and replies too</td></tr>
        </tbody>
      </table>
      <p><strong>What Devin can do</strong> on the MCP page switches tool groups off: posting, editing and deleting its own posts, reactions, threads and pins, polls, and pinging the requester. Switched-off tools disappear from Devin's tool list. Reading is always on.</p>
      <p><strong>What it can reach:</strong> the Read and Post lists on the MCP page. Read follows the Channels page's Allowed list when nothing is ticked (and only channels <code>@everyone</code> can see when that's empty too). Post is off until you tick something. Switch Read or Post to <strong>Bot's Discord permissions</strong> to follow the bot's role instead: every channel and public thread it can read (or post in), including new ones. Private threads are never readable or postable. Other tasks' threads can't be edited, reacted to or polled in. Posts never ping anyone, except <code>ping_requester</code> in the task's own thread.</p>
      <p><strong>Task threads</strong> need more than the token: each task started while a token exists gets its own task key in its prompt, so a Devin session can only work in its own thread.</p>
      <p>Anyone with the token can read and post where it's allowed. Keep it in Devin only, and generate a new one if it leaks.</p>
      <p>${doc(DOCS.mcp, 'Devin docs: MCP servers')}</p>`
  },
  {
    id: 'audit',
    title: 'Audit log',
    body: html`<p>Every settings change, task start, stop and sleep is logged with who did it and when (UTC). Open it from the <strong>Audit log</strong> tab of a server. Anyone who can change settings can read it.</p>`
  },
  {
    id: 'data',
    title: 'Security and your data',
    body: html`<ul class="steps">
        <li><strong>Devin keys</strong> are encrypted before they're stored and never shown again, not even to admins.</li>
        <li><strong>MCP tokens and task keys</strong> are stored as hashes only.</li>
        <li><strong>Messages</strong> aren't stored by the bot. They're sent to Devin as part of the task and live in your Devin session. The bot keeps each task's title, thread and session link, and its PR links.</li>
        <li><strong>Untrusted context:</strong> channel history, replied-to messages and everything read through MCP is wrapped as untrusted. Devin is told to treat it as information, never as instructions.</li>
        <li><strong>Usage</strong> runs on your Devin organization and counts toward its ACUs. Use role limits to keep it in check.</li>
        <li><strong>Sign-in</strong> uses Discord OAuth. The site only sees your username, avatar and the list of servers you're in.</li>
      </ul>
      <p>The code is open: ${doc(REPO_URL, 'fmflex/devin4discord on GitHub')}.</p>`
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    body: html`<dl class="faq">
        <dt>The bot doesn't react when I mention it.</dt>
        <dd>Check that the server has a Devin key saved, the channel is on the Allowed list (or the list is empty), your role has <strong>Start tasks</strong>, and the bot's role can view and send messages in that channel. In most of these cases the bot replies privately with the reason.</dd>
        <dt>My server isn't listed on the site.</dt>
        <dd>You need Administrator, Manage Server or a role with <strong>Change settings</strong>. The list is loaded when you sign in, so sign out and back in after getting a new role or adding the bot.</dd>
        <dt>Replies in the thread don't reach Devin.</dt>
        <dd>Your role needs <strong>Reply to tasks</strong> (or Start tasks, for your own tasks). Check that the message doesn't start with <code>//</code> and that <strong>Only forward messages that @mention Devin</strong> is off, or mention Devin. Stopped tasks don't take replies.</dd>
        <dt>The bot says I've reached my limit.</dt>
        <dd>One of your role's limits kicked in: tasks per day or tasks running at once. Stop or finish a task, or ask an admin to raise the limit.</dd>
        <dt>Saving the Devin key fails.</dt>
        <dd>Make sure it's a <strong>service user</strong> key, the organization ID matches, and the service user has the roles listed in <a href="#getting-started">Getting started</a>.</dd>
      </dl>
      <p>Still stuck? Ask in the ${doc(COMMUNITY_URL, 'devin4discord Discord community')} or open an issue on ${doc(`${REPO_URL}/issues`, 'GitHub')}.</p>`
  }
];

export function docsPage(session: WebSession | null, publicUrl: string) {
  return layout({
    title: 'Docs: set up and use the Devin Discord bot',
    session,
    meta: {
      description:
        'Set up devin4discord and use Devin, the AI software engineer, from Discord: service user key, permissions, task threads, slash commands, watched channels and the MCP server.',
      url: `${publicUrl}/docs`,
      image: `${publicUrl}/assets/avatar.png`
    },
    body: html`<div class="docs">
      <nav class="toc" aria-label="On this page">
        <p class="muted small">On this page</p>
        ${SECTIONS.map((section) => html`<a href="#${section.id}">${section.title}</a>`)}
      </nav>
      <div class="docs-body">
        <section class="card docs-intro">
          <h1>devin4discord docs</h1>
          <p>devin4discord connects a Discord server to a Devin organization. Members ask for work in chat, Devin does it, and the conversation stays in a Discord thread. This page covers setup and every feature.</p>
        </section>
        ${SECTIONS.map(
          (section) => html`<section class="card doc" id="${section.id}"><h2><a class="anchor" href="#${section.id}">${section.title}</a></h2>${section.body}</section>`
        )}
      </div>
    </div>`
  });
}
