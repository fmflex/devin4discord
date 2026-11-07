import { randomBytes } from 'node:crypto';
import type { Bridge, ChatButton, StartRequest } from './bridge.ts';
import type { Attachment, Person } from './devin.ts';
import { DEFAULT_INSTRUCTIONS, type ForwardedMessage, type MentionContext } from './format.ts';
import { DEFAULT_CONTEXT_MESSAGES, type GuildStore } from './guilds.ts';
import {
  hasPermission,
  startLimits,
  type MemberSnapshot,
  type Permission
} from './permissions.ts';
import type { TaskRow, TaskStore } from './store.ts';
import { parseControlId, parseMention, type ControlAction } from './triggers.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
export const LINK_TTL_MS = 30 * 60 * 1000;
export const LINK_CHECK_ID = 'devin:link-check';
const DEFAULT_DEVIN_APP = 'https://app.devin.ai';
const LIST_SIZE = 10;
const LIST_SCAN = 50;

export type ChannelRef = { id: string; parentId: string | null; isPrivate?: boolean };

export type DenyReason =
  | 'unconfigured'
  | 'forbidden'
  | 'channel'
  | 'limit'
  | 'not_task'
  | 'empty'
  | 'ended';

/** A guild message as the bot sees it; `loadContext` fetches history only once a start is allowed. */
export type IncomingMessage = {
  guildId: string;
  member: MemberSnapshot;
  channel: ChannelRef;
  message: ForwardedMessage & { id: string };
  botUserId: string;
  isReply: boolean;
  /** The first message of a thread (in a forum: the post itself), whose ID is the thread's. */
  isThreadStarter?: boolean;
  /** A forum post's title, sent along with an auto-started post. */
  threadTitle?: string;
  loadContext: (limit: number) => Promise<MentionContext>;
};

export type MessageOutcome =
  | { action: 'ignored' }
  | { action: 'forwarded' }
  | { action: 'started'; threadId: string; reply: string }
  | { action: 'controlled'; reply: string }
  | { action: 'denied'; reason: DenyReason; reply: string };

type StartInput =
  | { kind: 'message'; message: ForwardedMessage & { id: string } }
  | { kind: 'prompt'; task: string; attachments: Attachment[] }
  | {
      kind: 'mention';
      message: ForwardedMessage & { id: string };
      text: string;
      loadContext: (limit: number) => Promise<MentionContext>;
      /** Started by a watched channel, not a mention: on the message itself, or in the forum post it opened. */
      autoStart?: 'message' | 'thread';
      /** The watched channel lets members without Start tasks start tasks, within its limits. */
      anyone?: boolean;
    };

const CANT_CONTROL =
  "You can't do that. Only the member who started this task or someone allowed to manage tasks can stop it or put it to sleep.";

/** What happened, and the text to show the member privately. */
export type Outcome =
  | { ok: true; reply: string; started?: boolean; buttons?: ChatButton[] }
  | { ok: false; reason: DenyReason; reply: string };

export function unconfiguredReply(publicUrl: string) {
  return `Devin isn't set up in this server yet. An admin can set it up at ${publicUrl}`;
}

function person(member: MemberSnapshot): Person {
  return { discordId: member.id, name: member.name };
}

function deny(reason: DenyReason, reply: string): Outcome {
  return { ok: false, reason, reply };
}

/**
 * Applies each server's settings (configured or not, role permissions,
 * allowed channels and limits) before anything reaches the bridge. The
 * discord.js layer only translates events and delivers `reply`.
 */
export class Bot {
  private readonly bridge: Bridge;
  private readonly guilds: GuildStore;
  private readonly tasks: TaskStore;
  private readonly publicUrl: string;
  private readonly now: () => number;
  /** `/devin link` codes waiting for their Devin session, per `guild:member`. Kept in memory only. */
  private readonly linkCodes = new Map<string, { code: string; issuedAt: number }>();
  /** Starts that passed the limit check but whose task row isn't written yet, per `guild:member`. */
  private readonly pendingStarts = new Map<string, number>();

  constructor(options: {
    bridge: Bridge;
    guilds: GuildStore;
    tasks: TaskStore;
    publicUrl: string;
    now?: () => number;
  }) {
    this.bridge = options.bridge;
    this.guilds = options.guilds;
    this.tasks = options.tasks;
    this.publicUrl = options.publicUrl;
    this.now = options.now ?? Date.now;
  }

  isConfigured(guildId: string) {
    return this.guilds.isConfigured(guildId);
  }

  isTaskThread(threadId: string) {
    return this.tasks.byThread(threadId) !== null;
  }

  /**
   * How a message here would start a task on its own: top-level messages in an auto-start channel,
   * or a new post in an auto-start forum. Private threads never auto-start.
   */
  autoStarts(
    guildId: string,
    channel: ChannelRef,
    isThreadStarter: boolean
  ): { mode: 'message' | 'thread'; anyone: boolean } | null {
    if (channel.isPrivate) return null;
    if (channel.parentId && !isThreadStarter) return null;
    const watched = this.guilds.watchChannel(guildId, channel.parentId ?? channel.id);
    if (!watched?.autoStart) return null;
    return { mode: channel.parentId ? 'thread' : 'message', anyone: watched.anyone };
  }

  startFromMessage(
    guildId: string,
    member: MemberSnapshot,
    channel: ChannelRef,
    message: ForwardedMessage & { id: string }
  ) {
    return this.start(guildId, member, channel, { kind: 'message', message });
  }

  startFromPrompt(
    guildId: string,
    member: MemberSnapshot,
    channel: ChannelRef,
    task: string,
    attachments: Attachment[]
  ) {
    return this.start(guildId, member, channel, { kind: 'prompt', task, attachments });
  }

  /**
   * Every non-bot guild message. In a task thread it's a reply (or `@Devin stop|sleep`);
   * elsewhere an @mention of the bot starts a task.
   */
  async handleMessage(input: IncomingMessage): Promise<MessageOutcome> {
    const { guildId, member, channel, message } = input;
    const parsed = parseMention(message.content, input.botUserId);
    const row = this.tasks.byThread(channel.id);
    if (row) {
      if (row.guildId !== guildId) return { action: 'ignored' };
      if (parsed.command) {
        const outcome = await this.control(parsed.command, guildId, member, row);
        return outcome.ok
          ? { action: 'controlled', reply: outcome.reply }
          : { action: 'denied', reason: outcome.reason, reply: outcome.reply };
      }
      if (!parsed.mentioned && this.guilds.settings(guildId)?.mentionOnlyReplies) {
        return { action: 'ignored' };
      }
      const text = parsed.mentioned ? parsed.text : message.content;
      if (!text.trim() && !message.attachments.length) return { action: 'ignored' };
      const outcome = await this.reply(guildId, member, channel.id, text, message.attachments);
      if (outcome.ok) return { action: 'forwarded' };
      if (outcome.reason === 'not_task') return { action: 'ignored' };
      return { action: 'denied', reason: outcome.reason, reply: outcome.reply };
    }
    if (!parsed.mentioned) return this.autoStart(input);
    if (parsed.command) {
      return { action: 'denied', reason: 'not_task', reply: `Use \`${parsed.command}\` inside a task thread.` };
    }
    if (!parsed.text && !message.attachments.length && !input.isReply) {
      return {
        action: 'denied',
        reason: 'empty',
        reply: 'Tell Devin what to do after the mention, or mention it in a reply to a message.'
      };
    }
    const outcome = await this.start(guildId, member, channel, {
      kind: 'mention',
      message,
      text: parsed.text,
      loadContext: input.loadContext
    });
    if (!outcome.ok) return { action: 'denied', reason: outcome.reason, reply: outcome.reply };
    const threadId = this.tasks.bySourceMessage(message.id)?.threadId ?? '';
    return { action: 'started', threadId, reply: outcome.reply };
  }

  /**
   * A message in a watched channel. Members allowed to start tasks start one within their limits, and in an
   * "anyone" channel everyone else does within the channel limits; others are ignored quietly.
   */
  private async autoStart(input: IncomingMessage): Promise<MessageOutcome> {
    const { guildId, member, channel, message } = input;
    const watched = this.autoStarts(guildId, channel, input.isThreadStarter === true);
    if (!watched) return { action: 'ignored' };
    const { mode, anyone } = watched;
    const title = mode === 'thread' ? input.threadTitle?.trim() ?? '' : '';
    const text = [title, message.content.trim()].filter(Boolean).join('\n\n');
    if (!text && !message.attachments.length) return { action: 'ignored' };
    const outcome = await this.start(guildId, member, channel, {
      kind: 'mention',
      message,
      text,
      loadContext: input.loadContext,
      autoStart: mode,
      anyone
    });
    if (!outcome.ok) {
      return outcome.reason === 'limit'
        ? { action: 'denied', reason: outcome.reason, reply: outcome.reply }
        : { action: 'ignored' };
    }
    const threadId = this.tasks.bySourceMessage(message.id)?.threadId ?? '';
    return { action: 'started', threadId, reply: outcome.reply };
  }

  /** Where members open Devin: the web app their server's task links point to. */
  private devinApp(guildId: string) {
    const url = this.bridge.recent(guildId, 1)[0]?.url;
    try {
      return url ? new URL(url).origin : DEFAULT_DEVIN_APP;
    } catch {
      return DEFAULT_DEVIN_APP;
    }
  }

  /**
   * `/devin link`: gives the member a one-time code to put in a Devin session they start themselves.
   * Proving they own the account is what keeps members from running tasks as someone else.
   */
  link(guildId: string, member: MemberSnapshot): Outcome {
    const denied = this.check(guildId, member, ['start_tasks']);
    if (denied) return denied;
    const linked = this.guilds.devin(guildId)?.userMap[member.id];
    if (linked) {
      return {
        ok: true,
        reply: `Your Discord account is linked to Devin user \`${linked}\`, so tasks you start run as you in Devin.\nTo link a different account, run \`/devin unlink\` first.`
      };
    }
    const code = `D4D-${randomBytes(5).toString('hex').toUpperCase()}`;
    this.linkCodes.set(`${guildId}:${member.id}`, { code, issuedAt: this.now() });
    const app = this.devinApp(guildId);
    return {
      ok: true,
      buttons: [{ customId: LINK_CHECK_ID, label: "I've started it, check now", style: 'secondary' }],
      reply: [
        '**Link your Devin account** (only you can see this)',
        `**1.** Open Devin at ${app}, signed in as yourself, and start a new session with this prompt:`,
        '```',
        `Link my Discord account to devin4discord with code ${code}. Just reply "done", nothing else is needed.`,
        '```',
        '**2.** Come back here and click the button below. The code works for 30 minutes.',
        '',
        "Once linked, tasks you start from Discord are created as your Devin user and show up under your account. You can stop that Devin session after it replies. Only start it if you ran `/devin link` yourself; `/devin unlink` undoes the link."
      ].join('\n')
    };
  }

  /** The "check now" button under `/devin link`. */
  async linkCheck(guildId: string, member: MemberSnapshot): Promise<Outcome> {
    const denied = this.check(guildId, member, ['start_tasks']);
    if (denied) return denied;
    const key = `${guildId}:${member.id}`;
    const pending = this.linkCodes.get(key);
    if (!pending || this.now() - pending.issuedAt > LINK_TTL_MS) {
      this.linkCodes.delete(key);
      return deny('ended', 'That code has expired. Run `/devin link` to get a new one.');
    }
    const found = await this.bridge.findLinkSession(guildId, pending.code, pending.issuedAt);
    // `/devin unlink` (or a new `/devin link`) while Devin was being asked cancels this check.
    if (this.linkCodes.get(key) !== pending) {
      return deny('ended', 'That link was cancelled. Run `/devin link` to start again.');
    }
    if (!found) {
      return {
        ok: false,
        reason: 'empty',
        reply: `I can't find a Devin session with code \`${pending.code}\` yet.\nMake sure you started it **in the Devin web app** (${this.devinApp(guildId)}), signed in as yourself, with the code in the first message. Then click the button again; it can take a few seconds to show up.`
      };
    }
    const userMap = this.guilds.devin(guildId)?.userMap ?? {};
    const other = Object.entries(userMap).find(([discordId, devinId]) => devinId === found.userId && discordId !== member.id);
    if (other) {
      this.linkCodes.delete(key);
      return deny('forbidden', `Devin user \`${found.userId}\` is already linked to another Discord member. Ask an admin to change it on the Devin page.`);
    }
    this.guilds.setUserLink(guildId, member.id, found.userId);
    this.linkCodes.delete(key);
    this.guilds.audit(guildId, { id: member.id, name: member.name }, 'devin.link', `<@${member.id}> → ${found.userId} (proved with ${found.url})`);
    return {
      ok: true,
      reply: `Linked! Your Discord account now runs tasks as Devin user \`${found.userId}\`, so they show up under your account.\nYou can stop the session you used: ${found.url}\nRun \`/devin unlink\` any time to undo.`
    };
  }

  /** `/devin unlink`: tasks go back to being created by the server's service user. */
  unlink(guildId: string, member: MemberSnapshot): Outcome {
    if (!this.isConfigured(guildId)) return deny('unconfigured', unconfiguredReply(this.publicUrl));
    this.linkCodes.delete(`${guildId}:${member.id}`);
    const linked = this.guilds.devin(guildId)?.userMap[member.id];
    if (!linked) return { ok: true, reply: "Your Discord account isn't linked to a Devin user." };
    this.guilds.setUserLink(guildId, member.id, null);
    this.guilds.audit(guildId, { id: member.id, name: member.name }, 'devin.unlink', `<@${member.id}> → ${linked}`);
    return { ok: true, reply: `Unlinked from Devin user \`${linked}\`. New tasks are created by the server's Devin service user again.` };
  }

  /** `/devin stop|sleep` inside a task thread. */
  async controlThread(
    action: ControlAction,
    guildId: string,
    member: MemberSnapshot,
    threadId: string
  ): Promise<Outcome> {
    const row = this.tasks.byThread(threadId);
    if (!row || row.guildId !== guildId) return deny('not_task', 'Run this inside a task thread.');
    return this.control(action, guildId, member, row);
  }

  /**
   * A Stop / Sleep button. The custom ID is user-controlled, so the task it names
   * must belong to this server and to the thread the button was pressed in.
   */
  async controlButton(
    customId: string,
    guildId: string,
    member: MemberSnapshot,
    channelId: string
  ): Promise<Outcome> {
    const parsed = parseControlId(customId);
    const row = parsed ? this.tasks.byId(parsed.taskId) : null;
    if (!parsed || !row || row.guildId !== guildId || row.threadId !== channelId) {
      return deny('not_task', "That button doesn't belong to a task here.");
    }
    return this.control(parsed.action, guildId, member, row);
  }

  /** The opener and members with `manage_tasks` (Administrators by default) may stop or sleep a task. */
  canControl(guildId: string, member: MemberSnapshot, row: TaskRow) {
    return row.openerId === member.id || hasPermission(member, this.guilds.roleRules(guildId), 'manage_tasks');
  }

  private async control(
    action: ControlAction,
    guildId: string,
    member: MemberSnapshot,
    row: TaskRow
  ): Promise<Outcome> {
    if (!this.isConfigured(guildId)) return deny('unconfigured', unconfiguredReply(this.publicUrl));
    if (!this.canControl(guildId, member, row)) return deny('forbidden', CANT_CONTROL);
    if (row.stoppedBy) return deny('ended', 'This task has already been stopped.');
    if (action === 'sleep' && row.sleptBy) return deny('ended', 'Devin is already asleep. A reply wakes it.');
    if (action === 'stop') await this.bridge.stop(row, person(member));
    else await this.bridge.sleep(row, person(member));
    this.guilds.audit(guildId, { id: member.id, name: member.name }, `task.${action}`, `<#${row.threadId}> ${row.url}`);
    return { ok: true, reply: action === 'stop' ? 'Stopped.' : 'Put to sleep.' };
  }

  /** A message in a task thread; forwarded when the member may reply. */
  async reply(
    guildId: string,
    member: MemberSnapshot,
    threadId: string,
    text: string,
    attachments: Attachment[]
  ): Promise<Outcome> {
    const row = this.tasks.byThread(threadId);
    if (!row || row.guildId !== guildId) return deny('not_task', '');
    if (!this.isConfigured(guildId)) return deny('unconfigured', unconfiguredReply(this.publicUrl));
    if (row.stoppedBy) return deny('ended', 'This task was stopped. Start a new one to continue.');
    const rules = this.guilds.roleRules(guildId);
    const isOpener = row.openerId === member.id && hasPermission(member, rules, 'start_tasks');
    if (
      !isOpener &&
      !hasPermission(member, rules, 'reply') &&
      !hasPermission(member, rules, 'manage_tasks')
    ) {
      return deny('forbidden', "You don't have permission to reply to Devin here.");
    }
    await this.bridge.forward(threadId, person(member), text, attachments);
    return { ok: true, reply: 'Forwarded to Devin.' };
  }

  async status(guildId: string, member: MemberSnapshot, threadId: string): Promise<Outcome> {
    const denied = this.check(guildId, member, ['start_tasks', 'reply', 'manage_tasks']);
    if (denied) return denied;
    const row = this.tasks.byThread(threadId);
    if (!row || row.guildId !== guildId) return deny('not_task', 'Run this inside a task thread.');
    const update = await this.bridge.sync(row);
    const prs = (update?.pullRequests ?? row.pullRequests).join('\n') || 'none yet';
    return {
      ok: true,
      reply: `**${row.title}**\nStatus: ${update?.stateLabel ?? row.stateLabel ?? 'unknown'}\nTask: ${row.url}\nPull requests:\n${prs}`
    };
  }

  /** Recent tasks, limited to those whose thread `canView` says the member can see in Discord. */
  async list(
    guildId: string,
    member: MemberSnapshot,
    canView: (threadId: string) => Promise<boolean>
  ): Promise<Outcome> {
    const denied = this.check(guildId, member, ['start_tasks', 'reply', 'manage_tasks']);
    if (denied) return denied;
    const rows: TaskRow[] = [];
    for (const row of this.bridge.recent(guildId, LIST_SCAN)) {
      if (await canView(row.threadId).catch(() => false)) rows.push(row);
      if (rows.length === LIST_SIZE) break;
    }
    if (!rows.length) return { ok: true, reply: 'No tasks you can see yet.' };
    const reply = rows
      .map((row) => {
        const prs = row.pullRequests.length ? ` · ${row.pullRequests.join(' ')}` : '';
        return `<#${row.threadId}> · ${row.stateLabel ?? 'starting'}${prs}`;
      })
      .join('\n')
      .slice(0, 2000);
    return { ok: true, reply };
  }

  private async start(
    guildId: string,
    member: MemberSnapshot,
    channel: ChannelRef,
    request: StartInput
  ): Promise<Outcome> {
    const rules = this.guilds.roleRules(guildId);
    const canStart = hasPermission(member, rules, 'start_tasks');
    const anyone = request.kind === 'mention' && request.autoStart !== undefined && request.anyone === true;
    if (!anyone || canStart) {
      const denied = this.check(guildId, member, ['start_tasks']);
      if (denied) return denied;
    } else if (!this.isConfigured(guildId)) {
      return deny('unconfigured', unconfiguredReply(this.publicUrl));
    }
    const allowed = this.guilds.allowedChannels(guildId);
    // An Administrator picked the watched channel, so it counts as allowed.
    const watched = request.kind === 'mention' && request.autoStart;
    if (
      !watched &&
      allowed.length &&
      !allowed.includes(channel.id) &&
      !(channel.parentId && allowed.includes(channel.parentId))
    ) {
      return deny('channel', "Devin isn't enabled in this channel.");
    }
    if (request.kind !== 'prompt') {
      const existing = await this.bridge.taskForMessage(request.message.id);
      if (existing) {
        return { ok: true, started: false, reply: `That message already has a task: <#${existing.threadId}>` };
      }
    }
    const limits = canStart ? startLimits(member, rules) : this.guilds.watchLimits(guildId);
    const pendingKey = `${guildId}:${member.id}`;
    const pending = this.pendingStarts.get(pendingKey) ?? 0;
    if (
      limits.tasksPerDay !== null &&
      this.tasks.countStartedSince(guildId, member.id, this.now() - DAY_MS) + pending >= limits.tasksPerDay
    ) {
      return deny('limit', `You've reached your limit of ${limits.tasksPerDay} tasks per day.`);
    }
    if (
      limits.concurrentTasks !== null &&
      this.tasks.countActive(guildId, member.id) + pending >= limits.concurrentTasks
    ) {
      return deny(
        'limit',
        `You already have ${limits.concurrentTasks} running tasks. Wait for one to finish.`
      );
    }
    // Reserve the slot before any await so concurrent starts can't all pass the same count.
    this.pendingStarts.set(pendingKey, pending + 1);
    try {
      return await this.startReserved(guildId, member, channel, request, limits);
    } finally {
      const left = (this.pendingStarts.get(pendingKey) ?? 1) - 1;
      if (left > 0) this.pendingStarts.set(pendingKey, left);
      else this.pendingStarts.delete(pendingKey);
    }
  }

  private async startReserved(
    guildId: string,
    member: MemberSnapshot,
    channel: ChannelRef,
    request: StartInput,
    limits: ReturnType<typeof startLimits>
  ): Promise<Outcome> {
    const settings = this.guilds.settings(guildId);
    // A private thread's text stays private: its task gets a private thread, never the task channel.
    const privateThread = channel.isPrivate === true;
    const common = {
      guildId,
      opener: person(member),
      channelId: privateThread ? channel.id : settings?.taskChannelId ?? channel.id,
      privateThread,
      instructions: settings?.instructions.trim() || DEFAULT_INSTRUCTIONS,
      maxAcu: limits.maxAcu,
      mcpTools: this.guilds.mcpToken(guildId) !== null
    };
    let full: StartRequest;
    if (request.kind === 'mention') {
      // Thread on the mention itself unless tasks go to a separate channel or it's already in a thread.
      // Auto-started tasks stay where they were posted: on the message, or in the forum post.
      const threadOnMessage =
        request.autoStart === 'message' ||
        (!request.autoStart && !channel.parentId && (!settings?.taskChannelId || settings.taskChannelId === channel.id));
      const context = await request.loadContext(settings?.contextMessages ?? DEFAULT_CONTEXT_MESSAGES);
      full = {
        ...common,
        channelId: threadOnMessage ? channel.id : common.channelId,
        kind: 'mention',
        message: request.message,
        text: request.text,
        context,
        threadOnMessage,
        ...(request.autoStart === 'thread' ? { channelId: channel.id, inThread: true } : {})
      };
    } else {
      full = { ...common, ...request };
    }
    const result = await this.bridge.start(full);
    this.guilds.audit(
      guildId,
      { id: member.id, name: member.name },
      'task.start',
      result.started ? `<#${result.threadId}> ${result.url}` : `<#${result.threadId}>`
    );
    return result.started
      ? { ok: true, started: true, reply: `Devin task started: <#${result.threadId}>` }
      : { ok: true, started: false, reply: `That message already has a task: <#${result.threadId}>` };
  }

  /** Null when the server is set up and the member holds any of `permissions`. */
  private check(guildId: string, member: MemberSnapshot, permissions: Permission[]): Outcome | null {
    if (!this.isConfigured(guildId)) return deny('unconfigured', unconfiguredReply(this.publicUrl));
    const rules = this.guilds.roleRules(guildId);
    if (permissions.some((permission) => hasPermission(member, rules, permission))) return null;
    return deny('forbidden', "You don't have permission to do that here.");
  }
}
