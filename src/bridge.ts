import type { Attachment, DevinApi, Person } from './devin.ts';
import {
  chunkMessage,
  forwardedMessagePrompt,
  isFinalState,
  mentionPrompt,
  shortTitle,
  stateAnnouncement,
  taskPrompt,
  type ForwardedMessage,
  type MentionContext
} from './format.ts';
import type { TaskRow, TaskStore } from './store.ts';
import { controlId } from './triggers.ts';

export type ChatButton = { customId: string; label: string; style: 'danger' | 'secondary' };

/** The Discord operations the bridge needs; implemented with discord.js. */
export interface ChatPort {
  /** Posts `intro` in the channel and opens a thread on it. */
  createTaskThread(channelId: string, title: string, intro: string): Promise<string>;
  /** Opens a thread on an existing message, e.g. the one that @mentioned the bot. */
  createThreadOnMessage(channelId: string, messageId: string, title: string): Promise<string>;
  addThreadMember(threadId: string, userId: string): Promise<void>;
  /** Posts one message; mentions are only allowed for `pingUserId`. */
  send(channelId: string, content: string, pingUserId?: string, buttons?: ChatButton[]): Promise<void>;
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
  | {
      kind: 'mention';
      /** The requester's message; `text` is its content without the mention. */
      message: ForwardedMessage & { id: string };
      text: string;
      context: MentionContext;
      /** Open the thread on the message itself rather than posting a new one. */
      threadOnMessage: boolean;
    }
);

export function controlButtons(taskId: string): ChatButton[] {
  return [
    { customId: controlId('stop', taskId), label: 'Stop', style: 'danger' },
    { customId: controlId('sleep', taskId), label: 'Sleep', style: 'secondary' }
  ];
}

export type StartResult =
  | { started: true; threadId: string; url: string }
  | { started: false; threadId: string };

const SLEEP_LABEL = 'asleep (a reply wakes it)';

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
    if (request.kind !== 'prompt') {
      const existing = this.store.bySourceMessage(request.message.id);
      if (existing) return { started: false, threadId: existing.threadId };
    }
    const devin = this.devin(request.guildId);
    if (!devin) throw new Error('Devin is not set up in this server.');
    const forwarded = request.kind === 'prompt' ? null : request.message;
    let title: string;
    let attachments: Attachment[];
    let prompt: string;
    if (request.kind === 'message') {
      title = shortTitle(`${request.message.authorName}: ${request.message.content || 'attachment'}`);
      attachments = request.message.attachments;
      prompt = forwardedMessagePrompt(request.message, request.opener, request.instructions);
    } else if (request.kind === 'mention') {
      title = shortTitle(request.text || request.context.repliedTo?.content || 'Discord request');
      attachments = [...request.message.attachments, ...(request.context.repliedTo?.attachments ?? [])];
      prompt = mentionPrompt(
        { text: request.text, link: request.message.link, attachments: request.message.attachments },
        request.context,
        request.opener,
        request.instructions
      );
    } else {
      title = shortTitle(request.task);
      attachments = request.attachments;
      prompt = taskPrompt(request.task, request.opener, request.instructions);
    }

    const task = await devin.startTask({
      prompt,
      title,
      attachments,
      requestedBy: request.opener,
      guildId: request.guildId,
      maxAcu: request.maxAcu
    });
    const source = forwarded ? ` from ${forwarded.link}` : '';
    const intro = `**${title}**\nStarted by <@${request.opener.discordId}>${source}\n${task.url}`;
    let threadId: string;
    if (request.kind === 'mention' && request.threadOnMessage) {
      threadId = await this.chat.createThreadOnMessage(request.channelId, request.message.id, `Devin: ${title}`);
      await this.post(threadId, intro);
    } else {
      threadId = await this.chat.createTaskThread(request.channelId, `Devin: ${title}`, intro);
    }
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
      `Devin is on it. Reply in this thread to give it feedback, images included.${aside}`,
      undefined,
      controlButtons(task.id)
    );
    return { started: true, threadId, url: task.url };
  }

  task(threadId: string) {
    return this.store.byThread(threadId);
  }

  /** Ends the Devin session for good; the thread gets no more syncs or replies. */
  async stop(row: TaskRow, by: Person) {
    const devin = this.requireDevin(row);
    await devin.terminate(row.taskId);
    this.store.update(row.taskId, { stoppedBy: by.discordId, active: false, stateLabel: 'stopped' });
    await this.post(row.threadId, `Stopped by <@${by.discordId}>.`);
  }

  /** Puts the session to sleep; the next forwarded reply wakes it. */
  async sleep(row: TaskRow, by: Person) {
    const devin = this.requireDevin(row);
    await devin.sleep(row.taskId);
    this.store.update(row.taskId, { sleptBy: by.discordId, stateLabel: SLEEP_LABEL });
    await this.post(row.threadId, `Put to sleep by <@${by.discordId}>. A reply in this thread wakes Devin.`);
  }

  private requireDevin(row: TaskRow) {
    const devin = row.guildId ? this.devin(row.guildId) : null;
    if (!devin) throw new Error('Devin is not set up in this server.');
    return devin;
  }

  /** Forwards a thread message to the thread's task. False if none. */
  async forward(
    threadId: string,
    from: Person,
    text: string,
    attachments: Attachment[]
  ): Promise<boolean> {
    const row = this.store.byThread(threadId);
    if (!row?.guildId || row.stoppedBy) return false;
    const devin = this.requireDevin(row);
    // A message wakes a sleeping session (Devin API v3, Archive Session).
    await devin.sendMessage(row.taskId, {
      text: text.trim() || '(see the attached files)',
      attachments,
      from
    });
    if (row.sleptBy) {
      // Sleep archived the session; take it back out of the archive now it's awake.
      await devin.unarchive(row.taskId).catch((error) => {
        console.error(`Unarchiving task ${row.taskId} failed:`, error);
      });
      this.store.update(row.taskId, { sleptBy: null, active: true });
    } else if (!row.active) {
      this.store.update(row.taskId, { active: true });
    }
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
      // Stopped while this sync was in flight: don't revive it.
      if (this.store.byId(row.taskId)?.stoppedBy) return update;
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

  private async post(channelId: string, content: string, pingUserId?: string, buttons?: ChatButton[]) {
    const chunks = chunkMessage(pingUserId ? `<@${pingUserId}> ${content}` : content);
    for (let index = 0; index < chunks.length; index++) {
      const last = index === chunks.length - 1;
      await this.chat.send(
        channelId,
        chunks[index],
        index === 0 ? pingUserId : undefined,
        last ? buttons : undefined
      );
    }
  }
}
