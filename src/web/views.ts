import { html, raw } from 'hono/html';
import type { ChannelInfo, RoleInfo } from '../directory.ts';
import { MAX_CONTEXT_MESSAGES, type AuditEntry } from '../guilds.ts';

export type MentionSettings = { contextMessages: number; mentionOnlyReplies: boolean };
import { PERMISSIONS, PERMISSION_LABELS, type RoleRule } from '../permissions.ts';
import type { WebSession } from './sessions.ts';

type Html = ReturnType<typeof html>;

export type GuildTab = 'devin' | 'permissions' | 'channels' | 'audit';

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

function csrfField(session: WebSession) {
  return html`<input type="hidden" name="_csrf" value="${session.csrfToken}">`;
}

export function layout(page: PageOptions) {
  const { session, guild } = page;
  const tabs: [GuildTab, string][] = [
    ['devin', 'Devin'],
    ['permissions', 'Permissions'],
    ['channels', 'Channels'],
    ['audit', 'Audit log']
  ];
  const avatar = session ? avatarUrl(session) : null;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title} · devin4discord</title>
<link rel="stylesheet" href="/assets/app.css">
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
  notice: PageOptions['notice']
) {
  return layout({
    title: `${guild.name} · Devin`,
    session,
    guild: { ...guild, tab: 'devin' },
    notice,
    body: html`<form class="card" method="post" action="/g/${guild.id}/devin">
      ${csrfField(session)}
      <h2>Devin connection</h2>
      <p class="muted">Use a service user key (Devin → Settings → Service users) with permission to create, view and message sessions. Tasks are created by this service user.</p>
      <label>API key
        <input type="password" name="api_key" autocomplete="off" spellcheck="false"
          placeholder="${form.keyHint ? `Set, ends in …${form.keyHint}. Leave empty to keep it.` : 'cog_…'}">
      </label>
      <p class="muted small">${form.keyHint ? html`Key is <strong>set, ends in …${form.keyHint}</strong>. It is stored encrypted and never shown again.` : 'No key saved yet. It is checked with a read-only API call before saving.'}</p>
      <label>Organization ID
        <input name="org_id" value="${form.orgId}" placeholder="org-…" required spellcheck="false">
      </label>
      <label>Default repos <span class="muted">(one per line, owner/repo)</span>
        <textarea name="repos" rows="3" spellcheck="false">${form.repos}</textarea>
      </label>
      <label>Run as Devin users <span class="muted">(optional, one per line: Discord user ID, space, Devin user ID)</span>
        <textarea name="user_map" rows="3" spellcheck="false">${form.userMap}</textarea>
      </label>
      <label>Extra instructions <span class="muted">(added to every task; a default is used when empty)</span>
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
  return layout({
    title: `${guild.name} · Permissions`,
    session,
    guild: { ...guild, tab: 'permissions' },
    notice,
    body: html`<form class="card wide" method="post" action="/g/${guild.id}/permissions">
      ${csrfField(session)}
      <h2>Role permissions</h2>
      <p class="muted">Members with Administrator can do everything. Manage Server can change settings. Limits apply to roles that can start tasks; empty means no limit, and a member with several roles gets the most generous one.</p>
      <div class="scroll"><table class="grid">
        <thead><tr><th>Role</th>${PERMISSIONS.map((p) => html`<th>${PERMISSION_LABELS[p]}</th>`)}
          <th>ACU cap / task</th><th>Tasks / day</th><th>Concurrent</th></tr></thead>
        <tbody>${roles.map((role) => {
          const rule = byRole.get(role.id);
          return html`<tr>
            <td class="role"><span class="dot" style="${raw(`background:${roleColor(role)}`)}"></span>${role.name}</td>
            ${PERMISSIONS.map(
              (p) => html`<td class="center"><input type="checkbox" name="p_${role.id}" value="${p}" aria-label="${role.name}: ${PERMISSION_LABELS[p]}" ${rule?.permissions.includes(p) ? 'checked' : ''}></td>`
            )}
            <td><input class="num" type="number" min="1" step="1" name="acu_${role.id}" value="${limit(rule?.limits.maxAcu)}"></td>
            <td><input class="num" type="number" min="0" step="1" name="day_${role.id}" value="${limit(rule?.limits.tasksPerDay)}"></td>
            <td><input class="num" type="number" min="0" step="1" name="conc_${role.id}" value="${limit(rule?.limits.concurrentTasks)}"></td>
          </tr>`;
        })}</tbody>
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
        <thead><tr><th>Channel</th><th>Allowed</th><th>Task channel</th></tr></thead>
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
      <label>Channel messages sent as context with an @Devin mention
        <input class="narrow" type="number" name="context_messages" min="0" max="${MAX_CONTEXT_MESSAGES}" value="${mention.contextMessages}">
      </label>
      <p class="muted small">Devin gets them, and the message being replied to, marked as untrusted context it must not take instructions from.</p>
      <label class="check"><input type="checkbox" name="mention_only" ${mention.mentionOnlyReplies ? 'checked' : ''}> Only forward messages that @mention Devin</label>
      <p class="muted small">For busy task threads. When off, every message from members allowed to reply is forwarded.</p>
      <button class="button">Save channels</button>
    </form>`
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
.grid td.role{white-space:nowrap}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px}
`;
