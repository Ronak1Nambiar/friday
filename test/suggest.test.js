import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandCatalog, createSuggester, matchCommands, suggestLines } from '../src/suggest.js';

const HELP = [
  ['/brain', 'a menu: the model behind FRIDAY'],
  ['/hud [web]', 'open the project HUD'],
  ['/hud on|off', 'open it by itself, or never'],
  ['/mission <goal>', 'lead a multi-step job'],
  ['/mode plan|edit|bypass', 'permission mode'],
  ['@agent message', 'route one message'],
];
const catalog = commandCatalog(HELP, ['/quit', { cmd: '/claude', desc: 'pin Claude Code' }]);
const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b[78]/g, '');

test('one entry per command, from the help table and extras', () => {
  assert.deepEqual(catalog.map((c) => c.cmd), ['/brain', '/hud', '/mission', '/mode', '/quit', '/claude']);
  assert.equal(catalog.find((c) => c.cmd === '/hud').args, '[web]', 'the first row for a command wins');
});

test('typing "/br" suggests /brain; "/" lists everything; a space or plain text lists nothing', () => {
  assert.deepEqual(matchCommands('/br', catalog).map((c) => c.cmd), ['/brain']);
  assert.equal(matchCommands('/', catalog).length, catalog.length);
  assert.deepEqual(matchCommands('/m', catalog).map((c) => c.cmd), ['/mission', '/mode']);
  assert.deepEqual(matchCommands('/ude', catalog).map((c) => c.cmd), ['/claude'], 'contains, after prefix matches');
  assert.deepEqual(matchCommands('/brain', catalog), [], 'complete: no list');
  assert.deepEqual(matchCommands('/brain cloud', catalog), []);
  assert.deepEqual(matchCommands('hello', catalog), []);
});

test('the highlighted suggestion is marked, descriptions fit the width', () => {
  const lines = suggestLines(matchCommands('/m', catalog), 1, 40).map(strip);
  assert.match(lines[0], /^ {4}\/mission <goal> +lead a/);
  assert.match(lines[1], /^ {2}❯ \/mode plan\|edit\|byp/);
  for (const l of lines) assert.ok(l.length <= 40, l);
});

test('drawn under the prompt and the cursor put back; Esc hides until the line changes', () => {
  let screen = '';
  const s = createSuggester({ write: (x) => { screen += x; }, catalog: () => catalog, width: () => 80 });
  s.update('/m', 9);
  assert.ok(s.visible);
  assert.match(screen, /\x1b\[2A\r\x1b\[9C$/, 'two lines down, then back up to column 9');
  assert.equal(s.selected.cmd, '/mission');
  s.move(1, 9);
  assert.equal(s.selected.cmd, '/mode');
  s.hide('/m');
  assert.equal(s.visible, false);
  s.update('/m', 9);
  assert.equal(s.visible, false, 'still hidden for the same line');
  s.update('/mo', 10);
  assert.equal(s.selected.cmd, '/mode');
  screen = '';
  s.clear();
  assert.equal(screen, '\x1b7\x1b[999C\x1b[J\x1b8');
});
