import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxLines, createQueueBox, edit } from '../src/inputbox.js';

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('box: queued messages above, the input line inside, never wider than the terminal', () => {
  const ls = boxLines({ text: 'fix the typo', queued: ['first', 'second'], width: 40, hint: 'enter queue' }).map(plain);
  assert.equal(ls.length, 5);
  assert.match(ls[0], /◦ first/);
  assert.match(ls[2], /^╭─+╮$/);
  assert.match(ls[3], /^│ ❯ fix the typo\s+│$/);
  assert.match(ls[4], /enter queue/);
  for (const l of ls) assert.ok(l.length <= 39, `${l.length}: ${l}`);
  // Long input scrolls to keep the cursor in view; pasted newlines show as ⏎.
  const long = plain(boxLines({ text: 'a'.repeat(100) + 'END', width: 40 })[1]);
  assert.match(long, /END/);
  assert.match(plain(boxLines({ text: 'one\ntwo', width: 40 })[1]), /one⏎two/);
  // Many queued: the newest three, and a count.
  assert.match(plain(boxLines({ queued: ['a', 'b', 'c', 'd', 'e'], width: 40 })[0]), /2 more queued/);
});

test('editing keys', () => {
  let s = { text: '', cursor: 0 };
  for (const ch of 'helo') s = edit(s, ch, { name: ch });
  s = edit(s, undefined, { name: 'left' });
  s = edit(s, 'l', { name: 'l' });
  assert.deepEqual(s, { text: 'hello', cursor: 4 });
  assert.deepEqual(edit(s, undefined, { name: 'backspace' }), { text: 'helo', cursor: 3 });
  assert.deepEqual(edit({ text: 'run the tests', cursor: 13 }, undefined, { name: 'w', ctrl: true }), { text: 'run the ', cursor: 8 });
  assert.equal(edit(s, '\x1b', { name: 'escape' }), null);
});

test('queue box: Enter queues, a paste keeps its newlines, ↑ takes back, Esc interrupts', async () => {
  const written = [];
  const queue = [];
  let interrupted = 0;
  const box = createQueueBox({
    write: (s) => written.push(s), size: () => ({ rows: 30, cols: 60 }),
    queued: () => queue, submit: (t) => queue.push(t), takeLast: () => queue.pop() ?? null,
    interrupt: () => { interrupted++; }, sigint: () => {},
  });
  box.open();
  assert.match(written.join(''), /\x1b\[1;27r/, 'the scroll region stops above the 3-row box');
  const type = (s) => { for (const ch of s) box.key(ch, { name: ch }); };
  type('run tests');
  box.key('\r', { name: 'return' });
  await wait(40);
  assert.deepEqual(queue, ['run tests']);
  assert.equal(box.text, '');
  // A paste: Enter with more keys right behind it is a newline, not a send.
  type('line one');
  box.key('\r', { name: 'return' });
  type('line two');
  box.key('\r', { name: 'return' });
  await wait(40);
  assert.deepEqual(queue, ['run tests', 'line one\nline two']);
  box.key(undefined, { name: 'up' });
  assert.equal(box.text, 'line one\nline two');
  assert.deepEqual(queue, ['run tests']);
  box.key('\x1b', { name: 'escape' });
  assert.equal(box.text, '', 'Esc clears the text first');
  box.key('\x1b', { name: 'escape' });
  assert.equal(interrupted, 1, 'then interrupts');
  box.close();
  assert.match(written.at(-1), /\x1b\[r/, 'closing gives the whole screen back');
  assert.equal(box.isOpen, false);
});
