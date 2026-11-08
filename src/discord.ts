import {
  ActionRowBuilder,
  AttachmentBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  ChannelFlags,
  ChannelType,
  Client,
  ComponentType,
  ContainerBuilder,
  ContextMenuCommandBuilder,
  DiscordAPIError,
  Events,
  FileBuilder,
  GatewayIntentBits,
  InteractionContextType,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  MessageReferenceType,
  Partials,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  TextDisplayBuilder,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type Attachment as DiscordAttachment,
  type ButtonInteraction,
  type Channel,
  type ChatInputCommandInteraction,
  type ForumChannel,
  type Collection,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type MessageContextMenuCommandInteraction
} from 'discord.js';
import { LINK_CHECK_ID, type Bot, type ChannelRef, type MessageOutcome, type Outcome } from './bot.ts';
import type { ChatButton, ChatPort } from './bridge.ts';
import type { DiscordReader, ForumPost, LinkButton, OwnChange, ReadMessage } from './mcp.ts';
import type { ForwardedMessage, MentionContext } from './format.ts';
import type { Attachment, DownloadedFile } from './devin.ts';
import type { ChannelInfo, Directory } from './directory.ts';
import type { MemberSnapshot } from './permissions.ts';
import type { TaskStore } from './store.ts';
import { parseControlId } from './triggers.ts';
import type { ChannelEvent, Watcher } from './webhooks.ts';

export const COMMAND = 'devin';
export const TRIGGER_EMOJI = '🤖';
export const IGNORE_PREFIX = '//';
/** Unprompted DMs (e.g. "not set up yet") go to the same person at most this often per server. */
const DM_COOLDOWN_MS = 10 * 60 * 1000;
/** The side bar of Devin's message cards: the setup site's accent. */
const CARD_ACCENT = 0x8891ff;
/** Files a media gallery shows inline. */
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|avif|mp4|webm|mov)$/i;

export function createClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
  });
}

export function discordChat(client: Client): ChatPort {
  async function fetchChannel(channelId: string) {
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found.`);
    return channel;
  }

  return {
    async createTaskThread(channelId, title, intro, options) {
      let channel = await fetchChannel(channelId);
      const isPrivate = Boolean(options?.private) || channel.type === ChannelType.PrivateThread;
      if (channel.isThread() && channel.parent) channel = channel.parent;
      const name = title.slice(0, 100);
      if (isPrivate) {
        if (channel.type !== ChannelType.GuildText) throw new Error('Private task threads need a text channel.');
        const thread = await channel.threads.create({
          name,
          type: ChannelType.PrivateThread,
          invitable: false,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek
        });
        await thread.send({ content: intro, allowedMentions: { parse: [] } });
        return thread.id;
      }
      if (channel.type === ChannelType.GuildForum) {
        const thread = await channel.threads.create({
          name,
          message: { content: intro, allowedMentions: { parse: [] } }
        });
        return thread.id;
      }
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
        throw new Error('Task threads need a text, announcement or forum channel.');
      }
      const starter = await channel.send({ content: intro, allowedMentions: { parse: [] } });
      const thread = await starter.startThread({
        name,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek
      });
      return thread.id;
    },

    async createThreadOnMessage(channelId, messageId, title) {
      const channel = await fetchChannel(channelId);
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
        throw new Error('Task threads need a text or announcement channel.');
      }
      const message = await channel.messages.fetch(messageId);
      const thread = await message.startThread({
        name: title.slice(0, 100),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek
      });
      return thread.id;
    },

    async threadExists(threadId) {
      try {
        return Boolean(await client.channels.fetch(threadId));
      } catch (error) {
        return !(error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel);
      }
    },

    async addThreadMember(threadId, userId) {
      const channel = await fetchChannel(threadId);
      if (channel.isThread()) await channel.members.add(userId);
    },

    async send(channelId, content, pingUserId, buttons, files) {
      const channel = await fetchChannel(channelId);
      if (!channel.isSendable()) throw new Error(`Cannot send to channel ${channelId}.`);
      await channel.send({
        content,
        allowedMentions: pingUserId ? { parse: [], users: [pingUserId] } : { parse: [] },
        components: buttons?.length ? [buttonRow(buttons)] : [],
        files: uploads(files)
      });
    },

    async sendCard(channelId, { text, pingUserId, files }) {
      const channel = await fetchChannel(channelId);
      if (!channel.isSendable()) throw new Error(`Cannot send to channel ${channelId}.`);
      const named = cardFiles(files ?? []);
      const container = new ContainerBuilder()
        .setAccentColor(CARD_ACCENT)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
      const media = named.filter((file) => MEDIA_FILE.test(file.name));
      if (media.length) {
        container.addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(
            media.map((file) => new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`))
          )
        );
      }
      for (const file of named.filter((file) => !MEDIA_FILE.test(file.name))) {
        container.addFileComponents(new FileBuilder().setURL(`attachment://${file.name}`));
      }
      await channel.send({
        flags: MessageFlags.IsComponentsV2,
        components: [container],
        allowedMentions: pingUserId ? { parse: [], users: [pingUserId] } : { parse: [] },
        files: uploads(named)
      });
    }
  };
}

function uploads(files?: DownloadedFile[]) {
  return (files ?? []).map((file) => new AttachmentBuilder(Buffer.from(file.data), { name: file.name }));
}

/** Card components point at files by `attachment://<name>`, so names are made URL-safe and unique. */
export function cardFiles(files: DownloadedFile[]): DownloadedFile[] {
  const taken = new Set<string>();
  return files.map((file) => {
    const safe = file.name.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-100) || 'file';
    let name = safe;
    for (let n = 2; taken.has(name); n++) name = `${n}-${safe}`;
    taken.add(name);
    return { name, data: file.data };
  });
}

function linkRow(buttons: LinkButton[]) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    buttons.map((button) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(button.label).setURL(button.url))
  );
}

function buttonRow(buttons: ChatButton[]) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    buttons.map((button) =>
      new ButtonBuilder()
        .setCustomId(button.customId)
        .setLabel(button.label)
        .setStyle(button.style === 'danger' ? ButtonStyle.Danger : ButtonStyle.Secondary)
    )
  );
}

/** Bot permissions requested by the "Add to Discord" link. */
export const BOT_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.CreatePublicThreads |
  PermissionFlagsBits.CreatePrivateThreads |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.PinMessages |
  PermissionFlagsBits.SendPolls;

/** Who may run the commands is decided per server by role settings, so they're visible to everyone. */
export function commandDefinitions() {
  const slash = new SlashCommandBuilder()
    .setName(COMMAND)
    .setDescription('Start and follow Devin tasks')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Give Devin a task')
        .addStringOption((option) =>
          option.setName('task').setDescription('What to do').setRequired(true).setMaxLength(4000)
        )
        .addAttachmentOption((option) =>
          option.setName('file').setDescription('Optional image or file')
        )
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription("Status and PRs of this thread's task")
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Recent tasks in threads you can see'))
    .addSubcommand((sub) => sub.setName('stop').setDescription("Stop this thread's task for good"))
    .addSubcommand((sub) =>
      sub.setName('sleep').setDescription("Put this thread's task to sleep; a reply wakes it")
    )
    .addSubcommand((sub) =>
      sub
        .setName('merge')
        .setDescription("Merge this thread's pull request once its checks pass")
        .addStringOption((option) =>
          option.setName('pr').setDescription('Another PR: its number (same repo) or URL').setMaxLength(200)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('review')
        .setDescription("Get a Devin Review of this thread's pull request")
        .addStringOption((option) =>
          option.setName('pr').setDescription('Another PR: its number (same repo) or URL').setMaxLength(200)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('link').setDescription('Link your Devin account so the tasks you start run as you')
    )
    .addSubcommand((sub) => sub.setName('unlink').setDescription('Unlink your Devin account'));
  const contextMenu = new ContextMenuCommandBuilder()
    .setName('Send to Devin')
    .setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild);
  return [slash.toJSON(), contextMenu.toJSON()];
}

export function memberSnapshot(member: GuildMember): MemberSnapshot {
  const roleIds = new Set(member.roles.cache.keys());
  roleIds.add(member.guild.id);
  return {
    id: member.id,
    name: member.displayName,
    roleIds: [...roleIds],
    isAdmin: member.permissions.has(PermissionFlagsBits.Administrator),
    canManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild)
  };
}

function everyoneCanView(channel: GuildBasedChannel) {
  return channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ?? false;
}

/** Whether Discord lets `member` view the thread: the parent's View Channel, plus membership for private threads. */
export async function canSeeThread(member: GuildMember, threadId: string): Promise<boolean> {
  const channel =
    member.guild.channels.cache.get(threadId) ??
    (await member.guild.channels.fetch(threadId).catch(() => null));
  if (!channel) return false;
  const perms = channel.permissionsFor(member);
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) return false;
  if (channel.type !== ChannelType.PrivateThread || perms.has(PermissionFlagsBits.ManageThreads)) return true;
  return Boolean(await channel.members.fetch({ member: member.id }).catch(() => null));
}

function channelRef(channel: Channel | null, fallbackId: string): ChannelRef {
  if (channel?.isThread()) {
    return { id: channel.id, parentId: channel.parentId, isPrivate: channel.type === ChannelType.PrivateThread };
  }
  return { id: channel?.id ?? fallbackId, parentId: null };
}

const CHANNEL_KINDS: Partial<Record<ChannelType, ChannelInfo['kind']>> = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum'
};

/** The setup UI's view of servers, read live through the bot. */
export function discordDirectory(client: Client): Directory {
  return {
    hasGuild: (guildId) => client.guilds.cache.has(guildId),
    guildName: (guildId) => client.guilds.cache.get(guildId)?.name ?? null,
    async member(guildId, userId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return null;
      try {
        // Without the GuildMembers intent the cache never hears about role changes, kicks or bans.
        return memberSnapshot(await guild.members.fetch({ user: userId, force: true }));
      } catch (error) {
        if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMember) {
          return null;
        }
        throw error;
      }
    },
    async roles(guildId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return [];
      const roles = await guild.roles.fetch();
      return [...roles.values()].map((role) => ({
        id: role.id,
        name: role.id === guild.id ? '@everyone' : role.name,
        color: role.color,
        position: role.position,
        managed: role.managed
      }));
    },
    async channels(guildId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return [];
      const channels = await guild.channels.fetch();
      let me: GuildMember | null;
      try {
        me = guild.members.me ?? (await guild.members.fetchMe());
      } catch {
        me = null;
      }
      const result: ChannelInfo[] = [];
      for (const channel of channels.values()) {
        const kind = channel && CHANNEL_KINDS[channel.type];
        if (!channel || !kind) continue;
        const perms = me ? channel.permissionsFor(me) : null;
        result.push({
          id: channel.id,
          name: channel.name,
          kind,
          category: channel.parent?.name ?? null,
          position: channel.parent ? channel.parent.position * 1000 + channel.position : channel.position,
          public: everyoneCanView(channel),
          ...(channel.type === ChannelType.GuildForum ? forumTags(channel) : {}),
          ...(me
            ? {
                bot: {
                  read: perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) ?? false,
                  post: perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) ?? false
                }
              }
            : {})
        });
      }
      return result;
    },
    async visibleChannels(guildId, userId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return [];
      let member: GuildMember;
      try {
        member = await guild.members.fetch({ user: userId, force: true });
      } catch {
        return [];
      }
      const channels = await guild.channels.fetch();
      return [...channels.values()]
        .filter(
          (channel) =>
            channel &&
            CHANNEL_KINDS[channel.type] &&
            channel.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])
        )
        .map((channel) => channel!.id);
    }
  };
}

function attachments(files: Collection<string, DiscordAttachment> | DiscordAttachment[]): Attachment[] {
  return [...files.values()].map((file) => ({ url: file.url, filename: file.name }));
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function forwarded(message: Message<true>): ForwardedMessage & { id: string } {
  return {
    id: message.id,
    authorName: message.member?.displayName ?? message.author.username,
    authorId: message.author.id,
    link: message.url,
    content: message.content,
    attachments: attachments(message.attachments)
  };
}

/** The replied-to message and the last `limit` channel messages before `message`. */
async function loadContext(message: Message<true>, limit: number): Promise<MentionContext> {
  const repliedTo = message.reference?.messageId
    ? await message.fetchReference().then(forwarded, () => null)
    : null;
  if (limit <= 0) return { repliedTo, recent: [] };
  const history = await message.channel.messages
    .fetch({ limit: Math.min(limit, 100), before: message.id })
    .catch(() => null);
  const recent = [...(history?.values() ?? [])]
    .filter((item) => item.id !== repliedTo?.id && (item.content.trim() || item.attachments.size))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(forwarded);
  return { repliedTo, recent };
}

/** The body a watched channel's webhook gets for `message`. */
export function channelEvent(message: Message<true>): ChannelEvent {
  const channel = message.channel;
  return {
    type: 'message.created',
    guild: { id: message.guildId, name: message.guild.name },
    channel: {
      id: channel.id,
      name: 'name' in channel ? channel.name : '',
      parentId: channel.isThread() ? channel.parentId : null,
      isThread: channel.isThread()
    },
    message: {
      id: message.id,
      link: message.url,
      content: message.content,
      author: {
        id: message.author.id,
        name: message.member?.displayName ?? message.author.username,
        bot: message.author.bot
      },
      attachments: [...message.attachments.values()].map((file) => ({ filename: file.name, url: file.url })),
      createdAt: new Date(message.createdTimestamp).toISOString()
    }
  };
}

function mentionsUser(content: string, userId: string) {
  return content.includes(`<@${userId}>`) || content.includes(`<@!${userId}>`);
}

/** Tasks from before servers were tracked get their guild from their thread. */
export async function backfillTaskGuilds(client: Client, tasks: TaskStore) {
  for (const row of tasks.withoutGuild()) {
    try {
      const channel = await client.channels.fetch(row.threadId);
      if (channel && 'guildId' in channel && channel.guildId) {
        tasks.update(row.taskId, { guildId: channel.guildId });
      }
    } catch (error) {
      console.error(`Looking up the server of task ${row.taskId} failed:`, errorText(error));
    }
  }
}

export function wireDiscord(client: Client, bot: Bot, tasks: TaskStore, watcher?: Watcher) {
  const lastDm = new Map<string, number>();
  async function dmOnce(guildId: string, userId: string, text: string) {
    const key = `${guildId}:${userId}:${text}`;
    const now = Date.now();
    if ((lastDm.get(key) ?? 0) > now - DM_COOLDOWN_MS) return;
    lastDm.set(key, now);
    const user = await client.users.fetch(userId);
    await user.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  }

  client.once(Events.ClientReady, async (ready) => {
    console.log(`Logged in as ${ready.user.tag} in ${ready.guilds.cache.size} servers.`);
    try {
      await ready.application.commands.set(commandDefinitions());
      console.log('Registered commands globally.');
      await backfillTaskGuilds(client, tasks);
    } catch (error) {
      console.error('Start-up after login failed:', errorText(error));
    }
  });

  client.on(Events.Error, (error) => console.error('Discord client error:', errorText(error)));

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.inCachedGuild()) return;
    if (interaction.isButton()) return handleButton(interaction);
    if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = memberSnapshot(interaction.member);
      const outcome = interaction.isMessageContextMenuCommand()
        ? await handleContextMenu(interaction, member)
        : await handleSlash(interaction, member);
      await interaction.editReply({
        content: outcome.reply,
        allowedMentions: { parse: [] },
        components: outcome.ok && outcome.buttons?.length ? [buttonRow(outcome.buttons)] : []
      });
    } catch (error) {
      console.error('Command failed:', error);
      await interaction.editReply(`Failed: ${errorText(error)}`).catch(() => {});
    }
  });

  async function handleButton(interaction: ButtonInteraction<'cached'>) {
    if (interaction.customId === LINK_CHECK_ID) return handleLinkCheck(interaction);
    const control = parseControlId(interaction.customId);
    if (!control) return;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const outcome = await bot.controlButton(
        interaction.customId,
        interaction.guildId,
        memberSnapshot(interaction.member),
        interaction.channelId
      );
      await interaction.editReply({ content: outcome.reply, allowedMentions: { parse: [] } });
      if (outcome.ok && control.action === 'stop') {
        await interaction.message.edit({ components: [] }).catch(() => {});
      }
    } catch (error) {
      console.error('Button failed:', error);
      await interaction.editReply(`Failed: ${errorText(error)}`).catch(() => {});
    }
  }

  /** Updates the private `/devin link` message in place, keeping the button until the link is made. */
  async function handleLinkCheck(interaction: ButtonInteraction<'cached'>) {
    try {
      await interaction.deferUpdate();
      const outcome = await bot.linkCheck(interaction.guildId, memberSnapshot(interaction.member));
      const retry = !outcome.ok && outcome.reason === 'empty';
      const intro = interaction.message.content.split('\n\n')[0];
      await interaction.editReply({
        content: retry ? `${intro}\n\n**Not found yet.** ${outcome.reply}`.slice(0, 2000) : outcome.reply,
        allowedMentions: { parse: [] },
        components: retry ? interaction.message.components : []
      });
    } catch (error) {
      console.error('Link check failed:', error);
      await interaction.followUp({ content: `Failed: ${errorText(error)}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }

  function handleContextMenu(
    interaction: MessageContextMenuCommandInteraction<'cached'>,
    member: MemberSnapshot
  ) {
    const message = interaction.targetMessage;
    return bot.startFromMessage(
      interaction.guildId,
      member,
      channelRef(message.channel, message.channelId),
      forwarded(message)
    );
  }

  async function handleSlash(
    interaction: ChatInputCommandInteraction<'cached'>,
    member: MemberSnapshot
  ): Promise<Outcome> {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') {
      const file = interaction.options.getAttachment('file');
      return bot.startFromPrompt(
        interaction.guildId,
        member,
        channelRef(interaction.channel, interaction.channelId),
        interaction.options.getString('task', true),
        file ? attachments([file]) : []
      );
    }
    if (sub === 'status') return bot.status(interaction.guildId, member, interaction.channelId);
    if (sub === 'merge' || sub === 'review') {
      const pr = interaction.options.getString('pr');
      return bot[sub](interaction.guildId, member, interaction.channelId, pr);
    }
    if (sub === 'link') return bot.link(interaction.guildId, member);
    if (sub === 'unlink') return bot.unlink(interaction.guildId, member);
    if (sub === 'stop' || sub === 'sleep') {
      return bot.controlThread(sub, interaction.guildId, member, interaction.channelId);
    }
    return bot.list(interaction.guildId, member, (threadId) =>
      canSeeThread(interaction.member, threadId)
    );
  }

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot || reaction.emoji.name !== TRIGGER_EMOJI) return;
    try {
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      if (!message.inGuild() || bot.isTaskThread(message.channelId)) return;
      const member = await message.guild.members.fetch({ user: user.id, force: true });
      const outcome = await bot.startFromMessage(
        message.guildId,
        memberSnapshot(member),
        channelRef(message.channel, message.channelId),
        forwarded(message)
      );
      if (outcome.ok && outcome.started) await message.react('✅').catch(() => {});
      if (!outcome.ok && (outcome.reason === 'unconfigured' || outcome.reason === 'limit')) {
        await dmOnce(message.guildId, user.id, outcome.reply);
      }
    } catch (error) {
      console.error('Starting a task from a reaction failed:', error);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!message.inGuild() || !client.user) return;
    if (message.content.startsWith(IGNORE_PREFIX)) return;
    const channel = channelRef(message.channel, message.channelId);
    void watcher
      ?.notify({
        guildId: message.guildId,
        channel,
        fromSelf: message.author.id === client.user.id,
        fromBot: message.author.bot || Boolean(message.webhookId),
        event: () => channelEvent(message)
      })
      .catch((error) => console.error('Sending a message to the webhook failed:', errorText(error)));
    if (message.author.bot) return;
    const inTaskThread = bot.isTaskThread(message.channelId);
    const isThreadStarter = message.channel.isThread() && message.id === message.channelId;
    // Only task threads, @mentions and auto-start channels need a member lookup.
    if (
      !inTaskThread &&
      !mentionsUser(message.content, client.user.id) &&
      !bot.autoStarts(message.guildId, channel, isThreadStarter)
    ) {
      return;
    }
    try {
      const member = message.member ?? (await message.guild.members.fetch(message.author.id));
      const outcome = await bot.handleMessage({
        guildId: message.guildId,
        member: memberSnapshot(member),
        channel,
        message: forwarded(message),
        botUserId: client.user.id,
        isReply: Boolean(message.reference?.messageId),
        isThreadStarter,
        threadTitle: message.channel.isThread() ? message.channel.name : undefined,
        loadContext: (limit) => loadContext(message, limit)
      });
      await deliver(message, outcome, inTaskThread);
    } catch (error) {
      console.error('Handling a message failed:', error);
      await message.reply(`Could not pass this to Devin: ${errorText(error)}`).catch(() => {});
    }
  });

  /** Messages can't get ephemeral replies, so denials go privately by DM. */
  async function deliver(message: Message<true>, outcome: MessageOutcome, inTaskThread: boolean) {
    if (outcome.action === 'forwarded') await message.react('📨').catch(() => {});
    else if (outcome.action === 'started') await message.react('✅').catch(() => {});
    else if (outcome.action === 'denied') {
      // A plain thread reply from someone without access stays silent, as before.
      const quiet = inTaskThread && outcome.reason === 'forbidden' && !mentionsUser(message.content, client.user!.id);
      if (!quiet) await dmOnce(message.guildId, message.author.id, outcome.reply);
    }
  }
}

/** The text inside a message's components: card text and link buttons. Card messages have no plain content. */
export function componentText(components: readonly { toJSON(): unknown }[]): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const item = node as { type?: number; content?: unknown; label?: unknown; url?: unknown; components?: unknown[]; accessory?: unknown };
    if (item.type === ComponentType.TextDisplay && typeof item.content === 'string') out.push(item.content);
    if (item.type === ComponentType.Button && typeof item.url === 'string') out.push(`[${typeof item.label === 'string' ? item.label : 'Link'}](${item.url})`);
    if (Array.isArray(item.components)) item.components.forEach(walk);
    walk(item.accessory);
  };
  for (const component of components) walk(component.toJSON());
  return out;
}

function embedText(embed: Message['embeds'][number]) {
  const lines = [embed.title, embed.url, embed.description, ...embed.fields.map((field) => `${field.name}: ${field.value}`)].filter(Boolean);
  return lines.length ? `Embed: ${lines.join('\n')}` : '';
}

function readMessage(message: Message): ReadMessage {
  const text = [message.content, ...componentText(message.components), ...message.embeds.map(embedText)].filter(Boolean).join('\n');
  const reference = message.reference;
  const reactions = [...message.reactions.cache.values()].map(
    (reaction) => `${reaction.emoji.id ? `${reaction.emoji.name}:${reaction.emoji.id}` : reaction.emoji.name} ${reaction.count}`
  );
  const poll = message.poll;
  return {
    id: message.id,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.displayName,
    bot: message.author.bot,
    content: text,
    attachments: [...message.attachments.values()].map((file) => file.url),
    createdAt: message.createdTimestamp,
    link: message.url,
    ...(reference?.type === MessageReferenceType.Default && reference.messageId && reference.channelId === message.channelId
      ? { replyTo: reference.messageId }
      : {}),
    ...(reactions.length ? { reactions } : {}),
    ...(poll
      ? {
          poll: {
            question: poll.question.text ?? '',
            answers: [...poll.answers.values()].map((answer) => ({ text: answer.text ?? '', votes: answer.voteCount })),
            closed: poll.resultsFinalized || (poll.expiresTimestamp ?? Infinity) <= Date.now()
          }
        }
      : {})
  };
}

/** Reads and posts for the MCP tools. Callers check the channel is allowed first. */
function forumTags(forum: ForumChannel) {
  return {
    tags: forum.availableTags.map((tag) => tag.name),
    requireTag: forum.flags.has(ChannelFlags.RequireTag)
  };
}

function forumPost(thread: AnyThreadChannel): ForumPost {
  return {
    id: thread.id,
    title: thread.name,
    authorId: thread.ownerId ?? null,
    createdAt: thread.createdTimestamp ?? 0,
    archived: Boolean(thread.archived),
    messageCount: thread.messageCount ?? 0,
    link: `https://discord.com/channels/${thread.guildId}/${thread.id}`
  };
}

export function discordReader(client: Client): DiscordReader {
  async function guildChannel(channelId: string) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    return channel && !channel.isDMBased() ? channel : null;
  }
  async function textChannel(channelId: string) {
    const channel = await guildChannel(channelId);
    if (!channel?.isTextBased()) throw new Error(`Channel ${channelId} has no messages to read.`);
    return channel;
  }
  async function fetchOrNull(channel: { messages: { fetch(id: string): Promise<Message> } }, messageId: string) {
    try {
      return await channel.messages.fetch(messageId);
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) return null;
      throw error;
    }
  }
  /** A message the bot posted that doesn't start a thread, or why it can't be changed. */
  async function ownMessage(channelId: string, messageId: string): Promise<Message | Exclude<OwnChange, 'ok' | 'card'>> {
    const message = await fetchOrNull(await textChannel(channelId), messageId);
    if (!message) return 'missing';
    if (message.author.id !== client.user?.id) return 'not_own';
    if (message.hasThread || message.id === channelId) return 'thread';
    return message;
  }
  async function forumChannel(channelId: string) {
    const channel = await guildChannel(channelId);
    if (channel?.type !== ChannelType.GuildForum) throw new Error(`Channel ${channelId} isn't a forum.`);
    return channel;
  }
  return {
    async channel(channelId) {
      const channel = await guildChannel(channelId);
      if (!channel) return null;
      const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe().catch(() => null));
      const perms = me ? channel.permissionsFor(me) : null;
      const send = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
      return {
        id: channel.id,
        guildId: channel.guildId,
        name: channel.name,
        parentId: channel.parentId ?? null,
        isThread: channel.isThread(),
        isPrivate: channel.type === ChannelType.PrivateThread,
        isPublic: everyoneCanView(channel),
        ...(perms
          ? {
              bot: {
                read: perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]),
                post: perms.has([PermissionFlagsBits.ViewChannel, send])
              }
            }
          : {}),
        ...(channel.type === ChannelType.GuildForum ? { forum: forumTags(channel) } : {})
      };
    },
    async messages(channelId, { limit, before }) {
      const channel = await textChannel(channelId);
      const list = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });
      return [...list.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(readMessage);
    },
    async message(channelId, messageId) {
      const channel = await textChannel(channelId);
      try {
        return readMessage(await channel.messages.fetch(messageId));
      } catch (error) {
        if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) return null;
        throw error;
      }
    },
    async send(channelId, content, files, options = {}) {
      const channel = await textChannel(channelId);
      const sent = await channel.send({
        content: content || undefined,
        allowedMentions: { parse: [], repliedUser: false, ...(options.pingUserId ? { users: [options.pingUserId] } : {}) },
        files: uploads(files),
        ...(options.buttons?.length ? { components: [linkRow(options.buttons)] } : {}),
        ...(options.replyTo ? { reply: { messageReference: options.replyTo, failIfNotExists: true } } : {})
      });
      return sent.id;
    },
    async startPost(forumId, { title, content, tags, files, buttons }) {
      const forum = await forumChannel(forumId);
      const byName = new Map(forum.availableTags.map((tag) => [tag.name, tag.id]));
      const thread = await forum.threads.create({
        name: title,
        message: {
          content: content || undefined,
          allowedMentions: { parse: [] },
          files: uploads(files),
          ...(buttons?.length ? { components: [linkRow(buttons)] } : {})
        },
        appliedTags: tags.flatMap((name) => byName.get(name) ?? [])
      });
      return { threadId: thread.id, messageId: thread.id };
    },
    async posts(forumId, limit) {
      const forum = await forumChannel(forumId);
      const active = await forum.threads.fetchActive(false);
      const open = [...active.threads.values()].sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0));
      const posts = open.slice(0, limit).map(forumPost);
      if (posts.length < limit) {
        const archived = await forum.threads.fetchArchived({ type: 'public', limit: limit - posts.length }, false);
        posts.push(...[...archived.threads.values()].map(forumPost));
      }
      return posts;
    },
    async react(channelId, messageId, emoji) {
      const channel = await textChannel(channelId);
      const message = await channel.messages.fetch(messageId);
      await message.react(emoji);
    },
    async unreact(channelId, messageId, emoji) {
      const channel = await textChannel(channelId);
      const message = await channel.messages.fetch(messageId);
      const reaction = message.reactions.cache.find(
        (item) => item.emoji.name === emoji || (item.emoji.id !== null && `${item.emoji.name}:${item.emoji.id}` === emoji)
      );
      if (reaction) await reaction.users.remove(client.user!.id);
    },
    async edit(channelId, messageId, { content, buttons }) {
      const message = await ownMessage(channelId, messageId);
      if (typeof message === 'string') return message;
      if (message.flags.has(MessageFlags.IsComponentsV2)) return 'card';
      await message.edit({
        content,
        allowedMentions: { parse: [] },
        ...(buttons ? { components: buttons.length ? [linkRow(buttons)] : [] } : {})
      });
      return 'ok';
    },
    async remove(channelId, messageId) {
      const message = await ownMessage(channelId, messageId);
      if (typeof message === 'string') return message;
      await message.delete();
      return 'ok';
    },
    async startThread(channelId, { name, messageId }) {
      const channel = await guildChannel(channelId);
      if (channel?.type !== ChannelType.GuildText) throw new Error(`Channel ${channelId} isn't a text channel.`);
      if (messageId) {
        const message = await fetchOrNull(channel, messageId);
        if (!message) return null;
        return (await message.startThread({ name })).id;
      }
      return (await channel.threads.create({ name, type: ChannelType.PublicThread })).id;
    },
    async pin(channelId, messageId, pinned) {
      const message = await fetchOrNull(await textChannel(channelId), messageId);
      if (!message) return false;
      await (pinned ? message.pin() : message.unpin());
      return true;
    },
    async poll(channelId, { question, answers, hours, multiselect }) {
      const channel = await textChannel(channelId);
      const sent = await channel.send({
        poll: { question: { text: question }, answers: answers.map((text) => ({ text })), duration: hours, allowMultiselect: multiselect },
        allowedMentions: { parse: [] }
      });
      return sent.id;
    }
  };
}
