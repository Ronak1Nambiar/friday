import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooserLines, createAsker, parseChoices } from '../src/asker.js';

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('a choice is drawn like Claude Code: question, numbered options, Other, keys', () => {
  const ls = chooserLines({ title: 'Claude asks', question: 'Which color?', options: [{ label: 'red', description: 'warm' }, { label: 'blue' }], other: 'Other (type your answer)', sel: 1 }).map(plain);
  assert.equal(ls[0], '● Claude asks');
  assert.equal(ls[1], '  Which color?');
  assert.equal(ls[3], '  1. red  warm');
  assert.equal(ls[4], '❯ 2. blue');
  assert.equal(ls[5], '  3. Other (type your answer)');
  assert.match(ls[6], /↑↓ move · enter select · 1-3 · esc decline/);
  const multi = chooserLines({ question: 'q', options: [{ label: 'a' }, { label: 'b' }], multi: true, picked: new Set([1]) }).map(plain);
  assert.deepEqual(multi.slice(2, 4), ['❯ 1. [ ] a', '  2. [x] b']);
});

test('mission checkpoints become choices; free-form parts become Other', () => {
  assert.deepEqual(parseChoices('Build it? go / cancel / folder <path> / or say what to change'),
    { question: 'Build it?', options: [{ label: 'go' }, { label: 'cancel' }], other: 'folder <path> / say what to change' });
  assert.deepEqual(parseChoices('codex is at 90% of its 5-hour limit. go / use <agent> / pause'),
    { question: 'codex is at 90% of its 5-hour limit.', options: [{ label: 'go' }, { label: 'pause' }], other: 'use <agent>' });
  assert.equal(parseChoices('a folder path, or Enter for ~/x'), null);
});

test('keys: arrows and Enter, a number, Other typed, Esc declines, space for multi', async () => {
  const out = [];
  const a = createAsker({ write: (s) => out.push(s), width: () => 80 });
  const spec = { question: 'Which?', options: [{ label: 'red' }, { label: 'blue' }], other: 'Other' };
  let p = a.choose(spec);
  a.key(undefined, { name: 'down' }); a.key('\r', { name: 'return' });
  assert.deepEqual(await p, { index: 1, label: 'blue', labels: ['blue'], text: null });
  assert.equal(a.open, false);
  assert.match(plain(out.at(-1)), /Which\?\n {2}⎿ blue/, 'the answer stays in the transcript');
  p = a.choose(spec); a.key('1', { name: '1' });
  assert.equal((await p).label, 'red');
  p = a.choose(spec); a.key('3', { name: '3' });
  for (const ch of 'green') a.key(ch, { name: ch });
  a.key('\r', { name: 'return' });
  assert.deepEqual(await p, { index: 2, label: null, labels: [], text: 'green' });
  p = a.choose(spec); a.key('\x1b', { name: 'escape' });
  assert.equal(await p, null);
  p = a.choose({ ...spec, multi: true }); a.key(' ', { name: 'space' }); a.key(undefined, { name: 'down' }); a.key(' ', { name: 'space' }); a.key('\r', { name: 'return' });
  assert.deepEqual((await p).labels, ['red', 'blue']);
});
