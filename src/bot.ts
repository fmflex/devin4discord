import type { Bridge, StartRequest } from './bridge.ts';
import type { Attachment, Person } from './devin.ts';
import { DEFAULT_INSTRUCTIONS, type ForwardedMessage } from './format.ts';
import type { GuildStore } from './guilds.ts';
import {
  hasPermission,
  startLimits,
  type MemberSnapshot,
  type Permission
} from './permissions.ts';
import type { TaskStore } from './store.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export type ChannelRef = { id: string; parentId: string | null };

export type DenyReason = 'unconfigured' | 'forbidden' | 'channel' | 'limit' | 'not_task';

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
    request:
      | { kind: 'message'; message: ForwardedMessage & { id: string } }
      | { kind: 'prompt'; task: string; attachments: Attachment[] }
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
    if (request.kind === 'message') {
      const existing = this.tasks.bySourceMessage(request.message.id);
      if (existing) {
        return { ok: true, started: false, reply: `That message already has a task: <#${existing.threadId}>` };
      }
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
    const settings = this.guilds.settings(guildId);
    const full: StartRequest = {
      ...request,
      guildId,
      opener: person(member),
      channelId: settings?.taskChannelId ?? channel.id,
      instructions: settings?.instructions.trim() || DEFAULT_INSTRUCTIONS,
      maxAcu: limits.maxAcu
    };
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
