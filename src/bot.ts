import { TaskStartError, type Bridge, type StartRequest } from './bridge.ts';
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

/** `threads`: a task thread can be opened here (text, announcement or forum, or a thread in one). */
export type ChannelRef = { id: string; parentId: string | null; threads: boolean };

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
    };

const CANT_CONTROL =
  "You can't do that. Only the member who started this task or someone allowed to manage tasks can stop it or put it to sleep.";

/** What happened, and the text to show the member privately. */
export type Outcome =
  | { ok: true; reply: string; started?: boolean }
  | { ok: false; reason: DenyReason; reply: string };

export function unconfiguredReply(publicUrl: string) {
  return `Devin isn't set up in this server yet. An admin can set it up at ${publicUrl}`;
}

function person(member: MemberSnapshot): Person {
  return { discordId: member.id, name: member.name };
}

function alreadyStarted(threadId: string | null) {
  return threadId ? `That message already has a task: <#${threadId}>` : 'A task for that message is already starting.';
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
    if (!parsed.mentioned) return { action: 'ignored' };
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

  list(guildId: string, member: MemberSnapshot): Outcome {
    const denied = this.check(guildId, member, ['start_tasks', 'reply', 'manage_tasks']);
    if (denied) return denied;
    const rows = this.bridge.recent(guildId, 10);
    if (!rows.length) return { ok: true, reply: 'No tasks yet.' };
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
    const denied = this.check(guildId, member, ['start_tasks']);
    if (denied) return denied;
    const allowed = this.guilds.allowedChannels(guildId);
    if (
      allowed.length &&
      !allowed.includes(channel.id) &&
      !(channel.parentId && allowed.includes(channel.parentId))
    ) {
      return deny('channel', "Devin isn't enabled in this channel.");
    }
    const settings = this.guilds.settings(guildId);
    if (!settings?.taskChannelId && !channel.threads) {
      return deny(
        'channel',
        "Devin can't open a task thread here. Use a text, announcement or forum channel, or set a task channel."
      );
    }
    const sourceMessageId = request.kind === 'prompt' ? null : request.message.id;
    if (sourceMessageId) {
      const existing = this.tasks.bySourceMessage(sourceMessageId);
      if (existing) return { ok: true, started: false, reply: alreadyStarted(existing.pending ? null : existing.threadId) };
    }
    const limits = startLimits(member, this.guilds.roleRules(guildId));
    if (
      limits.tasksPerDay !== null &&
      this.tasks.countStartedSince(guildId, member.id, this.now() - DAY_MS) >= limits.tasksPerDay
    ) {
      return deny('limit', `You've reached your limit of ${limits.tasksPerDay} tasks per day.`);
    }
    if (
      limits.concurrentTasks !== null &&
      this.tasks.countActive(guildId, member.id) >= limits.concurrentTasks
    ) {
      return deny(
        'limit',
        `You already have ${limits.concurrentTasks} running tasks. Wait for one to finish.`
      );
    }
    // Taken in the same synchronous step as the checks above, so concurrent
    // triggers count each other before any of them reaches Devin.
    const reservation = this.tasks.reserve({ guildId, openerId: member.id, sourceMessageId });
    if (!reservation) return { ok: true, started: false, reply: alreadyStarted(null) };
    const actor = { id: member.id, name: member.name };
    let result;
    try {
      const common = {
        guildId,
        opener: person(member),
        channelId: settings?.taskChannelId ?? channel.id,
        instructions: settings?.instructions.trim() || DEFAULT_INSTRUCTIONS,
        maxAcu: limits.maxAcu,
        reservation
      };
      let full: StartRequest;
      if (request.kind === 'mention') {
        // Thread on the mention itself unless tasks go to a separate channel or it's already in a thread.
        const threadOnMessage =
          !channel.parentId && (!settings?.taskChannelId || settings.taskChannelId === channel.id);
        const context = await request.loadContext(settings?.contextMessages ?? DEFAULT_CONTEXT_MESSAGES);
        full = {
          ...common,
          channelId: threadOnMessage ? channel.id : common.channelId,
          kind: 'mention',
          message: request.message,
          text: request.text,
          context,
          threadOnMessage
        };
      } else {
        full = { ...common, ...request };
      }
      result = await this.bridge.start(full);
    } catch (error) {
      this.tasks.release(reservation);
      if (error instanceof TaskStartError && error.url) {
        this.guilds.audit(guildId, actor, 'task.start_failed', `${error.url} ${error.message}`);
      }
      throw error;
    }
    this.guilds.audit(
      guildId,
      actor,
      'task.start',
      result.started ? `<#${result.threadId}> ${result.url}` : `<#${result.threadId}>`
    );
    return result.started
      ? { ok: true, started: true, reply: `Devin task started: <#${result.threadId}>` }
      : { ok: true, started: false, reply: alreadyStarted(result.threadId) };
  }

  /** Null when the server is set up and the member holds any of `permissions`. */
  private check(guildId: string, member: MemberSnapshot, permissions: Permission[]): Outcome | null {
    if (!this.isConfigured(guildId)) return deny('unconfigured', unconfiguredReply(this.publicUrl));
    const rules = this.guilds.roleRules(guildId);
    if (permissions.some((permission) => hasPermission(member, rules, permission))) return null;
    return deny('forbidden', "You don't have permission to do that here.");
  }
}
