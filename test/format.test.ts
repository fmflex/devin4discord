import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUserMap, loadConfig } from '../src/config.ts';
import { chunkMessage, shortTitle, stateAnnouncement } from '../src/format.ts';

test('chunkMessage splits on line boundaries within the limit', () => {
  const text = `${'a'.repeat(15)}\n${'b'.repeat(15)}`;
  assert.deepEqual(chunkMessage(text, 20), ['a'.repeat(15), 'b'.repeat(15)]);
  assert.deepEqual(chunkMessage('x'.repeat(25), 10), ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  assert.deepEqual(chunkMessage('  '), []);
});

test('shortTitle collapses whitespace and truncates', () => {
  assert.equal(shortTitle('a\n  b'), 'a b');
  assert.equal(shortTitle('abcdefghij', 5), 'abcd…');
});

test('stateAnnouncement only announces changes worth a ping', () => {
  assert.equal(stateAnnouncement('working', 'working', 'working', 'Devin'), null);
  assert.equal(stateAnnouncement(null, 'working', 'working', 'Devin'), null);
  assert.equal(stateAnnouncement('working', 'finished', 'finished', 'Devin'), 'Devin marked the task as finished.');
  assert.equal(stateAnnouncement('working', 'asleep', 'asleep (a reply wakes it)', 'Devin'), null);
  assert.equal(stateAnnouncement('working', 'asleep', 'suspended (out of credits)', 'Devin'), 'Task suspended (out of credits).');
});

test('config parses lists, the user map and defaults', () => {
  assert.deepEqual([...parseUserMap('1:a, 2:b,bad,3:')], [['1', 'a'], ['2', 'b']]);
  const config = loadConfig({ DISCORD_TOKEN: 't', ALLOWED_ROLE_IDS: '5, 6', DATA_DIR: '/data' });
  assert.deepEqual(config.allowedRoleIds, ['5', '6']);
  assert.equal(config.triggerEmoji, '🤖');
  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.databasePath, '/data/tasks.db');
  assert.equal(loadConfig({ DISCORD_TOKEN: 't', TRIGGER_EMOJI: '' }).triggerEmoji, null);
  assert.throws(() => loadConfig({}), /DISCORD_TOKEN must be set/);
});
