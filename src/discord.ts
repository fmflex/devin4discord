import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ContextMenuCommandBuilder,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type Attachment as DiscordAttachment,
  type ButtonInteraction,
  type Channel,
  type ChatInputCommandInteraction,
  type Collection,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type MessageContextMenuCommandInteraction,
  type PermissionsBitField
} from 'discord.js';
import type { Bot, ChannelRef, MessageOutcome, Outcome } from './bot.ts';
import type { ChatButton, ChatPort } from './bridge.ts';
import type { DiscordReader, ReadMessage } from './mcp.ts';
import type { ForwardedMessage, MentionContext } from './format.ts';
import type { Attachment } from './devin.ts';
import type { ChannelAccess, ChannelInfo, Directory } from './directory.ts';
import type { MemberSnapshot } from './permissions.ts';
import type { TaskStore } from './store.ts';
import { parseControlId } from './triggers.ts';

export const COMMAND = 'devin';
export const TRIGGER_EMOJI = '🤖';
export const IGNORE_PREFIX = '//';
/** Unprompted DMs (e.g. "not set up yet") go to the same person at most this often per server. */
const DM_COOLDOWN_MS = 10 * 60 * 1000;

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
    async createTaskThread(channelId, title, intro) {
      let channel = await fetchChannel(channelId);
      if (channel.isThread() && channel.parent) channel = channel.parent;
      const name = title.slice(0, 100);
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

    async addThreadMember(threadId, userId) {
      const channel = await fetchChannel(threadId);
      if (channel.isThread()) await channel.members.add(userId);
    },

    async send(channelId, content, pingUserId, buttons) {
      const channel = await fetchChannel(channelId);
      if (!channel.isSendable()) throw new Error(`Cannot send to channel ${channelId}.`);
      await channel.send({
        content,
        allowedMentions: pingUserId ? { parse: [], users: [pingUserId] } : { parse: [] },
        components: buttons?.length ? [buttonRow(buttons)] : []
      });
    }
  };
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
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.EmbedLinks;

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
    );
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
  if (channel?.isThread()) return { id: channel.id, parentId: channel.parentId };
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
      const member = await freshMember(guild, userId);
      return member ? memberSnapshot(member) : null;
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
    async channels(guildId, viewerId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return [];
      const channels = await guild.channels.fetch();
      let me: GuildMember | null;
      try {
        me = guild.members.me ?? (await guild.members.fetchMe());
      } catch {
        me = null;
      }
      const viewer = viewerId ? await freshMember(guild, viewerId) : null;
      const result: ChannelInfo[] = [];
      for (const channel of channels.values()) {
        const kind = channel && CHANNEL_KINDS[channel.type];
        if (!channel || !kind) continue;
        result.push({
          id: channel.id,
          name: channel.name,
          kind,
          category: channel.parent?.name ?? null,
          position: channel.parent ? channel.parent.position * 1000 + channel.position : channel.position,
          public: everyoneCanView(channel),
          ...(me ? { bot: channelAccess(channel.permissionsFor(me), false) } : {}),
          ...(viewerId ? { viewer: viewer ? channelAccess(channel.permissionsFor(viewer), false) : NO_ACCESS } : {})
        });
      }
      return result;
    },
    async access(guildId, userId, channelId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return NO_ACCESS;
      const [member, channel] = await Promise.all([
        freshMember(guild, userId),
        client.channels.fetch(channelId).catch(() => null)
      ]);
      if (!member || !channel || channel.isDMBased() || channel.guildId !== guildId) return NO_ACCESS;
      const perms = channel.permissionsFor(member);
      const access = channelAccess(perms, channel.isThread());
      // A private thread is only visible to its members and to Manage Threads holders.
      if (
        channel.type === ChannelType.PrivateThread &&
        !perms?.has(PermissionFlagsBits.ManageThreads) &&
        !(await channel.members.fetch({ member: userId, force: true }).catch(() => null))
      ) {
        return NO_ACCESS;
      }
      return access;
    }
  };
}

const NO_ACCESS: ChannelAccess = { read: false, post: false };

function channelAccess(perms: Readonly<PermissionsBitField> | null, thread: boolean): ChannelAccess {
  const send = thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  return {
    read: perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) ?? false,
    post: perms?.has([PermissionFlagsBits.ViewChannel, send]) ?? false
  };
}

/** Without the GuildMembers intent the cache never hears about role changes, kicks or bans. */
async function freshMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch({ user: userId, force: true });
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMember) return null;
    throw error;
  }
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

export function wireDiscord(client: Client, bot: Bot, tasks: TaskStore) {
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
      await interaction.editReply({ content: outcome.reply, allowedMentions: { parse: [] } });
    } catch (error) {
      console.error('Command failed:', error);
      await interaction.editReply(`Failed: ${errorText(error)}`).catch(() => {});
    }
  });

  async function handleButton(interaction: ButtonInteraction<'cached'>) {
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
    if (message.author.bot || !message.inGuild() || !client.user) return;
    if (message.content.startsWith(IGNORE_PREFIX)) return;
    const inTaskThread = bot.isTaskThread(message.channelId);
    // Only task threads and @mentions need a member lookup.
    if (!inTaskThread && !mentionsUser(message.content, client.user.id)) return;
    try {
      const member = message.member ?? (await message.guild.members.fetch(message.author.id));
      const outcome = await bot.handleMessage({
        guildId: message.guildId,
        member: memberSnapshot(member),
        channel: channelRef(message.channel, message.channelId),
        message: forwarded(message),
        botUserId: client.user.id,
        isReply: Boolean(message.reference?.messageId),
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

function readMessage(message: Message): ReadMessage {
  return {
    id: message.id,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.displayName,
    bot: message.author.bot,
    content: message.content,
    attachments: [...message.attachments.values()].map((file) => file.url),
    createdAt: message.createdTimestamp,
    link: message.url
  };
}

/** Reads and posts for the MCP tools. Callers check the channel is allowed first. */
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
  return {
    async channel(channelId) {
      const channel = await guildChannel(channelId);
      if (!channel) return null;
      return {
        id: channel.id,
        guildId: channel.guildId,
        name: channel.name,
        parentId: channel.parentId ?? null,
        isThread: channel.isThread(),
        isPrivate: channel.type === ChannelType.PrivateThread,
        isPublic: everyoneCanView(channel)
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
    async send(channelId, content) {
      const channel = await textChannel(channelId);
      const sent = await channel.send({ content, allowedMentions: { parse: [] } });
      return sent.id;
    },
    async react(channelId, messageId, emoji) {
      const channel = await textChannel(channelId);
      const message = await channel.messages.fetch(messageId);
      await message.react(emoji);
    }
  };
}
