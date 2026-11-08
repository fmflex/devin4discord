import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardFiles } from '../src/discord.ts';

test('card files get URL-safe, unique names for attachment:// references', () => {
  const data = new Uint8Array();
  const names = cardFiles(['chart v2.png', 'chart v2.png', 'résumé (1).pdf', '..'].map((name) => ({ name, data }))).map((f) => f.name);
  assert.deepEqual(names, ['chart_v2.png', '2-chart_v2.png', 'r_sum_1_.pdf', 'file']);
});
