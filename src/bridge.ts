import type { Attachment, DevinApi, Person } from './devin.ts';
import {
  chunkMessage,
  forwardedMessagePrompt,
  isFinalState,
  shortTitle,
  stateAnnouncement,
  taskPrompt,
  type ForwardedMessage
} from './format.ts';
import type { TaskRow, TaskStore } from './store.ts';

/** The Discord operations the bridge needs; implemented with discord.js. */
export interface ChatPort {
  /** Posts `intro` in the channel and opens a thread on it. */
  createTaskThread(channelId: string, title: string, intro: string): Promise<string>;
  addThreadMember(threadId: string, userId: string): Promise<void>;
  /** Posts one message; mentions are only allowed for `pingUserId`. */
  send(channelId: string, content: string, pingUserId?: string): Promise<void>;
}

export type StartRequest = {
  guildId: string;
  opener: Person;
  /** Channel the thread is opened in. */
  channelId: string;
  instructions: string;
  maxAcu: number | null;
} & (
  | { kind: 'message'; message: ForwardedMessage & { id: string } }
  | { kind: 'prompt'; task: string; attachments: Attachment[] }
);

export type StartResult =
  | { started: true; threadId: string; url: string }
  | { started: false; threadId: string };

/** Returns the server's Devin client, or null when the server isn't set up. */
export type DevinResolver = (guildId: string) => DevinApi | null;

export class Bridge {
  private readonly devin: DevinResolver;
  private readonly store: TaskStore;
  private readonly chat: ChatPort;
  private readonly ignorePrefix: string;
  private readonly syncing = new Set<string>();

  constructor(options: {
    devin: DevinResolver;
    store: TaskStore;
    chat: ChatPort;
    ignorePrefix: string;
  }) {
    this.devin = options.devin;
    this.store = options.store;
    this.chat = options.chat;
    this.ignorePrefix = options.ignorePrefix;
  }

  async start(request: StartRequest): Promise<StartResult> {
    if (request.kind === 'message') {
      const existing = this.store.bySourceMessage(request.message.id);
      if (existing) return { started: false, threadId: existing.threadId };
    }
    const devin = this.devin(request.guildId);
    if (!devin) throw new Error('Devin is not set up in this server.');
    const forwarded = request.kind === 'message' ? request.message : null;
    const title =
      request.kind === 'message'
        ? shortTitle(`${request.message.authorName}: ${request.message.content || 'attachment'}`)
        : shortTitle(request.task);
    const attachments =
      request.kind === 'message' ? request.message.attachments : request.attachments;
    const prompt =
      request.kind === 'message'
        ? forwardedMessagePrompt(request.message, request.opener, request.instructions)
        : taskPrompt(request.task, request.opener, request.instructions);

    const task = await devin.startTask({
      prompt,
      title,
      attachments,
      requestedBy: request.opener,
      guildId: request.guildId,
      maxAcu: request.maxAcu
    });
    const source = forwarded ? ` from ${forwarded.link}` : '';
    const threadId = await this.chat.createTaskThread(
      request.channelId,
      `Devin: ${title}`,
      `**${title}**\nStarted by <@${request.opener.discordId}>${source}\n${task.url}`
    );
    this.store.insert({
      taskId: task.id,
      guildId: request.guildId,
      threadId,
      sourceMessageId: forwarded?.id ?? null,
      openerId: request.opener.discordId,
      title,
      url: task.url
    });
    await this.chat.addThreadMember(threadId, request.opener.discordId).catch((error) => {
      console.error(`Adding ${request.opener.discordId} to thread ${threadId} failed:`, error);
    });
    const aside = this.ignorePrefix
      ? ` Messages starting with \`${this.ignorePrefix}\` are not forwarded.`
      : '';
    await this.post(
      threadId,
      `Devin is on it. Reply in this thread to give it feedback, images included.${aside}`
    );
    return { started: true, threadId, url: task.url };
  }

  task(threadId: string) {
    return this.store.byThread(threadId);
  }

  /** Forwards a thread message to the thread's task. False if none. */
  async forward(
    threadId: string,
    from: Person,
    text: string,
    attachments: Attachment[]
  ): Promise<boolean> {
    const row = this.store.byThread(threadId);
    if (!row?.guildId) return false;
    const devin = this.devin(row.guildId);
    if (!devin) throw new Error('Devin is not set up in this server.');
    await devin.sendMessage(row.taskId, {
      text: text.trim() || '(see the attached files)',
      attachments,
      from
    });
    if (!row.active) this.store.update(row.taskId, { active: true });
    return true;
  }

  recent(guildId: string, limit = 10) {
    return this.store.recent(guildId, limit);
  }

  async syncAll() {
    for (const row of this.store.active()) {
      try {
        await this.sync(row);
      } catch (error) {
        console.error(`Syncing task ${row.taskId} failed:`, error);
      }
    }
  }

  /** Relays new Devin messages, PRs and status changes into the thread. */
  async sync(row: TaskRow) {
    if (!row.guildId || this.syncing.has(row.taskId)) return;
    const devin = this.devin(row.guildId);
    if (!devin) return;
    this.syncing.add(row.taskId);
    try {
      const update = await devin.getUpdate(row.taskId, row.cursor);
      for (const message of update.messages) {
        await this.post(row.threadId, `**Devin:** ${message.text}`);
        this.store.update(row.taskId, { cursor: message.id });
      }
      const known = new Set(row.pullRequests);
      const pullRequests = [...row.pullRequests];
      for (const url of update.pullRequests) {
        if (known.has(url)) continue;
        await this.post(row.threadId, `**Pull request:** ${url}`, row.openerId);
        known.add(url);
        pullRequests.push(url);
        this.store.update(row.taskId, { pullRequests });
      }
      const announcement = stateAnnouncement(
        row.stateLabel,
        update.state,
        update.stateLabel,
        'Devin'
      );
      if (announcement) await this.post(row.threadId, announcement, row.openerId);
      this.store.update(row.taskId, {
        cursor: update.cursor,
        stateLabel: update.stateLabel,
        active: !isFinalState(update.state)
      });
      return update;
    } finally {
      this.syncing.delete(row.taskId);
    }
  }

  private async post(channelId: string, content: string, pingUserId?: string) {
    const chunks = chunkMessage(pingUserId ? `<@${pingUserId}> ${content}` : content);
    for (let index = 0; index < chunks.length; index++) {
      await this.chat.send(channelId, chunks[index], index === 0 ? pingUserId : undefined);
    }
  }
}
