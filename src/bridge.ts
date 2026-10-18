import type { AgentAdapter, Attachment, Person } from './agents/types.ts';
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
  opener: Person;
  /** Channel the thread is opened in. */
  channelId: string;
} & (
  | { kind: 'message'; message: ForwardedMessage & { id: string } }
  | { kind: 'prompt'; task: string; attachments: Attachment[] }
);

export type StartResult =
  | { started: true; threadId: string; url: string }
  | { started: false; threadId: string };

export class Bridge {
  private readonly agent: AgentAdapter;
  private readonly store: TaskStore;
  private readonly chat: ChatPort;
  private readonly instructions: string;
  private readonly ignorePrefix: string;
  private readonly syncing = new Set<string>();

  constructor(options: {
    agent: AgentAdapter;
    store: TaskStore;
    chat: ChatPort;
    instructions: string;
    ignorePrefix: string;
  }) {
    this.agent = options.agent;
    this.store = options.store;
    this.chat = options.chat;
    this.instructions = options.instructions;
    this.ignorePrefix = options.ignorePrefix;
  }

  get agentName() {
    return this.agent.name;
  }

  async start(request: StartRequest): Promise<StartResult> {
    if (request.kind === 'message') {
      const existing = this.store.bySourceMessage(request.message.id);
      if (existing) return { started: false, threadId: existing.threadId };
    }
    const forwarded = request.kind === 'message' ? request.message : null;
    const title =
      request.kind === 'message'
        ? shortTitle(`${request.message.authorName}: ${request.message.content || 'attachment'}`)
        : shortTitle(request.task);
    const attachments =
      request.kind === 'message' ? request.message.attachments : request.attachments;
    const prompt =
      request.kind === 'message'
        ? forwardedMessagePrompt(request.message, this.instructions)
        : taskPrompt(request.task, this.instructions);

    const task = await this.agent.startTask({
      prompt,
      title,
      attachments,
      requestedBy: request.opener
    });
    const source = forwarded ? ` from ${forwarded.link}` : '';
    const threadId = await this.chat.createTaskThread(
      request.channelId,
      `${this.agent.name}: ${title}`,
      `**${title}**\nStarted by <@${request.opener.discordId}>${source}\n${task.url}`
    );
    this.store.insert({
      taskId: task.id,
      agent: this.agent.name,
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
      `${this.agent.name} is on it. Reply in this thread to give it feedback, images included.${aside}`
    );
    return { started: true, threadId, url: task.url };
  }

  isTaskThread(threadId: string) {
    return this.store.byThread(threadId) !== null;
  }

  /** Forwards a thread message to the thread's task. False if none. */
  async forward(
    threadId: string,
    from: Person,
    text: string,
    attachments: Attachment[]
  ): Promise<boolean> {
    const row = this.store.byThread(threadId);
    if (!row) return false;
    await this.agent.sendMessage(row.taskId, {
      text: text.trim() || '(see the attached files)',
      attachments,
      from
    });
    if (!row.active) this.store.update(row.taskId, { active: true });
    return true;
  }

  recent(limit = 10) {
    return this.store.recent(limit);
  }

  task(threadId: string) {
    return this.store.byThread(threadId);
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

  /** Relays new agent messages, PRs and status changes into the thread. */
  async sync(row: TaskRow) {
    if (this.syncing.has(row.taskId)) return;
    this.syncing.add(row.taskId);
    try {
      const update = await this.agent.getUpdate(row.taskId, row.cursor);
      for (const message of update.messages) {
        await this.post(row.threadId, `**${this.agent.name}:** ${message.text}`);
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
        this.agent.name
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
