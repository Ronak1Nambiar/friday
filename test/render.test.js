import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStream } from '../src/render.js';

// Tests run without a TTY, so styles are empty strings and only layout shows.
function render(chunks) {
  const s = createStream('> ');
  return chunks.map((c) => s.write(c)).join('') + s.flush();
}

test('adds a gutter to every line, across chunk boundaries', () => {
  assert.equal(render(['hel', 'lo\nwor', 'ld']), '> hello\n> world\n');
});

test('bold markers split across chunks are consumed', () => {
  assert.equal(render(['a *', '*b*', '* c']), '> a b c\n');
});

test('single star and inline code survive', () => {
  assert.equal(render(['2 * 3 = `x`\n']), '> 2 * 3 = x\n');
});

test('fences render as a dim marker and keep their body', () => {
  assert.equal(render(['```js\nconst a = 1;\n``', '`\nafter']), '> ```js\n> const a = 1;\n> ```\n> after\n');
});

test('flush closes a trailing partial line once', () => {
  const s = createStream('');
  assert.equal(s.write('x') + s.flush() + s.flush(), 'x\n');
});

test('wraps at word boundaries with the gutter, and list items hang under their text', () => {
  const s = createStream('  ', { width: 30, first: '* ' });
  const txt = 'one two three four five six seven eight\n1. alpha beta gamma delta epsilon zeta\n';
  let o = '';
  for (let i = 0; i < txt.length; i += 4) o += s.write(txt.slice(i, i + 4));
  o += s.flush();
  assert.deepEqual(o.split('\n'), [
    '* one two three four five six',
    '  seven eight',
    '  1. alpha beta gamma delta',
    '     epsilon zeta',
    '',
  ]);
});

test('wrapText indents every line of a long status line', async () => {
  const { wrapText } = await import('../src/render.js');
  assert.deepEqual(wrapText('6.9s · 1 tool · plan 67% of 5h · routed by x in 1.5s', { width: 24 }), ['  6.9s · 1 tool · plan', '  67% of 5h · routed by', '  x in 1.5s']);
});
