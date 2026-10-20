import { createHash } from 'node:crypto';
import { html, raw } from 'hono/html';
import type { ChannelInfo, RoleInfo } from '../directory.ts';
import { DEFAULT_INSTRUCTIONS } from '../format.ts';
import { MAX_CONTEXT_MESSAGES, type AuditEntry } from '../guilds.ts';

export type MentionSettings = { contextMessages: number; mentionOnlyReplies: boolean };
import { ADMIN_ROLE, PERMISSIONS, PERMISSION_LABELS, adminRule, type RoleRule } from '../permissions.ts';
import type { WebSession } from './sessions.ts';

type Html = ReturnType<typeof html>;

export type GuildTab = 'devin' | 'permissions' | 'channels' | 'mcp' | 'audit';

export type PageOptions = {
  title: string;
  session?: WebSession | null;
  guild?: { id: string; name: string; tab: GuildTab };
  notice?: { kind: 'ok' | 'error'; text: string } | null;
  body: Html | Html[];
};

function avatarUrl(session: WebSession) {
  return session.avatar
    ? `https://cdn.discordapp.com/avatars/${session.userId}/${session.avatar}.png?size=64`
    : null;
}

const DOCS = {
  serviceUsers: 'https://docs.devin.ai/api-reference/authentication#service-users-recommended-for-automation',
  permissions: 'https://docs.devin.ai/api-reference/v3/overview',
  createSession: 'https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions',
  billing: 'https://docs.devin.ai/admin/billing',
  mcp: 'https://docs.devin.ai/work-with-devin/mcp',
  discordIds: 'https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID'
};

function doc(href: string, text: string) {
  return html`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

/** A "?" that opens an explanation on click; `end` anchors it to the right for columns near the edge. */
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
</head>
<body>
<header class="top">
  <a class="brand" href="/">devin4discord</a>
  ${session
    ? html`<div class="me">
        ${avatar ? html`<img class="avatar" src="${avatar}" alt="">` : ''}
        <span>${session.username}</span>
        <form method="post" action="/auth/logout">${csrfField(session)}<button class="link">Sign out</button></form>
      </div>`
    : ''}
</header>
<main>
  ${guild
    ? html`<p class="crumbs"><a href="/">Servers</a> / ${guild.name}</p>
      <nav class="tabs">${tabs.map(
        ([tab, label]) =>
          html`<a href="/g/${guild.id}/${tab}" class="${tab === guild.tab ? 'active' : ''}">${label}</a>`
      )}</nav>`
    : ''}
  ${page.notice ? html`<p class="notice ${page.notice.kind}">${page.notice.text}</p>` : ''}
  ${page.body}
</main>
</body>
</html>`;
}

export function landingPage() {
  return layout({
    title: 'Sign in',
    body: html`<section class="card hero">
      <h1>Devin for Discord</h1>
      <p>Start and follow Devin tasks from your Discord server. Sign in to set up a server you manage.</p>
      <a class="button" href="/auth/login">Sign in with Discord</a>
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

export function pickerPage(session: WebSession, rows: PickerRow[], inviteAny: string) {
  const icon = (row: PickerRow) =>
    row.icon
      ? html`<img class="icon" src="https://cdn.discordapp.com/icons/${row.id}/${row.icon}.png?size=64" alt="">`
      : html`<span class="icon blank">${row.name.slice(0, 1)}</span>`;
  return layout({
    title: 'Servers',
    session,
    body: html`<section class="card">
      <div class="row between"><h1>Your servers</h1><a class="button secondary" href="${inviteAny}">Add to Discord</a></div>
      ${rows.length
        ? html`<ul class="servers">${rows.map(
            (row) => html`<li>
              ${icon(row)}
              <span class="grow">${row.name}</span>
              ${row.action === 'configure'
                ? html`<span class="pill ${row.configured ? 'ok' : 'warn'}">${row.configured ? 'Set up' : 'Not set up'}</span>
                    <a class="button" href="/g/${row.id}/devin">Configure</a>`
                : html`<a class="button secondary" href="${row.inviteUrl}">Add to Discord</a>`}
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
};

export function devinPage(
  session: WebSession,
  guild: { id: string; name: string },
  form: DevinForm,
  notice: PageOptions['notice'],
  canEditUserMap: boolean
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
      <label>Default repos <span class="muted">(one per line, owner/repo)</span> ${help('default repos', html`<p>Repositories every task starts with, for example <code>fmflex/devin4discord</code>. They're sent as the new session's <code>repos</code>, so Devin starts in the right code.</p>
        <p>Leave empty to send none.</p>
        <p>${doc(DOCS.createSession, 'Devin docs: create session')}</p>`)}
        <textarea name="repos" rows="3" spellcheck="false">${form.repos}</textarea>
      </label>
      <label>Run as Devin users <span class="muted">(optional, one per line: Discord user ID, space, Devin user ID)</span> ${help('running as Devin users', html`<p>By default every task is created by the service user. List a Discord member here with their Devin user ID (<code>user-…</code>), and tasks they start and replies they send are made as that Devin user.</p>
        <p>Example: <code>123456789012345678 user-0123abcd…</code></p>
        <p>To copy a Discord user ID, turn on Developer Mode in Discord (User Settings → Advanced), then right-click the member → Copy User ID.</p>
        <p>Only Discord Administrators can change this list. Each Devin user is checked to be in the organization before saving, and every change is written to the audit log.</p>
        <p>Needs <code>ImpersonateOrgSessions</code> and <code>ViewOrgMembership</code> on the service user. The Devin user must be in the organization and allowed to use Devin.</p>
        <p>${doc(DOCS.discordIds, 'Discord: finding IDs')} · ${doc(DOCS.createSession, 'Devin docs: create_as_user_id')}</p>`)}
        <textarea name="user_map" rows="3" spellcheck="false"${canEditUserMap ? '' : ' readonly'}>${form.userMap}</textarea>
      </label>
      ${canEditUserMap ? '' : html`<p class="muted small">Only Discord Administrators can change who runs as which Devin user.</p>`}
      <label>Extra instructions <span class="muted">(added to every task; a default is used when empty)</span> ${help('extra instructions', html`<p>Added to the prompt of every task from this server, for example your conventions or "open PRs as drafts".</p>
        <p>When empty, this default is used: <em>${DEFAULT_INSTRUCTIONS}</em></p>`)}
        <textarea name="instructions" rows="3">${form.instructions}</textarea>
      </label>
      <button class="button">Check and save</button>
    </form>
    ${form.keyHint
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
  settings: html`<p>Use this setup site for the server. Members with Administrator or Manage Server always can.</p>`
};

function roleColor(role: RoleInfo) {
  return role.color ? `#${role.color.toString(16).padStart(6, '0')}` : '#99aab5';
}

export function permissionsPage(
  session: WebSession,
  guild: { id: string; name: string },
  roles: RoleInfo[],
  rules: RoleRule[],
  notice: PageOptions['notice']
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
      <div class="scroll"><table class="grid">
        <thead><tr><th>Role ${help('roles', html`<p>Roles are read live from Discord. A member gets every permission any of their roles grants.</p><p>For limits, the most generous of their roles that can start tasks applies.</p>`)}</th>${PERMISSIONS.map((p) => html`<th>${PERMISSION_LABELS[p]} ${help(PERMISSION_LABELS[p], PERMISSION_HELP[p])}</th>`)}
          <th>ACU cap / task ${help('the ACU cap', html`<p>The most ACUs (Agent Compute Units, how Devin usage is measured) one task may use. It's sent as the session's <code>max_acu_limit</code>.</p><p>Empty means no cap.</p><p>${doc(DOCS.billing, 'Devin docs: billing and ACUs')} · ${doc(DOCS.createSession, 'create session')}</p>`, true)}</th>
          <th>Tasks / day ${help('tasks per day', html`<p>How many tasks one member may start in any 24 hours.</p><p>Empty means no limit; 0 blocks starting.</p>`, true)}</th>
          <th>Concurrent ${help('concurrent tasks', html`<p>How many tasks one member may have running at once. Finished and stopped tasks don't count; sleeping ones do.</p><p>Empty means no limit.</p>`, true)}</th></tr></thead>
        <tbody>
          ${row(ADMIN_ROLE, 'Administrator', '#f04747', adminRule(rules), '(Discord permission)')}
          ${roles.map((role) => row(role.id, role.name, roleColor(role), byRole.get(role.id)))}
        </tbody>
      </table></div>
      <button class="button">Save permissions</button>
    </form>`
  });
}

const KIND_LABEL: Record<ChannelInfo['kind'], string> = {
  text: '#',
  announcement: 'announcements',
  forum: 'forum'
};

export function channelsPage(
  session: WebSession,
  guild: { id: string; name: string },
  channels: ChannelInfo[],
  allowed: string[],
  taskChannelId: string | null,
  mention: MentionSettings,
  notice: PageOptions['notice']
) {
  const allowedSet = new Set(allowed);
  const groups = new Map<string, ChannelInfo[]>();
  for (const channel of [...channels].sort((a, b) => a.position - b.position)) {
    const key = channel.category ?? 'No category';
    groups.set(key, [...(groups.get(key) ?? []), channel]);
  }
  return layout({
    title: `${guild.name} · Channels`,
    session,
    guild: { ...guild, tab: 'channels' },
    notice,
    body: html`<form class="card wide" method="post" action="/g/${guild.id}/channels">
      ${csrfField(session)}
      <h2>Channels</h2>
      <p class="muted"><strong>Allowed</strong>: where @Devin, the robot reaction, "Send to Devin" and <code>/devin start</code> work. None ticked means every channel.
        <strong>Task channel</strong>: where task threads open; by default the thread opens in the channel the request came from.</p>
      <table class="grid">
        <thead><tr><th>Channel</th>
          <th>Allowed ${help('allowed channels', html`<p>Where tasks can be started. Threads inside an allowed channel count too.</p><p>With none ticked, every channel the bot can see is allowed.</p>`)}</th>
          <th>Task channel ${help('the task channel', html`<p>Where the task's thread is opened. With "Channel the request came from", the thread opens next to the request (on the message itself for @Devin).</p><p>Pick a channel to keep all task threads in one place.</p>`, true)}</th></tr></thead>
        <tbody>
          <tr><td class="muted">Channel the request came from</td><td></td>
            <td class="center"><input type="radio" name="task_channel" value="" aria-label="Source channel" ${taskChannelId ? '' : 'checked'}></td></tr>
          ${[...groups].map(
            ([category, list]) => html`<tr class="group"><td colspan="3">${category}</td></tr>
              ${list.map(
                (channel) => html`<tr>
                  <td>${channel.kind === 'text' ? html`<span class="muted">#</span> ` : ''}${channel.name}${channel.kind === 'text' ? '' : html` <span class="muted small">${KIND_LABEL[channel.kind]}</span>`}</td>
                  <td class="center"><input type="checkbox" name="allowed" value="${channel.id}" aria-label="Allow ${channel.name}" ${allowedSet.has(channel.id) ? 'checked' : ''}></td>
                  <td class="center"><input type="radio" name="task_channel" value="${channel.id}" aria-label="Task channel ${channel.name}" ${taskChannelId === channel.id ? 'checked' : ''}></td>
                </tr>`
              )}`
          )}
        </tbody>
      </table>
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

const MCP_TOOLS: [string, string][] = [
  ['read_task_thread', "read the task's thread"],
  ['post_to_task_thread', 'post in it, without pinging anyone'],
  ['post_to_channel', 'post in the channels ticked below, without pinging anyone'],
  ['add_reaction', 'react to messages in it'],
  ['list_channels', 'list the channels it may read and post in'],
  ['read_channel', 'read a channel ticked under Read (or its threads)'],
  ['get_message', 'read one message, e.g. from a link']
];

export function mcpPage(
  session: WebSession,
  guild: { id: string; name: string },
  url: string,
  settings: { channels: ChannelInfo[]; read: string[]; post: string[]; allowed: string[] },
  token: { hint: string; createdAt: number; createdBy: string | null } | null,
  newToken: string | null,
  notice: PageOptions['notice']
) {
  const created = token ? new Date(token.createdAt).toISOString().slice(0, 10) : '';
  const readSet = new Set(settings.read);
  const postSet = new Set(settings.post);
  const allowedSet = new Set(settings.allowed);
  const groups = new Map<string, ChannelInfo[]>();
  for (const channel of [...settings.channels].sort((a, b) => a.position - b.position)) {
    const key = channel.category ?? 'No category';
    groups.set(key, [...(groups.get(key) ?? []), channel]);
  }
  const inheritedChannels = settings.channels
    .filter((channel) => allowedSet.has(channel.id))
    .map((channel) => `#${channel.name}`);
  const readSummary = settings.read.length
    ? 'Reading: only the ticked channels.'
    : `Reading: none ticked, so it follows the Channels tab: ${settings.allowed.length ? inheritedChannels.join(', ') : 'channels @everyone can see'}.`;
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
      <label>Token ${help('the token', html`<p>A bearer token that identifies this server. Anyone with it can read the selected MCP channels (or the Channels tab's Allowed list when none are ticked, and channels @everyone can see when that's empty too) and post in selected MCP channels, so keep it in Devin only.</p><p>Task threads need more than the token: each task's session gets its own task key in its prompt.</p><p>Outside task threads it also acts with the Discord access of the member who generated it, checked on every call: Devin can only read or post where that member can, and loses that when they do.</p><p>Generating a new one stops the old one at once.</p>`)}</label>
      <p class="muted small">${token ? html`Token is <strong>set, ends in …${token.hint}</strong>, created ${created}.` : 'No token yet. Generate one to turn the MCP server on.'} Outside task threads, Devin reads and posts only where the member who generates the token can on Discord.</p>
      ${token && !token.createdBy
        ? html`<div class="notice error">This token has no recorded creator, so it only reaches task threads. Generate a new one.</div>`
        : ''}
      <form method="post" action="/g/${guild.id}/mcp/token">${csrfField(session)}<button class="button">${token ? 'Generate a new token' : 'Generate token'}</button></form>
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
      <form method="post" action="/g/${guild.id}/mcp/channels">
        ${csrfField(session)}
        <table class="grid">
          <thead><tr>
            <th>Channel</th>
            <th>Read ${help('MCP read channels', html`<p>Channels Devin may read through MCP (<code>list_channels</code>, <code>read_channel</code>, <code>get_message</code>), and the public threads inside them. Private threads are never readable. Devin reads its own task thread with <code>read_task_thread</code>, using a key only that task's session gets; it can't open other task threads unless their channel is ticked.</p><p>With none ticked, it follows the Allowed list on the Channels tab. When that's empty too, it can only read channels <strong>@everyone</strong> can see.</p><p>You can only change channels you can read yourself on Discord (or post in, for Post); the others keep their saved setting.</p><p>The bot's own Discord permissions come first: where its role can't see the channel (or send messages, for Post), nothing gets through, ticked or not.</p><p>${doc('https://support.discord.com/hc/en-us/articles/206141927-How-is-the-permission-hierarchy-structured', 'Discord permission hierarchy')}</p>`)}</th>
            <th>Post ${help('MCP posting channels', html`<p><code>post_to_channel</code> only posts in the ticked channels and threads under them.</p><p>Nobody is pinged. With none ticked, Devin can only post in its own task threads.</p><p>Anyone with the token can post there, so only tick channels where that's OK.</p><p>The bot's own Discord permissions come first: where its role can't see the channel (or send messages, for Post), nothing gets through, ticked or not.</p><p>${doc('https://support.discord.com/hc/en-us/articles/206141927-How-is-the-permission-hierarchy-structured', 'Discord permission hierarchy')}</p>`, true)}</th>
          </tr></thead>
          <tbody>
            ${[...groups].map(
              ([category, list]) => html`<tr class="group"><td colspan="3">${category}</td></tr>
                ${list.map(
                  (channel) => html`<tr class="${channel.bot?.read === false || channel.bot?.post === false ? 'noaccess' : ''}">
                    <td>${channel.kind === 'text' ? html`<span class="muted">#</span> ` : ''}${channel.name}${channel.kind === 'text' ? '' : html` <span class="muted small">${KIND_LABEL[channel.kind]}</span>`}</td>
                    <td class="center"><input type="checkbox" name="read" value="${channel.id}" aria-label="Allow MCP reading in ${channel.name}" ${readSet.has(channel.id) ? 'checked' : ''} ${channel.viewer?.read === false ? 'disabled' : ''}>${channel.viewer?.read === false ? html`<br><span class="muted small">you can't read here</span>` : ''}${channel.bot?.read === false ? html`<br><span class="muted small">bot can't read here</span>` : ''}</td>
                    <td class="center">${channel.kind === 'forum'
                      ? html`<span class="muted small">n/a</span>`
                      : html`<input type="checkbox" name="post" value="${channel.id}" aria-label="Allow MCP posting in ${channel.name}" ${postSet.has(channel.id) ? 'checked' : ''} ${channel.viewer?.post === false ? 'disabled' : ''}>${channel.viewer?.post === false ? html`<br><span class="muted small">you can't post here</span>` : ''}${channel.bot?.post === false ? html`<br><span class="muted small">bot can't post here</span>` : ''}`}</td>
                  </tr>`
                )}`
            )}
          </tbody>
        </table>
        <p class="muted small">${readSummary}</p>
        ${hasBotPermissionLimits
          ? html`<p class="muted small">Channels marked "bot can't…" need the bot's role to get View Channel and Read Message History (Read) or Send Messages (Post) in Discord.</p>`
          : ''}
        <button class="button">Save channels</button>
      </form>
    </section>
    ${token
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
      ${entries.length
        ? html`<table class="grid">
            <thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
            <tbody>${entries.map(
              (entry) => html`<tr>
                <td class="nowrap">${new Date(entry.createdAt).toISOString().replace('T', ' ').slice(0, 19)}</td>
                <td>${entry.actorName} <span class="muted small">${entry.actorId}</span></td>
                <td><code>${entry.action}</code></td>
                <td>${entry.detail}</td>
              </tr>`
            )}</tbody>
          </table>`
        : html`<p class="muted">Nothing yet.</p>`}
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
:root{color-scheme:dark;--bg:#1e1f22;--card:#2b2d31;--line:#3f4147;--text:#dbdee1;--muted:#949ba4;--accent:#5865f2;--ok:#23a55a;--warn:#f0b232;--bad:#da373c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:#00a8fc}code{background:#1e1f22;padding:1px 5px;border-radius:4px;font-size:13px}
.top{display:flex;justify-content:space-between;align-items:center;padding:12px 24px;background:#111214}
.brand{color:#fff;font-weight:700;text-decoration:none;font-size:17px}
.me{display:flex;gap:10px;align-items:center}.me form{margin:0}.avatar{width:28px;height:28px;border-radius:50%}
main{max-width:1000px;margin:0 auto;padding:24px}
.card{background:var(--card);border-radius:8px;padding:20px 24px;margin-bottom:20px;max-width:680px}.card.wide{max-width:none}
.card.danger{border:1px solid #5c2a2c}.hero{text-align:center;margin:60px auto}
h1{font-size:22px;margin:0 0 12px}h2{font-size:18px;margin:0 0 8px}
.muted{color:var(--muted)}.small{font-size:13px}.nowrap{white-space:nowrap}
label{display:block;margin:14px 0 4px;font-weight:600}
label.check{display:flex;gap:8px;align-items:center}
label.check input{width:auto;margin:0}
input.narrow{max-width:120px;display:block}
input,textarea{width:100%;margin-top:6px;padding:9px 10px;background:#1e1f22;border:1px solid var(--line);border-radius:4px;color:var(--text);font:inherit;font-weight:400}
input[type=checkbox],input[type=radio]{width:18px;height:18px;margin:0;accent-color:var(--accent)}
input.num{width:90px;margin:0;padding:5px 8px}
.button{display:inline-block;margin-top:16px;padding:9px 16px;background:var(--accent);color:#fff;border:0;border-radius:4px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.button.secondary{background:#4e5058}.button.danger{background:var(--bad)}
.servers .button,.row .button{margin-top:0}
button.link{background:none;border:0;color:var(--muted);cursor:pointer;font:inherit;text-decoration:underline}
.row{display:flex;align-items:center;gap:12px}.between{justify-content:space-between}.grow{flex:1}
.servers{list-style:none;padding:0;margin:12px 0}.servers li{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.icon{width:40px;height:40px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:#4e5058;font-weight:700}
.pill{font-size:12px;padding:2px 8px;border-radius:10px}.pill.ok{background:#1c3d2a;color:#6ddf9a}.pill.warn{background:#4a3a14;color:var(--warn)}
.crumbs{margin:0 0 8px;color:var(--muted)}
.tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--line)}
.tabs a{padding:8px 14px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent}.tabs a.active{color:#fff;border-color:var(--accent)}
.notice{padding:10px 14px;border-radius:6px;max-width:680px}.notice.ok{background:#1c3d2a}.notice.error{background:#4a1f21}
.scroll{overflow-x:auto}
table.grid{width:100%;border-collapse:collapse;margin-top:8px}.grid th,.grid td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
.grid th{font-size:12px;text-transform:uppercase;color:var(--muted);font-weight:600}.grid .center{text-align:center}
.grid tr.group td{font-size:12px;text-transform:uppercase;color:var(--muted);padding-top:16px}
tr.noaccess td:first-child { opacity: .55 }
.help{display:inline-block;position:relative;margin-left:4px;vertical-align:middle;font-size:13px;font-weight:400;text-transform:none;letter-spacing:normal}
.help summary{list-style:none;cursor:pointer;width:17px;height:17px;border-radius:50%;background:#4e5058;color:#fff;font-size:11px;font-weight:700;line-height:17px;text-align:center;user-select:none}
.help summary::-webkit-details-marker{display:none}.help summary:hover,.help[open] summary{background:var(--accent)}
.help .tip{position:absolute;z-index:10;top:24px;left:-10px;width:320px;max-width:80vw;padding:10px 14px;background:#111214;border:1px solid var(--line);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.5);color:var(--text);line-height:1.45;white-space:normal;text-align:left}
.help.end .tip{left:auto;right:-10px}.help .tip p{margin:0 0 8px}.help .tip p:last-child{margin:0}
.grid td.role{white-space:nowrap}
.steps{padding-left:20px;margin:6px 0}.steps li{margin:4px 0}code.token{display:inline-block;margin-top:6px;word-break:break-all;user-select:all}h3{font-size:15px;margin:18px 0 6px}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px}
`;

/** Changes whenever the CSS does, so browsers don't keep a cached copy after an update. */
export const CSS_VERSION = createHash('sha256').update(CSS).digest('hex').slice(0, 10);
