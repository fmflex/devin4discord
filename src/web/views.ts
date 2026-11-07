import { createHash } from 'node:crypto';
import { html, raw } from 'hono/html';
import type { ChannelInfo, RoleInfo } from '../directory.ts';
import { DEFAULT_INSTRUCTIONS } from '../format.ts';
import { MAX_CONTEXT_MESSAGES, type AuditEntry, type McpModes, type WatchChannel } from '../guilds.ts';
import { RETENTION_DAYS } from '../retention.ts';
import type { AdminStats } from '../admin.ts';

export type MentionSettings = { contextMessages: number; mentionOnlyReplies: boolean };
import { ADMIN_ROLE, PERMISSIONS, PERMISSION_LABELS, adminRule, type Limits, type RoleRule } from '../permissions.ts';
import type { WebSession } from './sessions.ts';

type Html = ReturnType<typeof html>;

export type GuildTab = 'devin' | 'permissions' | 'channels' | 'watch' | 'mcp' | 'audit';

export type PageOptions = {
  title: string;
  session?: WebSession | null;
  guild?: { id: string; name: string; tab: GuildTab };
  notice?: { kind: 'ok' | 'error'; text: string } | null;
  /** Link-preview tags for public pages; `url` is the absolute page URL. */
  meta?: { description: string; url: string; image: string };
  /** Show the host admin link in the header (only for users on ADMIN_USER_IDS). */
  admin?: boolean;
  body: Html | Html[];
};

function avatarUrl(session: WebSession) {
  return session.avatar
    ? `https://cdn.discordapp.com/avatars/${session.userId}/${session.avatar}.png?size=64`
    : null;
}

export const REPO_URL = 'https://github.com/fmflex/devin4discord';
export const COMMUNITY_URL = 'https://discord.gg/Hvys84HkCd';

export const DOCS = {
  serviceUsers: 'https://docs.devin.ai/api-reference/authentication#service-users-recommended-for-automation',
  permissions: 'https://docs.devin.ai/api-reference/v3/overview',
  createSession: 'https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions',
  billing: 'https://docs.devin.ai/admin/billing',
  mcp: 'https://docs.devin.ai/work-with-devin/mcp',
  automations: 'https://docs.devin.ai/product-guides/automations',
  discordIds: 'https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID'
};

export function doc(href: string, text: string) {
  return html`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

/** A "?" that opens an explanation on click; `end` anchors it to the right for columns near the edge. */
const ADMIN_ONLY_NOTE = html`<p class="muted small">Only Discord Administrators can change these settings.</p>`;

/** Wraps form controls so they're read-only for members who may only view them. */
function editable(canEdit: boolean, body: Html | Html[]) {
  return html`<fieldset${canEdit ? '' : ' disabled'}>${body}</fieldset>`;
}

function help(topic: string, body: Html, end = false) {
  return html`<details class="help${end ? ' end' : ''}"><summary aria-label="About ${topic}" title="About ${topic}">?</summary><div class="tip">${body}</div></details>`;
}

function csrfField(session: WebSession) {
  return html`<input type="hidden" name="_csrf" value="${session.csrfToken}">`;
}

export function layout(page: PageOptions) {
  const { session, guild } = page;
  const tabs: [GuildTab, string][] = [
    ['devin', 'Devin'],
    ['permissions', 'Permissions'],
    ['channels', 'Channels'],
    ['watch', 'Watched channels'],
    ['mcp', 'MCP'],
    ['audit', 'Audit log']
  ];
  const avatar = session ? avatarUrl(session) : null;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title} · devin4discord</title>
<link rel="stylesheet" href="/assets/app.css?v=${CSS_VERSION}">
<link rel="icon" type="image/svg+xml" href="/assets/logo.svg">
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<meta name="theme-color" content="#5865f2">
${page.meta
  ? html`<meta name="description" content="${page.meta.description}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="devin4discord">
<meta property="og:title" content="${page.title}">
<meta property="og:description" content="${page.meta.description}">
<meta property="og:url" content="${page.meta.url}">
<meta property="og:image" content="${page.meta.image}">`
  : ''}
</head>
<body>
<header class="top">
  <div class="top-in">
  <a class="brand" href="/"><img src="/assets/logo.svg" alt="" width="32" height="32"><span>devin<b>4</b>discord</span></a>
  <nav class="me" aria-label="Account">
    <a class="navlink navdiscord" href="${COMMUNITY_URL}" target="_blank" rel="noopener noreferrer" aria-label="Join our Discord community">${DISCORD_LOGO}<span>Community</span></a>
    <a class="navlink" href="/docs">Docs</a>
    ${session
      ? html`${page.admin ? html`<a class="navlink" href="/admin">Admin</a>` : ''}<a class="navlink" href="/">Servers</a>
        <span class="user">${avatar ? html`<img class="avatar" src="${avatar}" alt="">` : html`<span class="avatar blank">${session.username.slice(0, 1)}</span>`}<span class="username">${session.username}</span></span>
        <form method="post" action="/auth/logout">${csrfField(session)}<button class="button ghost small">Sign out</button></form>`
      : html`<a class="button small" href="/auth/login">Sign in</a>`}
  </nav>
  </div>
</header>
<main>
  ${guild
    ? html`<div class="guildhead">
        <a class="crumbs" href="/">← All servers</a>
        <h1><span class="icon blank" aria-hidden="true">${guild.name.slice(0, 1)}</span>${guild.name}</h1>
      </div>
      <nav class="tabs" aria-label="Server settings">${tabs.map(
        ([tab, label]) =>
          html`<a href="/g/${guild.id}/${tab}" class="${tab === guild.tab ? 'active' : ''}"${tab === guild.tab ? raw(' aria-current="page"') : ''}>${label}</a>`
      )}</nav>`
    : ''}
  ${page.notice ? html`<p class="notice ${page.notice.kind}">${page.notice.text}</p>` : ''}
  ${page.body}
</main>
<footer class="foot">
  <div class="foot-in">
    <a class="brand small" href="/"><img src="/assets/logo.svg" alt="" width="22" height="22"><span>devin<b>4</b>discord</span></a>
    <nav><a href="/docs">Docs</a><a href="${COMMUNITY_URL}" target="_blank" rel="noopener noreferrer">Discord community</a><a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub</a><a href="${REPO_URL}/issues" target="_blank" rel="noopener noreferrer">Report an issue</a></nav>
  </div>
  <p>An independent, open source project. Not made by or affiliated with Discord or Cognition.</p>
</footer>
</body>
</html>`;
}

const ICONS = {
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>',
  thread: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>',
  reply: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>'
} as const;

const DISCORD_LOGO = raw('<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>');

function icon(name: keyof typeof ICONS) {
  return raw(`<svg class="ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`);
}

const FEATURES: [keyof typeof ICONS, string, Html][] = [
  ['at', 'Start from any message', html`Mention <strong>@Devin</strong>, react with 🤖, right-click a message → <strong>Apps → Send to Devin</strong>, or run <code>/devin start</code>. Devin gets the message, its images and files, and a link back to it.`],
  ['thread', 'One thread per task', html`Devin's updates, PR links and status changes land in a thread. Whoever asked gets pinged when a PR opens or Devin needs an answer.`],
  ['reply', 'Reply like you normally would', html`Type in the thread and Devin gets it, screenshots included. Start a message with <code>//</code> to keep it between humans.`],
  ['shield', 'Roles decide who can do what', html`Pick which roles can start tasks, reply, stop tasks or change settings. Cap ACUs per task, tasks per day and tasks running at once.`],
  ['key', 'Your Devin org, your key', html`Each server connects its own Devin organization with a service user key. The key is stored encrypted and never shown again. Usage goes to your org.`],
  ['plug', 'Devin can use Discord too', html`Turn on the MCP server and Devin can read its thread, check channels you allow and post updates while it works.`]
];

const SETUP_STEPS: [string, Html][] = [
  ['Add the bot', html`to a server where you have Manage Server.`],
  ['Come back signed in', html`Discord brings you straight to the server's setup.`],
  ['Connect Devin', html`with a service user key and your organization ID.`],
  ['Pick roles and channels', html`then try <code>@Devin say hi</code> in a channel.`]
];

/** A static picture of a task in Discord, so visitors see what the bot does before signing in. */
const DEMO = html`<div class="demo" aria-hidden="true">
  <div class="demo-bar"><span class="muted">#</span> bug-reports</div>
  <div class="msg">
    <span class="pfp" style="background:#eb459e">M</span>
    <div><p class="who">Mia <span class="when">Today at 14:02</span></p>
      <p><span class="mention">@Devin</span> the login page redirects to a 404 after sign-in</p></div>
  </div>
  <div class="thread">
    <p class="thread-title">Devin: the login page redirects to a 404…</p>
    <div class="msg">
      <img class="pfp" src="/assets/logo.svg" alt="">
      <div><p class="who">Devin <span class="tag">APP</span> <span class="when">14:02</span></p>
        <p>On it. The callback drops the <code>next</code> parameter; fixing it now.</p></div>
    </div>
    <div class="msg">
      <img class="pfp" src="/assets/logo.svg" alt="">
      <div><p class="who">Devin <span class="tag">APP</span> <span class="when">14:19</span></p>
        <p><span class="mention">@Mia</span> PR is ready for review</p>
        <div class="embed"><strong>#128 Keep the redirect target through sign-in</strong><span>acme/web · 2 files changed · checks passing</span></div></div>
    </div>
  </div>
</div>`;

export function landingPage(links: { invite: string; publicUrl: string }) {
  return layout({
    title: 'Devin, in your Discord server',
    meta: {
      description: 'Mention @Devin in Discord to hand off a task. Follow the work and reply in a thread.',
      url: `${links.publicUrl}/`,
      image: `${links.publicUrl}/assets/avatar.png`
    },
    body: html`<section class="hero">
      <div class="hero-text">
        <p class="eyebrow">Free and open source</p>
        <h1>Devin, in your <span class="grad">Discord server</span></h1>
        <p class="lead">Mention <strong>@Devin</strong> on a bug report or feature request. Devin picks it up, works in a thread and posts PRs there. Your team follows along and replies right in Discord.</p>
        <div class="actions">
          <a class="button big" href="${links.invite}">Add to Discord</a>
          <a class="button secondary big" href="/auth/login">Sign in to set up</a>
        </div>
        <p class="muted small">You bring your own Devin organization. <a href="/docs">Read the docs</a></p>
        <a class="joinbar" href="${COMMUNITY_URL}" target="_blank" rel="noopener noreferrer">
          <span class="joinlogo">${DISCORD_LOGO}</span>
          <span><strong>Join our Discord community</strong><span>Get help with setup, share feedback and hear about new features first.</span></span>
          <span class="joinarrow" aria-hidden="true">→</span>
        </a>
      </div>
      ${DEMO}
    </section>
    <section class="features">${FEATURES.map(
      ([name, title, text]) => html`<div class="card feature">${icon(name)}<h2>${title}</h2><p>${text}</p></div>`
    )}</section>
    <section class="card setup">
      <h2>Set it up in a few minutes</h2>
      <ol class="flow">${SETUP_STEPS.map(([title, text]) => html`<li><strong>${title}</strong> ${text}</li>`)}</ol>
      <p class="muted small">You need a Devin organization with API access. <a href="/docs#getting-started">Full setup guide</a></p>
    </section>
    <section class="card community">
      <div><h2>Join the devin4discord community</h2><p>Ask questions, get help with setup, share feedback and hear about new features first.</p></div>
      <a class="button big" href="${COMMUNITY_URL}" target="_blank" rel="noopener noreferrer">${DISCORD_LOGO}Join our Discord</a>
    </section>`
  });
}

export type PickerRow = {
  id: string;
  name: string;
  icon: string | null;
  action: 'configure' | 'invite';
  configured: boolean;
  inviteUrl: string;
};

export function pickerPage(session: WebSession, rows: PickerRow[], inviteAny: string, admin = false) {
  const icon = (row: PickerRow) =>
    row.icon
      ? html`<img class="icon" src="https://cdn.discordapp.com/icons/${row.id}/${row.icon}.png?size=64" alt="">`
      : html`<span class="icon blank">${row.name.slice(0, 1)}</span>`;
  return layout({
    title: 'Servers',
    session,
    admin,
    body: html`<section class="card">
      <div class="row between"><div><h1>Your servers</h1><p class="muted small">Servers where you can set up devin4discord.</p></div><a class="button secondary" href="${inviteAny}">Add to another server</a></div>
      ${rows.length
        ? html`<ul class="servers">${rows.map(
            (row) => html`<li>
              ${icon(row)}
              <span class="grow">${row.name}</span>
              ${row.action === 'configure'
                ? html`<span class="pill ${row.configured ? 'ok' : 'warn'}">${row.configured ? 'Set up' : 'Not set up'}</span>
                    <a class="button${row.configured ? ' secondary' : ''}" href="/g/${row.id}/devin">Configure</a>`
                : html`<span class="pill">Bot not added</span><a class="button secondary" href="${row.inviteUrl}">Add to Discord</a>`}
            </li>`
          )}</ul>`
        : html`<p class="muted">No servers you can configure. You need Administrator or Manage Server, or a role with the "Change settings" permission, in a server with the bot.</p>`}
      <p class="muted small">Server list is from when you signed in. <a href="/auth/login">Sign in again</a> to refresh it.</p>
    </section>`
  });
}

export type DevinForm = {
  keyHint: string | null;
  orgId: string;
  repos: string;
  userMap: string;
  instructions: string;
  /** The saved GitHub token for `/devin merge`, if any. */
  github: { hint: string; login: string } | null;
};

export function devinPage(
  session: WebSession,
  guild: { id: string; name: string },
  form: DevinForm,
  notice: PageOptions['notice'],
  canEdit: boolean
) {
  return layout({
    title: `${guild.name} · Devin`,
    session,
    guild: { ...guild, tab: 'devin' },
    notice,
    body: html`<form class="card" method="post" action="/g/${guild.id}/devin">
      ${csrfField(session)}
      <h2>Devin connection</h2>
      <p class="muted">Use a service user key (Devin → Settings → Devin API → Service users) with permission to create, view and message sessions. Tasks are created by this service user.</p>
      ${canEdit ? '' : ADMIN_ONLY_NOTE}
      ${editable(canEdit, html`
      <label>API key ${help('the API key', html`<p>A Devin <strong>service user</strong> key, starting with <code>cog_</code>. In Devin, open <strong>Settings → Devin API → Service users</strong>, create one and copy the key. Devin shows it only once.</p>
        <p>Give its role <code>UseDevinSessions</code>, <code>ViewOrgSessions</code> and <code>ManageOrgSessions</code>, plus <code>ImpersonateOrgSessions</code> and <code>ViewOrgMembership</code> if you use "Run as Devin users".</p>
        <p>It's checked with read-only calls before saving and stored encrypted.</p>
        <p>${doc(DOCS.serviceUsers, 'Devin docs: service users')} · ${doc(DOCS.permissions, 'API permissions')}</p>`)}
        <input type="password" name="api_key" autocomplete="off" spellcheck="false"
          placeholder="${form.keyHint ? `Set, ends in …${form.keyHint}. Leave empty to keep it.` : 'cog_…'}">
      </label>
      <p class="muted small">${form.keyHint ? html`Key is <strong>set, ends in …${form.keyHint}</strong>. It is stored encrypted and never shown again.` : 'No key saved yet. It is checked with a read-only API call before saving.'}</p>
      <label>Organization ID ${help('the organization ID', html`<p>The Devin organization tasks run in. It looks like <code>org-…</code> and is shown at the top of <strong>Settings → Devin API</strong> in Devin.</p>
        <p>The service user must be a member of this organization.</p>
        <p>${doc(DOCS.permissions, 'Devin docs: API overview')}</p>`)}
        <input name="org_id" value="${form.orgId}" placeholder="org-…" required spellcheck="false">
      </label>
      <label>Default repos ${help('default repos', html`<p>Repositories every task starts with, for example <code>fmflex/devin4discord</code>. They're sent as the new session's <code>repos</code>, so Devin starts in the right code.</p>
        <p>Leave empty to send none.</p>
        <p>${doc(DOCS.createSession, 'Devin docs: create session')}</p>`)}
        <span class="hint">One per line, as owner/repo.</span>
        <textarea name="repos" rows="3" spellcheck="false">${form.repos}</textarea>
      </label>
      <label>Run as Devin users <span class="optional">Optional</span> ${help('running as Devin users', html`<p>By default every task is created by the service user. List a Discord member here with their Devin user ID (<code>user-…</code>), and tasks they start and replies they send are made as that Devin user.</p>
        <p>Example: <code>123456789012345678 user-0123abcd…</code></p>
        <p>To copy a Discord user ID, turn on Developer Mode in Discord (User Settings → Advanced), then right-click the member → Copy User ID.</p>
        <p>Only Discord Administrators can change this list. Each Devin user is checked to be in the organization before saving, and every change is written to the audit log.</p>
        <p>Needs <code>ImpersonateOrgSessions</code> and <code>ViewOrgMembership</code> on the service user. The Devin user must be in the organization and allowed to use Devin.</p>
        <p>${doc(DOCS.discordIds, 'Discord: finding IDs')} · ${doc(DOCS.createSession, 'Devin docs: create_as_user_id')}</p>`)}
        <span class="hint">One per line: Discord user ID, a space, then the Devin user ID.</span>
        <textarea name="user_map" rows="3" spellcheck="false">${form.userMap}</textarea>
      </label>
      <label>Extra instructions <span class="optional">Optional</span> ${help('extra instructions', html`<p>Added to the prompt of every task from this server, for example your conventions or "open PRs as drafts".</p>
        <p>When empty, this default is used: <em>${DEFAULT_INSTRUCTIONS}</em></p>`)}
        <span class="hint">Added to every task. A default is used when empty.</span>
        <textarea name="instructions" rows="3">${form.instructions}</textarea>
      </label>
      <button class="button">Check and save</button>`)}
    </form>
    <form class="card" method="post" action="/g/${guild.id}/github">
      ${csrfField(session)}
      <h2>GitHub <span class="optional">Optional</span></h2>
      <p class="muted">Lets <code>/devin merge</code> merge pull requests. The bot merges with this token, so Devin itself never needs merge rights. It only merges open PRs whose checks all passed.</p>
      ${canEdit ? '' : ADMIN_ONLY_NOTE}
      ${editable(canEdit, html`
      <label>GitHub token ${help('the GitHub token', html`<p>A fine-grained personal access token (or a bot account's) with <strong>Contents: Read and write</strong>, <strong>Pull requests: Read and write</strong> and <strong>Commit statuses: Read</strong> on the repos you want to merge in. Classic tokens need the <code>repo</code> scope.</p>
        <p>Branch protection still applies: GitHub refuses merges its rules don't allow.</p>
        <p>It's checked with <code>GET /user</code> before saving and stored encrypted.</p>`)}
        <input type="password" name="github_token" autocomplete="off" spellcheck="false"
          placeholder="${form.github ? `Set, ends in …${form.github.hint}. Paste a new one to replace it.` : 'github_pat_…'}">
      </label>
      <p class="muted small">${form.github ? html`Token for <strong>${form.github.login}</strong> is <strong>set, ends in …${form.github.hint}</strong>. It is stored encrypted and never shown again.` : 'No token saved: /devin merge is off.'}</p>
      <button class="button">Check and save</button>`)}
    </form>
    ${form.github && canEdit
      ? html`<form class="card danger" method="post" action="/g/${guild.id}/github/remove">
          ${csrfField(session)}
          <h2>Remove GitHub token</h2>
          <p class="muted">Turns off <code>/devin merge</code> until a new token is saved.</p>
          <button class="button danger">Remove token</button>
        </form>`
      : ''}
    ${form.keyHint && canEdit
      ? html`<form class="card danger" method="post" action="/g/${guild.id}/devin/remove">
          ${csrfField(session)}
          <h2>Disconnect</h2>
          <p class="muted">Removes the key. Triggers in this server stop working until a new key is saved.</p>
          <button class="button danger">Remove key</button>
        </form>`
      : ''}`
  });
}

const PERMISSION_HELP: Record<(typeof PERMISSIONS)[number], Html> = {
  start_tasks: html`<p>Start a task with <strong>@Devin</strong>, the robot reaction, <strong>Send to Devin</strong> or <code>/devin start</code>, and reply in their own task threads.</p><p>Only works in the allowed channels (see Channels).</p>`,
  reply: html`<p>Messages they post in any task thread are forwarded to Devin.</p><p>Messages starting with <code>//</code> are never forwarded.</p>`,
  manage_tasks: html`<p>Stop or put to sleep any task: the Stop / Sleep buttons, <code>@Devin stop</code> / <code>@Devin sleep</code> or <code>/devin stop</code> / <code>/devin sleep</code>. Also lets them reply to any task.</p><p>The member who started a task can always stop or sleep it.</p>`,
  merge_prs: html`<p>Merge pull requests with <code>/devin merge</code>, using the GitHub token on the Devin page.</p><p>Only open PRs whose checks all passed are merged.</p>`,
  settings: html`<p>Use this setup site for the server. Members with Administrator or Manage Server always can.</p><p>Only Discord Administrators can change the Devin connection, these permissions and the MCP settings. Others can view them and change channels they can see themselves.</p>`
};

function roleColor(role: RoleInfo) {
  return role.color ? `#${role.color.toString(16).padStart(6, '0')}` : '#99aab5';
}

export function permissionsPage(
  session: WebSession,
  guild: { id: string; name: string },
  roles: RoleInfo[],
  rules: RoleRule[],
  notice: PageOptions['notice'],
  canEdit: boolean
) {
  const byRole = new Map(rules.map((rule) => [rule.roleId, rule]));
  const limit = (value: number | null | undefined) => (value == null ? '' : String(value));
  const row = (id: string, name: string, color: string, rule: RoleRule | undefined, note = '') => html`<tr>
            <td class="role"><span class="dot" style="${raw(`background:${color}`)}"></span>${name}${note ? html` <span class="muted">${note}</span>` : ''}${id === ADMIN_ROLE ? help('the Administrator row', html`<p>Applies to members with Discord's <strong>Administrator</strong> permission, whatever their roles.</p><p>Until you change it, they can do everything with no limits. Change settings always stays on.</p>`) : ''}</td>
            ${PERMISSIONS.map((p) => {
              const locked = id === ADMIN_ROLE && p === 'settings';
              return html`<td class="center"><input type="checkbox" name="p_${id}" value="${p}" aria-label="${name}: ${PERMISSION_LABELS[p]}" ${locked || rule?.permissions.includes(p) ? 'checked' : ''} ${locked ? 'disabled' : ''}></td>`;
            })}
            <td><input class="num" type="number" min="1" step="1" name="acu_${id}" value="${limit(rule?.limits.maxAcu)}"></td>
            <td><input class="num" type="number" min="0" step="1" name="day_${id}" value="${limit(rule?.limits.tasksPerDay)}"></td>
            <td><input class="num" type="number" min="0" step="1" name="conc_${id}" value="${limit(rule?.limits.concurrentTasks)}"></td>
          </tr>`;
  return layout({
    title: `${guild.name} · Permissions`,
    session,
    guild: { ...guild, tab: 'permissions' },
    notice,
    body: html`<form class="card wide" method="post" action="/g/${guild.id}/permissions">
      ${csrfField(session)}
      <h2>Role permissions</h2>
      <p class="muted">The Administrator row is for members with Discord's Administrator permission. They always keep Change settings, and so does Manage Server. Limits apply to roles that can start tasks; empty means no limit, and a member with several roles (Administrator counts as one) gets the most generous one.</p>
      ${canEdit ? '' : ADMIN_ONLY_NOTE}
      ${editable(canEdit, html`<div class="scroll"><table class="grid">
        <thead><tr><th>Role ${help('roles', html`<p>Roles are read live from Discord. A member gets every permission any of their roles grants.</p><p>For limits, the most generous of their roles that can start tasks applies.</p>`)}</th>${PERMISSIONS.map((p) => html`<th>${PERMISSION_LABELS[p]} ${help(PERMISSION_LABELS[p], PERMISSION_HELP[p])}</th>`)}
          <th>ACU cap / task ${help('the ACU cap', html`<p>The most ACUs (Agent Compute Units, how Devin usage is measured) one task may use. It's sent as the session's <code>max_acu_limit</code>.</p><p>Empty means no cap.</p><p>${doc(DOCS.billing, 'Devin docs: billing and ACUs')} · ${doc(DOCS.createSession, 'create session')}</p>`, true)}</th>
          <th>Tasks / day ${help('tasks per day', html`<p>How many tasks one member may start in any 24 hours.</p><p>Empty means no limit; 0 blocks starting.</p>`, true)}</th>
          <th>Concurrent ${help('concurrent tasks', html`<p>How many tasks one member may have running at once. Finished and stopped tasks don't count; sleeping ones do.</p><p>Empty means no limit.</p>`, true)}</th></tr></thead>
        <tbody>
          ${row(ADMIN_ROLE, 'Administrator', '#f04747', adminRule(rules), '(Discord permission)')}
          ${roles.map((role) => row(role.id, role.name, roleColor(role), byRole.get(role.id)))}
        </tbody>
      </table></div>
      <button class="button">Save permissions</button>`)}
    </form>`
  });
}

const KIND_LABEL: Record<ChannelInfo['kind'], string> = {
  text: '#',
  announcement: 'announcements',
  forum: 'forum'
};

export const MAX_CHANNEL_QUERY = 100;

/** Channels whose name or category contains the query (case-insensitive, a leading # ignored). */
export function matchChannels(channels: ChannelInfo[], query: string) {
  const q = query.trim().replace(/^#/, '').toLowerCase();
  if (!q) return channels;
  return channels.filter(
    (channel) => channel.name.toLowerCase().includes(q) || (channel.category ?? '').toLowerCase().includes(q)
  );
}

function byCategory(channels: ChannelInfo[]) {
  const groups = new Map<string, ChannelInfo[]>();
  for (const channel of [...channels].sort((a, b) => a.position - b.position)) {
    const key = channel.category ?? 'No category';
    groups.set(key, [...(groups.get(key) ?? []), channel]);
  }
  return groups;
}

/**
 * Search box, match count and "Show only ticked" toggle for a channel list. The search
 * inputs belong to a separate GET form (channelSearchForm) so they can sit inside the
 * settings form; folding and the toggle are pure CSS.
 */
function channelTools(action: string, query: string, shown: number, total: number) {
  return html`<div class="listtools">
    <input type="search" name="q" form="channel-search" value="${query}" maxlength="${MAX_CHANNEL_QUERY}" placeholder="Search channels or categories" aria-label="Search channels">
    <button class="button secondary" form="channel-search">Search</button>
    ${query ? html`<a href="${action}">Clear</a> <span class="muted small">${shown} of ${total} channels match</span>` : ''}
    <label class="check"><input type="checkbox" class="only-ticked"> Show only ticked</label>
  </div>
  <p class="muted small none-ticked">Nothing is ticked${query ? ' among the channels shown' : ''}.</p>`;
}

function channelSearchForm(action: string) {
  return html`<form id="channel-search" method="get" action="${action}" role="search"></form>`;
}

/** With a search, saving only changes the channels shown; the rest keep their settings. */
function listScope(query: string, shown: ChannelInfo[]) {
  return query
    ? html`<input type="hidden" name="q" value="${query}"><input type="hidden" name="scoped" value="1">${shown.map(
        (channel) => html`<input type="hidden" name="shown" value="${channel.id}">`
      )}`
    : '';
}

function categoryRow(category: string, columns: number, ticked: number) {
  return html`<tr class="group"><td colspan="${columns}"><label class="fold"><input type="checkbox" aria-label="Fold ${category}"><span class="cat">${category}</span>${ticked ? html`<span class="count">${ticked} ticked</span>` : ''}</label></td></tr>`;
}

export function channelsPage(
  session: WebSession,
  guild: { id: string; name: string },
  channels: ChannelInfo[],
  allowed: string[],
  taskChannelId: string | null,
  mention: MentionSettings,
  notice: PageOptions['notice'],
  editable: Set<string> | null,
  query = ''
) {
  const allowedSet = new Set(allowed);
  const locked = (channel: ChannelInfo) => (editable && !editable.has(channel.id) ? ' disabled' : '');
  const shown = matchChannels(channels, query);
  const anyLocked = shown.some((channel) => locked(channel));
  const groups = byCategory(shown);
  const action = `/g/${guild.id}/channels`;
  const ticked = (list: ChannelInfo[]) =>
    list.filter((channel) => allowedSet.has(channel.id) || taskChannelId === channel.id).length;
  return layout({
    title: `${guild.name} · Channels`,
    session,
    guild: { ...guild, tab: 'channels' },
    notice,
    body: html`${channelSearchForm(action)}<form class="card wide" method="post" action="${action}">
      ${csrfField(session)}
      ${listScope(query, shown)}
      <h2>Channels</h2>
      <p class="muted"><strong>Allowed</strong>: where @Devin, the robot reaction, "Send to Devin" and <code>/devin start</code> work. None ticked means every channel.
        <strong>Task channel</strong>: where task threads open; by default the thread opens in the channel the request came from.</p>
      ${channelTools(action, query, shown.length, channels.length)}
      <table class="grid">
        <thead><tr><th>Channel</th>
          <th>Allowed ${help('allowed channels', html`<p>Where tasks can be started. Threads inside an allowed channel count too.</p><p>With none ticked, every channel the bot can see is allowed.</p>`)}</th>
          <th>Task channel ${help('the task channel', html`<p>Where the task's thread is opened. With "Channel the request came from", the thread opens next to the request (on the message itself for @Devin).</p><p>Pick a channel to keep all task threads in one place.</p>`, true)}</th></tr></thead>
        <tbody>
          <tr><td class="muted">Channel the request came from</td><td></td>
            <td class="center"><input type="radio" name="task_channel" value="" aria-label="Source channel" ${taskChannelId ? '' : 'checked'}></td></tr>
        </tbody>
          ${[...groups].map(
            ([category, list]) => html`<tbody>${categoryRow(category, 3, ticked(list))}
              ${list.map(
                (channel) => html`<tr>
                  <td>${channel.kind === 'text' ? html`<span class="muted">#</span> ` : ''}${channel.name}${channel.kind === 'text' ? '' : html` <span class="muted small">${KIND_LABEL[channel.kind]}</span>`}${locked(channel) ? html` <span class="muted small">hidden from you</span>` : ''}</td>
                  <td class="center"><input type="checkbox" name="allowed" value="${channel.id}" aria-label="Allow ${channel.name}" ${allowedSet.has(channel.id) ? 'checked' : ''}${locked(channel)}></td>
                  <td class="center"><input type="radio" name="task_channel" value="${channel.id}" aria-label="Task channel ${channel.name}" ${taskChannelId === channel.id ? 'checked' : ''}${locked(channel)}></td>
                </tr>`
              )}</tbody>`
          )}
      </table>
      ${query && !shown.length ? html`<p class="muted small">No channels match "${query}".</p>` : ''}
      ${anyLocked ? html`<p class="muted small">Channels marked "hidden from you" are ones Discord doesn't let you view, so only Discord Administrators can change them here.</p>` : ''}
      <h3>Mentions and replies</h3>
      <label>Channel messages sent as context with an @Devin mention ${help('context messages', html`<p>How many earlier messages from the channel (0–${MAX_CONTEXT_MESSAGES}) are sent with an @Devin mention, so Devin knows what's being discussed.</p><p>They're marked as untrusted, so Devin uses them as background and never follows instructions in them. 0 sends none.</p>`)}
        <input class="narrow" type="number" name="context_messages" min="0" max="${MAX_CONTEXT_MESSAGES}" value="${mention.contextMessages}">
      </label>
      <p class="muted small">Devin gets them, and the message being replied to, marked as untrusted context it must not take instructions from.</p>
      <label class="check"><input type="checkbox" name="mention_only" ${mention.mentionOnlyReplies ? 'checked' : ''}> Only forward messages that @mention Devin</label>
      <p class="muted small">For busy task threads. When off, every message from members allowed to reply is forwarded.</p>
      <button class="button">Save channels</button>
    </form>`
  });
}

export const MAX_WATCH_ACU = 1000;
export const MAX_WATCH_COUNT = 100;

export type WebhookView = { hint: string; hasSecret: boolean; includeThreads: boolean; includeBots: boolean };

export function watchPage(
  session: WebSession,
  guild: { id: string; name: string },
  channels: ChannelInfo[],
  watch: WatchChannel[],
  limits: Limits,
  webhook: WebhookView | null,
  notice: PageOptions['notice'],
  canEdit: boolean,
  query = ''
) {
  const autoSet = new Set(watch.filter((entry) => entry.autoStart).map((entry) => entry.channelId));
  const hookSet = new Set(watch.filter((entry) => entry.webhook).map((entry) => entry.channelId));
  const anyoneSet = new Set(watch.filter((entry) => entry.anyone).map((entry) => entry.channelId));
  const shown = matchChannels(channels, query);
  const groups = byCategory(shown);
  const action = `/g/${guild.id}/watch`;
  const ticked = (list: ChannelInfo[]) =>
    list.filter((channel) => autoSet.has(channel.id) || hookSet.has(channel.id)).length;
  return layout({
    title: `${guild.name} · Watched channels`,
    session,
    guild: { ...guild, tab: 'watch' },
    notice,
    body: html`<section class="card wide">
      <h2>Watched channels</h2>
      <p class="muted"><strong>Auto-start</strong>: every new message in the channel starts a Devin task, no @Devin needed. In a forum, every new post does, and the post becomes the task thread.
        <strong>Webhook</strong>: every new message in the channel is sent to the webhook below, e.g. to trigger a Devin Automation.</p>
      ${canEdit ? '' : ADMIN_ONLY_NOTE}
      ${channelSearchForm(action)}
      <form method="post" action="${action}/channels">
        ${csrfField(session)}
        ${channelTools(action, query, shown.length, channels.length)}
        ${editable(canEdit, html`${listScope(query, shown)}<table class="grid">
          <thead><tr><th>Channel</th>
            <th>Auto-start ${help('auto-start', html`<p>Each new top-level message starts a task, as if it had @mentioned Devin; the task thread opens on the message. In a forum, each new post starts one, with its title and text, and replies in the post go to Devin.</p><p>The author still needs <strong>Start tasks</strong> on the Permissions page, and their role's ACU cap and task limits apply. Messages from anyone else are ignored quietly. To take requests from everyone, give @everyone Start tasks with tight limits.</p><p>Bots, private threads and messages starting with <code>//</code> never start tasks. A watched channel counts as allowed even if it isn't ticked on the Channels tab.</p>`)}</th>
            <th>Anyone ${help('anyone can start', html`<p>Only with Auto-start. Members who don't have <strong>Start tasks</strong> may start tasks here too, within the limits below. Members who have it keep their role's limits.</p><p>Every member who can post here can then spend ACUs, so keep the limits tight.</p>`)}</th>
            <th>Webhook ${help('the channel webhook', html`<p>Each new message in the channel is POSTed as JSON to the webhook below. Private threads are never sent, and neither are the bot's own messages, so a Devin session posting through MCP can't loop.</p><p>Message text is written by members: whatever reads it should treat it as untrusted.</p>`, true)}</th>
          </tr></thead>
            ${[...groups].map(
              ([category, list]) => html`<tbody>${categoryRow(category, 4, ticked(list))}
                ${list.map(
                  (channel) => html`<tr>
                    <td>${channel.kind === 'text' ? html`<span class="muted">#</span> ` : ''}${channel.name}${channel.kind === 'text' ? '' : html` <span class="muted small">${KIND_LABEL[channel.kind]}</span>`}</td>
                    <td class="center"><input type="checkbox" name="auto_start" value="${channel.id}" aria-label="Auto-start tasks in ${channel.name}" ${autoSet.has(channel.id) ? 'checked' : ''}></td>
                    <td class="center"><input type="checkbox" name="anyone" value="${channel.id}" aria-label="Anyone can start tasks in ${channel.name}" ${anyoneSet.has(channel.id) ? 'checked' : ''}></td>
                    <td class="center"><input type="checkbox" name="webhook" value="${channel.id}" aria-label="Send ${channel.name} to the webhook" ${hookSet.has(channel.id) ? 'checked' : ''}></td>
                  </tr>`
                )}</tbody>`
            )}
        </table>
        ${query && !shown.length ? html`<p class="muted small">No channels match "${query}".</p>` : ''}
        <h3>Limits for "Anyone" channels</h3>
        <p class="muted small">For members without Start tasks, per member, across every channel ticked under Anyone.</p>
        <div class="row">
          <label>Max ACU per task <input class="narrow" type="number" name="max_acu" min="1" max="${MAX_WATCH_ACU}" value="${limits.maxAcu ?? ''}" required></label>
          <label>Tasks per day <input class="narrow" type="number" name="tasks_per_day" min="1" max="${MAX_WATCH_COUNT}" value="${limits.tasksPerDay ?? ''}" required></label>
          <label>Running at once <input class="narrow" type="number" name="concurrent_tasks" min="1" max="${MAX_WATCH_COUNT}" value="${limits.concurrentTasks ?? ''}" required></label>
        </div>
        ${hookSet.size && !webhook ? html`<p class="muted small">No webhook is set yet, so nothing is sent.</p>` : ''}
        <button class="button">Save channels</button>`)}
      </form>
    </section>
    <form class="card" method="post" action="${action}/webhook">
      ${csrfField(session)}
      <h2>Webhook</h2>
      <p class="muted">Where messages from the channels ticked under Webhook go. To start a Devin Automation, add a <strong>Webhook</strong> trigger to it in Devin and paste its URL and secret here. ${doc(DOCS.automations, 'Devin docs: Automations')}</p>
      <p class="muted small">${webhook
        ? html`Webhook is <strong>set, host ${webhook.hint}</strong>${webhook.hasSecret ? ', with a secret' : ', without a secret'}.`
        : 'No webhook yet.'}</p>
      ${editable(canEdit, html`<label>URL ${help('the webhook URL', html`<p>An https URL on a public host. The bot POSTs one JSON body per message, with <code>type</code>, <code>guild</code>, <code>channel</code> and <code>message</code> (text, author, link, attachments). It doesn't follow redirects and gives up after 5 seconds.</p><p>The URL is stored encrypted and never shown again; only its host is.</p>`)}
          <input type="url" name="url" maxlength="2048" placeholder="${webhook ? 'Leave empty to keep the current URL' : 'https://…'}" spellcheck="false" autocomplete="off">
        </label>
        <label>Secret ${help('the webhook secret', html`<p>Sent in the <code>X-Webhook-Secret</code> header, which is what Devin Automation webhooks check. Stored encrypted and never shown again.</p>`)}
          <input type="password" name="secret" maxlength="512" placeholder="${webhook?.hasSecret ? 'Leave empty to keep the current secret' : 'Optional'}" autocomplete="new-password">
        </label>
        <label class="check"><input type="checkbox" name="include_threads" ${webhook?.includeThreads ? 'checked' : ''}> Also send messages in threads and forum posts under a ticked channel</label>
        <label class="check"><input type="checkbox" name="include_bots" ${webhook?.includeBots ? 'checked' : ''}> Also send messages from other bots and Discord webhooks</label>
        <p class="muted small">When off, only top-level messages from members are sent. In a forum, posts are threads, so turn on the first option for forums.</p>
        <button class="button">Save webhook</button>`)}
    </form>
    ${webhook && canEdit
      ? html`<form class="card danger" method="post" action="${action}/webhook/remove">
          ${csrfField(session)}
          <h2>Remove the webhook</h2>
          <p class="muted">Stops sending messages. The Webhook ticks are kept.</p>
          <button class="button danger">Remove webhook</button>
        </form>`
      : ''}`
  });
}

const MCP_TOOLS: [string, string][] = [
  ['read_task_thread', "read the task's thread"],
  ['post_to_task_thread', 'post in it, without pinging anyone'],
  ['post_to_channel', 'post in the channels allowed below (in a forum: start a post or reply in one), without pinging anyone'],
  ['add_reaction', 'react to messages in it'],
  ['list_channels', 'list the channels it may read and post in'],
  ['read_channel', 'read a channel allowed under Read (or its threads); for a forum, list its posts'],
  ['get_message', 'read one message, e.g. from a link']
];

export function mcpPage(
  session: WebSession,
  guild: { id: string; name: string },
  url: string,
  settings: { channels: ChannelInfo[]; read: string[]; post: string[]; allowed: string[]; modes: McpModes },
  token: { hint: string; createdAt: number } | null,
  newToken: string | null,
  notice: PageOptions['notice'],
  canEdit: boolean,
  query = ''
) {
  const created = token ? new Date(token.createdAt).toISOString().slice(0, 10) : '';
  const readSet = new Set(settings.read);
  const postSet = new Set(settings.post);
  const allowedSet = new Set(settings.allowed);
  const shown = matchChannels(settings.channels, query);
  const groups = byCategory(shown);
  const action = `/g/${guild.id}/mcp`;
  const ticked = (list: ChannelInfo[]) =>
    list.filter((channel) => readSet.has(channel.id) || postSet.has(channel.id)).length;
  const inheritedChannels = settings.channels
    .filter((channel) => allowedSet.has(channel.id))
    .map((channel) => `#${channel.name}`);
  const { modes } = settings;
  const readSummary =
    modes.read === 'bot'
      ? "Reading: every channel the bot can read in Discord. The Read ticks are kept but not used."
      : settings.read.length
        ? 'Reading: only the ticked channels.'
        : `Reading: none ticked, so it follows the Channels tab: ${settings.allowed.length ? inheritedChannels.join(', ') : 'channels @everyone can see'}.`;
  const postSummary =
    modes.post === 'bot'
      ? "Posting: every channel the bot can post in. The Post ticks are kept but not used."
      : settings.post.length
        ? 'Posting: only the ticked channels.'
        : 'Posting: none ticked, so only its own task threads.';
  const modeChoice = (name: 'read_mode' | 'post_mode', mode: 'custom' | 'bot', label: string, bot: string) =>
    html`<p class="check"><strong>${label}</strong>
      <label class="check"><input type="radio" name="${name}" value="custom" ${mode === 'custom' ? 'checked' : ''}> Custom: the ticked channels</label>
      <label class="check"><input type="radio" name="${name}" value="bot" ${mode === 'bot' ? 'checked' : ''}> ${bot}</label></p>`;
  const hasBotPermissionLimits = settings.channels.some(
    (channel) => channel.bot?.read === false || channel.bot?.post === false
  );
  return layout({
    title: `${guild.name} · MCP`,
    session,
    guild: { ...guild, tab: 'mcp' },
    notice,
    body: html`<section class="card">
      <h2>Devin MCP server</h2>
      <p class="muted">Lets Devin use Discord during a task: read its task thread, post and react there, and read and post in the channels you pick below. Everything it reads is marked untrusted. It can't reach other servers or channels that aren't allowed.</p>
      ${newToken
        ? html`<div class="notice ok"><strong>Your new token</strong>. Copy it now; it isn't shown again.<br><code class="token">${newToken}</code></div>`
        : ''}
      <label>Server URL ${help('the server URL', html`<p>Paste this as the URL of a custom MCP server in Devin, with transport <strong>HTTP</strong>.</p><p>It comes from <code>PUBLIC_URL</code>. On a Cloudflare quick tunnel it changes whenever the tunnel restarts, so update it in Devin when that happens.</p>`)}
        <input readonly value="${url}" spellcheck="false">
      </label>
      <label>Token ${help('the token', html`<p>A bearer token that identifies this server. Anyone with it can read and post where the Channels section below allows (in Bot's Discord permissions mode, everywhere the bot can), so keep it in Devin only.</p><p>Task threads need more than the token: each task's session gets its own task key in its prompt.</p><p>Generating a new one stops the old one at once.</p>`)}</label>
      <p class="muted small">${token ? html`Token is <strong>set, ends in …${token.hint}</strong>, created ${created}.` : 'No token yet. Generate one to turn the MCP server on.'}</p>
      ${canEdit ? '' : ADMIN_ONLY_NOTE}
      <form method="post" action="/g/${guild.id}/mcp/token">${csrfField(session)}${editable(canEdit, html`<button class="button">${token ? 'Generate a new token' : 'Generate token'}</button>`)}</form>
      <h3>Add it to Devin</h3>
      <ol class="steps">
        <li>In Devin, open <strong>Customize → MCPs</strong>, then <strong>Add MCP → Add custom MCP</strong>. It needs the Manage MCP Servers permission.</li>
        <li>Transport <strong>HTTP</strong>, URL as above.</li>
        <li>Authentication <strong>Auth Header</strong>: key <code>Authorization</code>, value <code>Bearer ${newToken ?? '<your token>'}</code>.</li>
        <li>Save, then click <strong>Test tools</strong>.</li>
      </ol>
      <p class="muted small">${doc(DOCS.mcp, 'Devin docs: custom MCP servers')}</p>
      <h3>Tools</h3>
      <ul class="steps">${MCP_TOOLS.map(([name, text]) => html`<li><code>${name}</code>: ${text}</li>`)}</ul>
      <p class="muted small">The task-thread tools take a task key that only that task's Devin session gets in its prompt, so a session can only use its own thread. Tasks started before the token was generated have no key. Stopped tasks can't post.</p>
      <h3>Channels</h3>
      ${channelSearchForm(action)}
      <form method="post" action="/g/${guild.id}/mcp/channels">
        ${csrfField(session)}
        ${editable(canEdit, html`${modeChoice('read_mode', modes.read, 'Read', "Bot's Discord permissions: every channel the bot can read")}
        ${modeChoice('post_mode', modes.post, 'Post', "Bot's Discord permissions: every channel the bot can post in")}
        <p class="muted small">${help('the channel modes', html`<p><strong>Custom</strong> uses the ticks below (and their fallbacks).</p><p><strong>Bot's Discord permissions</strong> lets Devin read, or post in, every channel and public thread where the bot's role has View Channel and Read Message History (Read) or Send Messages (Post), including channels created later and other tasks' public threads. Private threads stay off-limits.</p><p>Anyone with the token gets that reach, so give the bot's role only the access you want Devin to have.</p>`)} Switching keeps your ticks, so you can switch back.</p>`)}
        ${channelTools(action, query, shown.length, settings.channels.length)}
        ${editable(canEdit, html`${listScope(query, shown)}<table class="grid">
          <thead><tr>
            <th>Channel</th>
            <th>Read ${help('MCP read channels', html`<p>Channels Devin may read through MCP (<code>list_channels</code>, <code>read_channel</code>, <code>get_message</code>), and the public threads inside them. Private threads are never readable. Devin reads its own task thread with <code>read_task_thread</code>, using a key only that task's session gets; it can't open other task threads unless their channel is ticked.</p><p>With none ticked, it follows the Allowed list on the Channels tab. When that's empty too, it can only read channels <strong>@everyone</strong> can see.</p><p>The bot's own Discord permissions come first: where its role can't see the channel (or send messages, for Post), nothing gets through, ticked or not.</p><p>${doc('https://support.discord.com/hc/en-us/articles/206141927-How-is-the-permission-hierarchy-structured', 'Discord permission hierarchy')}</p>`)}</th>
            <th>Post ${help('MCP posting channels', html`<p><code>post_to_channel</code> only posts in the ticked channels and threads under them. In a ticked forum it starts new posts and replies in existing ones.</p><p>Nobody is pinged. With none ticked, Devin can only post in its own task threads.</p><p>Anyone with the token can post there, so only tick channels where that's OK.</p><p>The bot's own Discord permissions come first: where its role can't see the channel (or send messages, for Post), nothing gets through, ticked or not.</p><p>${doc('https://support.discord.com/hc/en-us/articles/206141927-How-is-the-permission-hierarchy-structured', 'Discord permission hierarchy')}</p>`, true)}</th>
          </tr></thead>
            ${[...groups].map(
              ([category, list]) => html`<tbody>${categoryRow(category, 3, ticked(list))}
                ${list.map(
                  (channel) => html`<tr class="${channel.bot?.read === false || channel.bot?.post === false ? 'noaccess' : ''}">
                    <td>${channel.kind === 'text' ? html`<span class="muted">#</span> ` : ''}${channel.name}${channel.kind === 'text' ? '' : html` <span class="muted small">${KIND_LABEL[channel.kind]}</span>`}</td>
                    <td class="center"><input type="checkbox" name="read" value="${channel.id}" aria-label="Allow MCP reading in ${channel.name}" ${readSet.has(channel.id) ? 'checked' : ''}>${channel.bot?.read === false ? html`<br><span class="muted small">bot can't read here</span>` : ''}</td>
                    <td class="center"><input type="checkbox" name="post" value="${channel.id}" aria-label="Allow MCP posting in ${channel.name}" ${postSet.has(channel.id) ? 'checked' : ''}>${channel.bot?.post === false ? html`<br><span class="muted small">bot can't post here</span>` : ''}</td>
                  </tr>`
                )}</tbody>`
            )}
        </table>
        ${query && !shown.length ? html`<p class="muted small">No channels match "${query}".</p>` : ''}
        <p class="muted small">${readSummary}</p>
        <p class="muted small">${postSummary}</p>
        ${hasBotPermissionLimits
          ? html`<p class="muted small">Channels marked "bot can't…" need the bot's role to get View Channel and Read Message History (Read) or Send Messages (Post) in Discord.</p>`
          : ''}
        <button class="button">Save channels</button>`)}
      </form>
    </section>
    ${token && canEdit
      ? html`<form class="card danger" method="post" action="/g/${guild.id}/mcp/remove">
          ${csrfField(session)}
          <h2>Turn off</h2>
          <p class="muted">Revokes the token. Devin's MCP calls to this server fail until a new one is generated.</p>
          <button class="button danger">Revoke token</button>
        </form>`
      : ''}`
  });
}

export function auditPage(
  session: WebSession,
  guild: { id: string; name: string },
  entries: AuditEntry[]
) {
  return layout({
    title: `${guild.name} · Audit log`,
    session,
    guild: { ...guild, tab: 'audit' },
    body: html`<section class="card wide">
      <h2>Audit log</h2>
      <p class="muted">Entries are kept for ${RETENTION_DAYS} days.</p>
      ${entries.length
        ? html`<div class="scroll"><table class="grid audit">
            <thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
            <tbody>${entries.map(
              (entry) => html`<tr>
                <td class="nowrap">${new Date(entry.createdAt).toISOString().replace('T', ' ').slice(0, 19)}</td>
                <td>${entry.actorName} <span class="muted small">${entry.actorId}</span></td>
                <td><code>${entry.action}</code></td>
                <td class="detail">${entry.detail}</td>
              </tr>`
            )}</tbody>
          </table></div>`
        : html`<p class="muted">Nothing yet.</p>`}
    </section>`
  });
}

const MB = 1024 * 1024;

function size(bytes: number | null) {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / 1024 / MB).toFixed(2)} GB`;
}

function duration(ms: number) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days ${hours % 24} h`;
}

function ago(at: number | null, now: number) {
  return at === null ? '—' : `${duration(Math.max(0, now - at))} ago`;
}

function utc(at: number) {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 19);
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function stat(label: string, value: string | number, note?: string) {
  return html`<div class="stat"><span class="stat-v">${value}</span><span class="stat-l">${label}</span>${note ? html`<span class="stat-n">${note}</span>` : ''}</div>`;
}

export function adminPage(session: WebSession, stats: AdminStats) {
  const { servers, tasks, database: db, host, web, now } = { ...stats, now: stats.generatedAt };
  const busiest = Math.max(0, ...stats.daily.map((d) => d.tasks));
  const peak = Math.max(1, busiest);
  const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : '—');
  return layout({
    title: 'Admin',
    session,
    admin: true,
    body: html`<div class="guildhead"><a class="crumbs" href="/">← All servers</a><h1>Host admin</h1></div>
    <p class="muted small">Live from this host's database at ${utc(now)} UTC. Tasks and audit entries are kept ${stats.retentionDays} days, so usage covers the last ${stats.retentionDays} days at most. Errors and uptime reset when the bot restarts. <a href="/admin">Refresh</a></p>

    <section class="card">
      <h2>Needs attention</h2>
      ${stats.warnings.length
        ? html`<ul class="warnings">${stats.warnings.map((w) => html`<li class="${w.level}">${w.text}</li>`)}</ul>`
        : html`<p class="pill ok">All good</p>`}
    </section>

    <section class="card">
      <h2>Usage</h2>
      <div class="stats">
        ${stat('tasks, last 24 h', tasks.last24h)}
        ${stat('tasks, last 7 days', tasks.last7d, `${plural(tasks.users7d, 'member')} · ${plural(tasks.servers7d, 'server')}`)}
        ${stat(`tasks, last ${stats.retentionDays} days`, tasks.last30d, `${plural(tasks.users30d, 'member')} · ${plural(tasks.servers30d, 'server')}`)}
        ${stat('opened a PR', pct(tasks.withPr30d, tasks.last30d), `${tasks.withPr30d} of ${tasks.last30d} tasks`)}
        ${stat('active now', tasks.active, `${tasks.sleeping} sleeping`)}
      </div>
      <h3>Tasks per day (UTC)</h3>
      <div class="bars" role="img" aria-label="Tasks started per day over the last 30 days">${stats.daily.map(
        (d) => html`<div class="bar" title="${d.day}: ${d.tasks} tasks by ${d.users} members"><span style="height:${Math.round((100 * d.tasks) / peak)}%"></span></div>`
      )}</div>
      <div class="row between muted small"><span>${stats.daily[0]?.day ?? ''}</span><span>busiest day: ${busiest} tasks</span><span>${stats.daily.at(-1)?.day ?? ''}</span></div>
      ${tasks.states.length
        ? html`<h3>Active tasks by status</h3><p>${tasks.states.map((s) => html`<span class="pill">${s.label} · ${s.count}</span> `)}</p>`
        : ''}
      <h3>Actions, last ${stats.retentionDays} days</h3>
      ${stats.actions.length
        ? html`<div class="scroll"><table class="grid"><thead><tr><th>Action</th><th>Count</th></tr></thead><tbody>${stats.actions.map(
            (a) => html`<tr><td><code>${a.action}</code></td><td>${a.count}</td></tr>`
          )}</tbody></table></div>`
        : html`<p class="muted">Nothing in the audit log yet.</p>`}
    </section>

    <section class="card wide">
      <h2>Servers</h2>
      <div class="stats">
        ${stat('servers with the bot', servers.botIn ?? '—', servers.members === null ? 'Discord not connected' : `${servers.members} members in total`)}
        ${stat('connected to Devin', servers.configured, servers.notConfigured === null ? undefined : `${servers.notConfigured} not set up yet`)}
        ${stat('GitHub token', servers.github)}
        ${stat('MCP token', servers.mcp)}
        ${stat('webhook', servers.webhook)}
        ${stat('watched channels', servers.watched)}
        ${stat('Devin user mapping', servers.userMaps)}
      </div>
      <h3>Most active servers, last ${stats.retentionDays} days</h3>
      ${stats.topServers.length
        ? html`<div class="scroll"><table class="grid"><thead><tr><th>Server</th><th>Tasks</th><th>Members using it</th><th>Active</th><th>Last task</th><th>Status</th></tr></thead><tbody>${stats.topServers.map(
            (g) => html`<tr>
              <td>${g.name} <span class="muted small">${g.guildId}</span>${g.memberCount === null ? '' : html`<br><span class="muted small">${g.memberCount} members</span>`}</td>
              <td>${g.tasks30d}</td><td>${g.users30d}</td><td>${g.active}</td>
              <td class="nowrap">${ago(g.lastTaskAt, now)}</td>
              <td>${g.inDiscord === false ? html`<span class="pill warn">Bot removed</span>` : g.configured ? html`<span class="pill ok">Set up</span>` : html`<span class="pill warn">No Devin key</span>`}</td>
            </tr>`
          )}</tbody></table></div>`
        : html`<p class="muted">No tasks yet.</p>`}
      <p class="muted small">${plural(web.signedInUsers, 'person', 'people')} signed in to the setup UI (${plural(web.activeSessions, 'session')}), ${plural(web.signIns7d, 'sign-in')} in the last 7 days.</p>
    </section>

    <section class="card wide">
      <h2>Database</h2>
      <div class="stats">
        ${stat('file', size(db.fileBytes), `${size(db.usedBytes)} used · ${size(db.freeBytes)} free`)}
        ${stat('write-ahead log', size(db.walBytes))}
        ${stat('disk free', size(db.diskFreeBytes), db.diskTotalBytes ? `of ${size(db.diskTotalBytes)}` : undefined)}
        ${stat('schema', `v${db.schemaVersion}`)}
      </div>
      <p class="muted small"><code>${db.path}</code></p>
      <div class="scroll"><table class="grid"><thead><tr><th>Table</th><th>Rows</th><th>Size (with indexes)</th></tr></thead><tbody>${db.tables.map(
        (t) => html`<tr><td><code>${t.name}</code></td><td>${t.rows}</td><td>${size(t.bytes)}</td></tr>`
      )}</tbody></table></div>
    </section>

    <section class="card wide">
      <h2>Host</h2>
      <div class="stats">
        ${stat('Discord', host.discordReady ? 'online' : 'offline', host.discordPingMs === null ? undefined : `${host.discordPingMs} ms ping`)}
        ${stat('uptime', duration(host.uptimeMs))}
        ${stat('memory', size(host.rssBytes), `${size(host.heapUsedBytes)} heap`)}
        ${stat('Node', host.node)}
        ${stat('last cleanup', host.lastPrune ? ago(host.lastPrune.at, now) : 'not yet', host.lastPrune ? (host.lastPrune.error ? 'failed' : `${host.lastPrune.removed} rows removed`) : undefined)}
        ${stat('errors', host.errors24h, `${host.errors1h} in the last hour`)}
      </div>
      <h3>Errors, last 24 hours</h3>
      ${host.topErrors.length
        ? html`<div class="scroll"><table class="grid audit"><thead><tr><th>Count</th><th>Last (UTC)</th><th>Message</th></tr></thead><tbody>${host.topErrors.map(
            (e) => html`<tr><td>${e.count}</td><td class="nowrap">${utc(e.lastAt)}</td><td class="detail"><code>${e.text}</code></td></tr>`
          )}</tbody></table></div>
          <p class="muted small">Similar messages are grouped. Full details are in <code>docker compose logs bridge</code>.</p>`
        : html`<p class="muted">None.</p>`}
    </section>`
  });
}

export function errorPage(session: WebSession | null, title: string, text: string) {
  return layout({
    title,
    session,
    body: html`<section class="card"><h1>${title}</h1><p>${text}</p><p><a href="/">Back to servers</a></p></section>`
  });
}

export const CSS = `
:root{color-scheme:dark;--bg:#0e0f13;--card:#17181e;--card-2:#1e2028;--field:#0b0c10;--line:rgba(255,255,255,.08);--line-2:rgba(255,255,255,.14);--text:#e3e5e8;--muted:#9a9fac;--accent:#5865f2;--accent-2:#8891ff;--ok:#23a55a;--warn:#f0b232;--bad:#ed4245;--radius:12px}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:radial-gradient(1100px 480px at 50% -220px,rgba(88,101,242,.28),transparent 70%),var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent-2);text-underline-offset:2px}a:hover{color:#b3b9ff}
:focus-visible{outline:2px solid var(--accent-2);outline-offset:2px}
code{background:var(--field);border:1px solid var(--line);padding:1px 6px;border-radius:5px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
h1,h2,h3{color:#fff;letter-spacing:-.01em}h1{font-size:24px;margin:0 0 12px}h2{font-size:18px;margin:0 0 8px}h3{font-size:15px;margin:24px 0 8px}
.top{position:sticky;top:0;z-index:20;background:rgba(14,15,19,.75);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.top-in{max-width:1080px;margin:0 auto;padding:12px 24px;display:flex;justify-content:space-between;align-items:center;gap:16px}
.brand{display:inline-flex;align-items:center;gap:10px;color:#fff;font-weight:800;text-decoration:none;font-size:17px;letter-spacing:-.02em}.brand:hover{color:#fff}
.brand img{border-radius:9px;box-shadow:0 2px 10px rgba(88,101,242,.45)}.brand b{color:var(--accent-2);font-weight:inherit}
.brand.small{font-size:14px;gap:8px}.brand.small img{border-radius:6px;box-shadow:none}
.navlink{color:var(--muted);text-decoration:none;font-weight:600;padding:6px 10px;border-radius:8px}.navlink:hover{color:#fff;background:rgba(255,255,255,.06)}
.me{display:flex;gap:6px;align-items:center}.me form{margin:0}
.user{display:inline-flex;align-items:center;gap:8px;margin:0 6px 0 8px;padding-left:14px;border-left:1px solid var(--line);font-weight:600}
.avatar{width:28px;height:28px;border-radius:50%;flex:none}.avatar.blank{display:inline-flex;align-items:center;justify-content:center;background:var(--accent);color:#fff;font-size:13px;text-transform:uppercase}
main{flex:1;width:100%;max-width:1080px;margin:0 auto;padding:32px 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:24px 28px;margin-bottom:20px}
.card > :last-child{margin-bottom:0}
.card.danger{border-color:rgba(237,66,69,.35);background:linear-gradient(rgba(237,66,69,.05),rgba(237,66,69,.05)),var(--card)}.card.danger h2{color:#ff8a8c}
.card.danger .button{margin-top:4px}
.hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:48px;align-items:center;margin:32px 0 56px}
.eyebrow{display:inline-block;margin:0 0 16px;padding:4px 12px;border:1px solid rgba(136,145,255,.35);border-radius:999px;background:rgba(88,101,242,.12);color:#c3c8ff;font-size:13px;font-weight:600}
.hero h1{font-size:clamp(34px,5vw,52px);line-height:1.08;margin:0 0 18px;letter-spacing:-.03em}
.grad{background:linear-gradient(90deg,#8891ff,#eb459e);-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{font-size:18px;color:#c9ccd3;margin:0 0 8px}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0 12px}.actions .button{margin-top:0}
.demo{background:#313338;border:1px solid var(--line-2);border-radius:16px;padding:0 0 16px;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 6px rgba(88,101,242,.12);font-size:14px;overflow:hidden;color:#dbdee1}
.demo p{margin:0}.demo code{background:#232428;border:0}
.demo-bar{padding:12px 16px;border-bottom:1px solid #26272b;font-weight:700;color:#f2f3f5;margin-bottom:14px}
.msg{display:flex;gap:12px;padding:4px 16px}.msg + .msg{margin-top:10px}
.pfp{width:36px;height:36px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:700}
.who{font-weight:600;color:#f2f3f5}.when{color:#949ba4;font-size:12px;font-weight:400;margin-left:4px}
.tag{background:#5865f2;color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;vertical-align:1px}
.mention{background:rgba(88,101,242,.3);color:#c9cdfb;border-radius:3px;padding:0 2px;font-weight:500}
.thread{margin:14px 16px 0 64px;padding:12px 0 2px;border-left:2px solid #4e5058;border-radius:0 8px 8px 0;background:#2b2d31}
.thread .msg{padding:4px 14px}.thread-title{font-weight:700;color:#f2f3f5;padding:0 14px 8px;font-size:13px}
.embed{margin-top:8px;padding:10px 12px;background:#232428;border-left:4px solid var(--ok);border-radius:4px;display:flex;flex-direction:column;gap:2px}.embed strong{color:#00a8fc}.embed span{color:#b5bac1;font-size:12px}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:20px}
.feature{margin:0;transition:border-color .15s,transform .15s}.feature:hover{border-color:rgba(136,145,255,.35);transform:translateY(-2px)}
.feature h2{font-size:16px;margin-top:14px}.feature p{margin:0;color:#c3c6cd}
.community{display:flex;align-items:center;justify-content:space-between;gap:16px 24px;flex-wrap:wrap;margin-top:20px;padding:32px;background:linear-gradient(120deg,rgba(88,101,242,.28),rgba(235,69,158,.14));border-color:rgba(136,145,255,.45)}.community h2{margin:0 0 6px;font-size:24px}.community p{margin:0;color:#d5d8ff;font-size:16px}.community .button{margin-top:0;padding:14px 26px;font-size:17px;box-shadow:0 8px 24px rgba(88,101,242,.45)}
.joinbar{display:flex;align-items:center;gap:14px;margin-top:20px;padding:14px 18px;border:1px solid rgba(136,145,255,.45);border-radius:12px;background:linear-gradient(120deg,rgba(88,101,242,.22),rgba(88,101,242,.08));color:#fff;text-decoration:none;transition:border-color .15s,background .15s,transform .15s}.joinbar:hover{border-color:#8891ff;background:linear-gradient(120deg,rgba(88,101,242,.34),rgba(88,101,242,.14));transform:translateY(-1px)}
.joinbar strong{display:block;font-size:16px}.joinbar strong + span{display:block;color:#c3c8ff;font-size:14px}
.joinlogo{display:inline-flex;flex:none;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;background:var(--accent);color:#fff}.joinlogo svg{width:26px;height:26px}
.joinarrow{margin-left:auto;font-size:20px;color:#c3c8ff}
.me .button{white-space:nowrap}.navlink.navdiscord{display:inline-flex;align-items:center;gap:6px;color:#c3c8ff}.navlink.navdiscord svg{width:18px;height:18px}
.ico{display:block;width:40px;height:40px;padding:9px;border-radius:10px;background:rgba(88,101,242,.16);color:var(--accent-2)}
.flow{list-style:none;counter-reset:step;padding:0;margin:16px 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.flow li{counter-increment:step;background:var(--card-2);border:1px solid var(--line);border-radius:10px;padding:16px;color:#c3c6cd}
.flow li::before{content:counter(step);display:flex;align-items:center;justify-content:center;width:28px;height:28px;margin-bottom:10px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;font-size:14px}
.flow li strong{display:block;color:#fff}
.docs{display:grid;grid-template-columns:200px minmax(0,1fr);gap:28px;align-items:start}
.toc{position:sticky;top:84px;display:flex;flex-direction:column;gap:2px}.toc p{margin:0 0 6px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;font-size:11px}
.toc a{color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:8px;font-weight:500}.toc a:hover{color:#fff;background:rgba(255,255,255,.06)}
.docs-body .card{max-width:780px}.doc{scroll-margin-top:84px}.doc h2 a.anchor{color:#fff;text-decoration:none}.doc h2 a.anchor:hover::after{content:" #";color:var(--muted)}
.doc ul ul{margin:4px 0}.faq dt{font-weight:600;color:#fff;margin-top:14px}.faq dd{margin:4px 0 0;color:#c3c6cd}
.foot{border-top:1px solid var(--line);color:var(--muted);font-size:13px;padding:24px;margin-top:24px}
.foot-in{max-width:1032px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.foot nav{display:flex;gap:18px}.foot nav a{color:var(--muted);text-decoration:none}.foot nav a:hover{color:#fff}
.foot > p{max-width:1032px;margin:10px auto 0}
.muted{color:var(--muted)}.small{font-size:13px}.nowrap{white-space:nowrap}
label{display:block;margin:20px 0 4px;font-weight:600;color:#fff}
.hint{display:block;font-weight:400;font-size:13px;color:var(--muted);margin-top:2px}
.optional{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:rgba(255,255,255,.06);border-radius:4px;padding:1px 6px;margin-left:4px;vertical-align:1px}
fieldset{border:0;margin:0;padding:0;min-width:0}fieldset:disabled .button{opacity:.5;cursor:not-allowed}fieldset:disabled input,fieldset:disabled textarea{opacity:.7}
label.check{display:flex;gap:10px;align-items:center;font-weight:500;margin:10px 0 4px}
label.check input{width:auto;margin:0}
input.narrow{max-width:120px;display:block}
input,textarea{width:100%;margin-top:8px;padding:10px 12px;background:var(--field);border:1px solid var(--line-2);border-radius:8px;color:var(--text);font:inherit;font-weight:400;transition:border-color .15s,box-shadow .15s}
textarea{resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
input:hover,textarea:hover{border-color:rgba(255,255,255,.22)}
input:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(88,101,242,.3)}
input[readonly]{color:var(--muted)}
input::placeholder,textarea::placeholder{color:#6b7080}
input[type=checkbox],input[type=radio]{width:18px;height:18px;margin:0;accent-color:var(--accent);cursor:pointer;box-shadow:none}
input.num{width:96px;margin:0;padding:6px 10px}
.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;margin-top:20px;padding:10px 18px;background:var(--accent);color:#fff;border:1px solid transparent;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;transition:background .15s,transform .05s,box-shadow .15s;box-shadow:0 1px 0 rgba(255,255,255,.12) inset}
.button:hover{background:#4752c4;color:#fff}.button:active{transform:translateY(1px)}
.button.secondary{background:rgba(255,255,255,.07);border-color:var(--line-2)}.button.secondary:hover{background:rgba(255,255,255,.12)}
.button.danger{background:var(--bad)}.button.danger:hover{background:#c93b3e}
.button.ghost{background:transparent;border-color:var(--line-2);color:var(--muted);box-shadow:none}.button.ghost:hover{color:#fff;background:rgba(255,255,255,.06)}
.button.small{margin:0;padding:6px 12px;font-size:14px}.button.big{padding:12px 22px;font-size:16px}
.servers .button,.row .button{margin-top:0}
button.link{background:none;border:0;color:var(--muted);cursor:pointer;font:inherit;text-decoration:underline}
.row{display:flex;align-items:center;gap:12px}.between{justify-content:space-between}.grow{flex:1;font-weight:600;color:#fff}
.row h1{margin:0}.row p{margin:4px 0 0}
.servers{list-style:none;padding:0;margin:20px 0 16px;display:flex;flex-direction:column;gap:8px}
.servers li{display:flex;align-items:center;gap:14px;padding:12px 14px;background:var(--card-2);border:1px solid var(--line);border-radius:10px;transition:border-color .15s}.servers li:hover{border-color:var(--line-2)}
.icon{width:40px;height:40px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#5865f2,#8891ff);color:#fff;font-weight:700;text-transform:uppercase}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.07);color:var(--muted)}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.ok{background:rgba(35,165,90,.15);color:#6ddf9a}.pill.warn{background:rgba(240,178,50,.14);color:var(--warn)}
.guildhead{margin-bottom:8px}.guildhead h1{display:flex;align-items:center;gap:12px;margin:6px 0 16px;font-size:26px}
.crumbs{color:var(--muted);text-decoration:none;font-size:14px;font-weight:500}.crumbs:hover{color:#fff}
.tabs{display:flex;gap:4px;margin-bottom:24px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.tabs a{padding:10px 14px;color:var(--muted);text-decoration:none;font-weight:600;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap;border-radius:8px 8px 0 0}
.tabs a:hover{color:#fff;background:rgba(255,255,255,.04)}.tabs a.active{color:#fff;border-color:var(--accent)}
.notice{display:flex;gap:10px;align-items:flex-start;padding:12px 16px;border-radius:10px;border:1px solid;margin:0 0 20px}
.notice::before{flex:none;width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#0e0f13;margin-top:1px}
.notice.ok{background:rgba(35,165,90,.1);border-color:rgba(35,165,90,.35)}.notice.ok::before{content:"✓";background:#6ddf9a}
.notice.error{background:rgba(237,66,69,.1);border-color:rgba(237,66,69,.35)}.notice.error::before{content:"!";background:#ff8a8c}
.card .notice{display:block}.card .notice::before{display:none}
.scroll{overflow-x:auto;margin:0 -8px;padding:0 8px}
table.grid{width:100%;border-collapse:collapse;margin-top:12px}.grid th,.grid td{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
.grid th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700;background:var(--card-2)}
.grid thead th:first-child{border-radius:8px 0 0 8px}.grid thead th:last-child{border-radius:0 8px 8px 0}
.grid thead th{border-bottom:0}.grid .center{text-align:center}
.grid tbody tr:not(.group):hover td{background:rgba(255,255,255,.025)}
.grid tr.group td{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);padding-top:18px}
tr.noaccess td:first-child { opacity: .55 }
.listtools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:16px 0 0}
.listtools input[type=search]{flex:1 1 220px;width:auto;margin:0}.listtools .button{margin-top:0}
.listtools label.check{margin:0;font-weight:500;white-space:nowrap}
label.fold{display:inline-flex;gap:8px;align-items:center;margin:0;cursor:pointer;font-weight:700;user-select:none;color:var(--muted)}
label.fold:hover{color:#fff}
label.fold input{position:absolute;opacity:0;width:1px;height:1px}
label.fold .cat::before{content:"▾";display:inline-block;width:14px}
tbody:has(label.fold input:checked) label.fold .cat::before{content:"▸"}
label.fold:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
label.fold .count{text-transform:none;font-weight:600;letter-spacing:0;color:var(--accent-2);background:rgba(88,101,242,.15);padding:0 8px;border-radius:999px}
tbody:has(label.fold input:checked) tr:not(.group){display:none}
form:has(.only-ticked:checked) tbody tr:not(.group):not(:has(input[name]:checked)){display:none}
form:has(.only-ticked:checked) tbody:not(:has(input[name]:checked)){display:none}
.none-ticked{display:none}form:has(.only-ticked:checked):not(:has(tbody input[name]:checked)) .none-ticked{display:block}
.help{display:inline-block;position:relative;margin-left:4px;vertical-align:middle;font-size:13px;font-weight:400;text-transform:none;letter-spacing:normal}
.help summary{list-style:none;cursor:pointer;width:18px;height:18px;border-radius:50%;background:rgba(255,255,255,.1);color:#c3c6cd;font-size:11px;font-weight:700;line-height:18px;text-align:center;user-select:none;transition:background .15s}
.help summary::-webkit-details-marker{display:none}.help summary:hover,.help[open] summary{background:var(--accent);color:#fff}
.help .tip{position:absolute;z-index:10;top:26px;left:-10px;width:340px;max-width:80vw;padding:12px 16px;background:#0b0c10;border:1px solid var(--line-2);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.6);color:var(--text);line-height:1.5;white-space:normal;text-align:left;font-weight:400;font-size:13px}
.help.end .tip{left:auto;right:-10px}.help .tip p{margin:0 0 8px}.help .tip p:last-child{margin:0}
.grid td.role{white-space:nowrap;font-weight:600}
.grid.audit td{vertical-align:top}.grid.audit td.detail{overflow-wrap:anywhere}
.steps{padding-left:22px;margin:8px 0}.steps li{margin:6px 0}.steps li::marker{color:var(--muted)}
code.token{display:inline-block;margin-top:8px;padding:6px 10px;word-break:break-all;user-select:all;font-size:14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.stat{display:flex;flex-direction:column;gap:2px;padding:14px 16px;background:var(--card-2);border:1px solid var(--line);border-radius:10px}
.stat-v{font-size:24px;font-weight:800;color:#fff;line-height:1.2;overflow-wrap:break-word}.stat-l{font-size:13px;color:var(--muted)}.stat-n{font-size:12px;color:var(--muted)}
.bars{display:flex;align-items:flex-end;gap:3px;height:120px;padding:8px 0;border-bottom:1px solid var(--line-2)}
.bar{flex:1;height:100%;display:flex;align-items:flex-end}.bar span{display:block;width:100%;min-height:2px;border-radius:3px 3px 0 0;background:linear-gradient(var(--accent-2),var(--accent))}
.warnings{list-style:none;padding:0;margin:12px 0 0;display:flex;flex-direction:column;gap:8px}
.warnings li{padding:10px 14px;border-radius:8px;border:1px solid}.warnings li.warn{background:rgba(240,178,50,.08);border-color:rgba(240,178,50,.35)}.warnings li.bad{background:rgba(237,66,69,.1);border-color:rgba(237,66,69,.4)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:10px}
@media (max-width:860px){.hero{grid-template-columns:1fr;gap:32px;margin-top:8px}.docs{grid-template-columns:1fr}.toc{position:static;flex-flow:row wrap}}
@media (max-width:600px){main{padding:20px 14px}.top-in{padding:10px 14px}.card{padding:18px}.username,.me .navlink[href="/"],.navlink.navdiscord span{display:none}.user{margin:0 2px;padding-left:8px}.thread{margin-left:16px}.row.between{flex-wrap:wrap}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
`;

/** Changes whenever the CSS does, so browsers don't keep a cached copy after an update. */
export const CSS_VERSION = createHash('sha256').update(CSS).digest('hex').slice(0, 10);
