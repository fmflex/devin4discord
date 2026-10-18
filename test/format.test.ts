import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
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

const hostEnv = {
  DISCORD_TOKEN: 't',
  DISCORD_CLIENT_ID: '1',
  DISCORD_CLIENT_SECRET: 's',
  MASTER_KEY: 'k'.repeat(32),
  PUBLIC_URL: 'https://devin.example.com/'
};

test('config reads only host settings and validates PUBLIC_URL', () => {
  const config = loadConfig({ ...hostEnv, DATA_DIR: '/data' });
  assert.equal(config.publicUrl, 'https://devin.example.com');
  assert.equal(config.port, 3000);
  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.databasePath, '/data/tasks.db');
  assert.equal(loadConfig({ ...hostEnv, PUBLIC_URL: 'http://localhost:3000' }).publicUrl, 'http://localhost:3000');
  assert.throws(() => loadConfig({ ...hostEnv, PUBLIC_URL: 'http://devin.example.com' }), /must use https/);
  assert.throws(() => loadConfig({}), /DISCORD_TOKEN must be set/);
});
