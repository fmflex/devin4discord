import {
  ApplicationCommandType,
  ChannelType,
  Client,
  ContextMenuCommandBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type Attachment as DiscordAttachment,
  type ChatInputCommandInteraction,
  type Collection,
  type GuildMember,
  type Message,
  type MessageContextMenuCommandInteraction
} from 'discord.js';
import type { Attachment, Person } from './agents/types.ts';
import type { Bridge, ChatPort, StartResult } from './bridge.ts';
import type { Config } from './config.ts';

const COMMAND = 'agent';

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

export function commandDefinitions(agentName: string) {
  const slash = new SlashCommandBuilder()
    .setName(COMMAND)
    .setDescription(`Start and follow ${agentName} tasks`)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription(`Give ${agentName} a task`)
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
    .addSubcommand((sub) => sub.setName('list').setDescription('Recent tasks'));
  const contextMenu = new ContextMenuCommandBuilder()
    .setName(`Send to ${agentName}`)
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild);
  return [slash.toJSON(), contextMenu.toJSON()];
}

function isAllowed(member: GuildMember, config: Config) {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    config.allowedRoleIds.some((roleId) => member.roles.cache.has(roleId))
  );
}

function person(member: GuildMember): Person {
  return { discordId: member.id, name: member.displayName };
}

function attachments(files: Collection<string, DiscordAttachment> | DiscordAttachment[]): Attachment[] {
  return [...files.values()].map((file) => ({ url: file.url, filename: file.name }));
}

function startedReply(result: StartResult, agentName: string) {
  return result.started
    ? `${agentName} task started: <#${result.threadId}>`
    : `That message already has a task: <#${result.threadId}>`;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function wireDiscord(client: Client, bridge: Bridge, config: Config) {
  const startFromMessage = (message: Message<true>, opener: GuildMember) =>
    bridge.start({
      kind: 'message',
      opener: person(opener),
      channelId: config.taskChannelId ?? message.channelId,
      message: {
        id: message.id,
        authorName: message.member?.displayName ?? message.author.username,
        authorId: message.author.id,
        link: message.url,
        content: message.content,
        attachments: attachments(message.attachments)
      }
    });

  client.once(Events.ClientReady, async (ready) => {
    console.log(`Logged in as ${ready.user.tag}; agent: ${bridge.agentName}.`);
    const definitions = commandDefinitions(bridge.agentName);
    if (config.guildId) {
      await ready.application.commands.set(definitions, config.guildId);
    } else {
      await ready.application.commands.set(definitions);
    }
    console.log(`Registered commands ${config.guildId ? `in guild ${config.guildId}` : 'globally'}.`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.inCachedGuild()) return;
    if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;
    if (!isAllowed(interaction.member, config)) {
      await interaction.reply({ content: 'Only admins can use this.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const content = interaction.isMessageContextMenuCommand()
        ? await handleContextMenu(interaction)
        : await handleSlash(interaction);
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      console.error('Command failed:', error);
      await interaction.editReply(`Failed: ${errorText(error)}`).catch(() => {});
    }
  });

  async function handleContextMenu(interaction: MessageContextMenuCommandInteraction<'cached'>) {
    const result = await startFromMessage(interaction.targetMessage, interaction.member);
    return startedReply(result, bridge.agentName);
  }

  async function handleSlash(interaction: ChatInputCommandInteraction<'cached'>) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') {
      const file = interaction.options.getAttachment('file');
      const result = await bridge.start({
        kind: 'prompt',
        opener: person(interaction.member),
        channelId: config.taskChannelId ?? interaction.channelId,
        task: interaction.options.getString('task', true),
        attachments: file ? attachments([file]) : []
      });
      return startedReply(result, bridge.agentName);
    }
    if (sub === 'status') {
      const row = bridge.task(interaction.channelId);
      if (!row) return 'Run this inside a task thread.';
      const update = await bridge.sync(row);
      const prs = (update?.pullRequests ?? row.pullRequests).join('\n') || 'none yet';
      return `**${row.title}**\nStatus: ${update?.stateLabel ?? row.stateLabel ?? 'unknown'}\nTask: ${row.url}\nPull requests:\n${prs}`;
    }
    const rows = bridge.recent(10);
    if (!rows.length) return 'No tasks yet.';
    return rows
      .map((row) => {
        const prs = row.pullRequests.length ? ` · ${row.pullRequests.join(' ')}` : '';
        return `<#${row.threadId}> · ${row.stateLabel ?? 'starting'}${prs}`;
      })
      .join('\n')
      .slice(0, 2000);
  }

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (!config.triggerEmoji || user.bot) return;
    try {
      const emoji = reaction.emoji;
      if (emoji.name !== config.triggerEmoji && emoji.id !== config.triggerEmoji) return;
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      if (!message.inGuild() || bridge.isTaskThread(message.channelId)) return;
      const member = await message.guild.members.fetch(user.id);
      if (!isAllowed(member, config)) return;
      const result = await startFromMessage(message, member);
      if (result.started) await message.react('✅').catch(() => {});
    } catch (error) {
      console.error('Starting a task from a reaction failed:', error);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.inGuild() || !message.channel.isThread()) return;
    if (!bridge.isTaskThread(message.channelId)) return;
    if (config.ignorePrefix && message.content.startsWith(config.ignorePrefix)) return;
    if (!message.content.trim() && message.attachments.size === 0) return;
    try {
      const member = message.member ?? (await message.guild.members.fetch(message.author.id));
      if (!isAllowed(member, config)) return;
      await bridge.forward(
        message.channelId,
        person(member),
        message.content,
        attachments(message.attachments)
      );
      await message.react('📨').catch(() => {});
    } catch (error) {
      console.error('Forwarding a thread message failed:', error);
      await message.reply(`Could not forward this: ${errorText(error)}`).catch(() => {});
    }
  });
}
