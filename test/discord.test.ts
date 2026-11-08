import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import { cardFiles, componentText } from '../src/discord.ts';

test('card files get URL-safe, unique names for attachment:// references', () => {
  const data = new Uint8Array();
  const names = cardFiles(['chart v2.png', 'chart v2.png', 'résumé (1).pdf', '..'].map((name) => ({ name, data }))).map((f) => f.name);
  assert.deepEqual(names, ['chart_v2.png', '2-chart_v2.png', 'r_sum_1_.pdf', 'file']);
});

test('component text covers card text and link buttons, so reads see card messages', () => {
  const card = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Fixed the redirect'));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open PR').setURL('https://github.com/a/b/pull/1'),
    new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Stop').setCustomId('stop')
  );
  assert.deepEqual(componentText([card, row]), ['Fixed the redirect', '[Open PR](https://github.com/a/b/pull/1)']);
});
