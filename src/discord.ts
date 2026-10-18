import {
  ApplicationCommandType,
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
  type Channel,
  type ChatInputCommandInteraction,
  type Collection,
  type GuildMember,
  type Message,
  type MessageContextMenuCommandInteraction
} from 'discord.js';
import type { Bot, ChannelRef, Outcome } from './bot.ts';
import type { ChatPort } from './bridge.ts';
import type { Attachment } from './devin.ts';
import type { ChannelInfo, Directory } from './directory.ts';
import type { MemberSnapshot } from './permissions.ts';
import type { TaskStore } from './store.ts';

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

    async addThreadMember(threadId, userId) {
      const channel = await fetchChannel(threadId);
      if (channel.isThread()) await channel.members.add(userId);
    },

    async send(channelId, content, pingUserId) {
      const channel = await fetchChannel(channelId);
      if (!channel.isSendable()) throw new Error(`Cannot send to channel ${channelId}.`);
      await channel.send({
        content,
        allowedMentions: pingUserId ? { parse: [], users: [pingUserId] } : { parse: [] }
      });
    }
  };
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
    .addSubcommand((sub) => sub.setName('list').setDescription('Recent tasks in this server'));
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
      try {
        return memberSnapshot(await guild.members.fetch(userId));
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
      const result: ChannelInfo[] = [];
      for (const channel of channels.values()) {
        const kind = channel && CHANNEL_KINDS[channel.type];
        if (!channel || !kind) continue;
        result.push({
          id: channel.id,
          name: channel.name,
          kind,
          category: channel.parent?.name ?? null,
          position: channel.parent ? channel.parent.position * 1000 + channel.position : channel.position
        });
      }
      return result;
    }
  };
}

function attachments(files: Collection<string, DiscordAttachment> | DiscordAttachment[]): Attachment[] {
  return [...files.values()].map((file) => ({ url: file.url, filename: file.name }));
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function forwarded(message: Message<true>) {
  return {
    id: message.id,
    authorName: message.member?.displayName ?? message.author.username,
    authorId: message.author.id,
    link: message.url,
    content: message.content,
    attachments: attachments(message.attachments)
  };
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
    const key = `${guildId}:${userId}`;
    const now = Date.now();
    if ((lastDm.get(key) ?? 0) > now - DM_COOLDOWN_MS) return;
    lastDm.set(key, now);
    const user = await client.users.fetch(userId);
    await user.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  }

  client.once(Events.ClientReady, async (ready) => {
    console.log(`Logged in as ${ready.user.tag} in ${ready.guilds.cache.size} servers.`);
    await ready.application.commands.set(commandDefinitions());
    console.log('Registered commands globally.');
    await backfillTaskGuilds(client, tasks);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.inCachedGuild()) return;
    if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
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
    return bot.list(interaction.guildId, member);
  }

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot || reaction.emoji.name !== TRIGGER_EMOJI) return;
    try {
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      if (!message.inGuild() || bot.isTaskThread(message.channelId)) return;
      const member = await message.guild.members.fetch(user.id);
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
    if (message.author.bot || !message.inGuild() || !message.channel.isThread()) return;
    if (!bot.isTaskThread(message.channelId)) return;
    if (message.content.startsWith(IGNORE_PREFIX)) return;
    if (!message.content.trim() && message.attachments.size === 0) return;
    try {
      const member = message.member ?? (await message.guild.members.fetch(message.author.id));
      const outcome = await bot.reply(
        message.guildId,
        memberSnapshot(member),
        message.channelId,
        message.content,
        attachments(message.attachments)
      );
      if (outcome.ok) await message.react('📨').catch(() => {});
      else if (outcome.reason === 'unconfigured') {
        await dmOnce(message.guildId, message.author.id, outcome.reply);
      }
    } catch (error) {
      console.error('Forwarding a thread message failed:', error);
      await message.reply(`Could not forward this: ${errorText(error)}`).catch(() => {});
    }
  });
}
