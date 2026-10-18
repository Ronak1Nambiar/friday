import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createHud } from '../src/hud-server.js';
import { DEFAULT_THEME, createThemeStore, findImagePath, isThemeRequest, normalizeTheme, parseThemeReply, themeProblems, themePrompt, toRgb } from '../src/hudtheme.js';
import { Screen, applyTheme } from '../src/term-hud.js';

test('themes: any input becomes a complete, safe theme', () => {
  assert.deepEqual(toRgb('#ff8000'), [255, 128, 0]);
  assert.deepEqual(toRgb('0af'), [0, 170, 255]);
  assert.deepEqual(toRgb('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.deepEqual(toRgb([300, -4, 7.6]), [255, 0, 8]);
  assert.equal(toRgb('purple'), null);
  const t = normalizeTheme({ name: 'Mars', colors: { accent: '#ff5533', text: 'nope', bg: '#110000' }, panels: { commits: false, bogus: true },
    map: { sweep: false }, background: { image: '../../etc/passwd', opacity: 9 }, extra: 1 });
  assert.equal(t.name, 'Mars');
  assert.deepEqual(t.colors.accent, [255, 85, 51]);
  assert.deepEqual(t.colors.text, DEFAULT_THEME.colors.text, 'a bad color falls back');
  assert.deepEqual(t.colors.bg, [17, 0, 0]);
  assert.equal(t.panels.commits, false);
  assert.equal('bogus' in t.panels, false);
  assert.deepEqual(t.map, { rings: true, sweep: false });
  assert.deepEqual(t.background, { image: null, opacity: 1 }, 'never a path, opacity clamped');
  assert.equal('extra' in t, false);
  assert.equal(normalizeTheme({ background: { image: 'theme-1.png' } }).background.image, 'theme-1.png');
});

test('unreadable themes are caught', () => {
  assert.deepEqual(themeProblems(normalizeTheme()), []);
  const bad = normalizeTheme({ colors: { text: '#101010', accent: '#050505', bg: '#000000' } });
  assert.equal(themeProblems(bad).length, 2);
});

test('Claude\'s reply: the JSON block and its one-line note', () => {
  const r = parseThemeReply('```json\n{"name":"Ember","colors":{"accent":"#ff7a00"}}\n```\nWarm orange accents from the photo.');
  assert.equal(r.theme.name, 'Ember');
  assert.deepEqual(r.theme.colors.accent, [255, 122, 0]);
  assert.equal(r.note, 'Warm orange accents from the photo.');
  assert.match(parseThemeReply('no json here').error, /no theme/);
  assert.match(parseThemeReply('```json\n{oops}\n```').error, /bad theme JSON/);
  const p = themePrompt({ image: 'C:\\x\\theme-1.png', request: 'darker', current: normalizeTheme() });
  assert.match(p, /Read the image at C:\\x\\theme-1\.png/);
  assert.match(p, /theme-1\.png" to show the image/);
  assert.match(p, /in their words: darker/);
});

test('which messages ask for a new look', () => {
  assert.equal(findImagePath('make the HUD look like C:\\Users\\me\\Pictures\\iron man.png please'), 'C:\\Users\\me\\Pictures\\iron man.png');
  assert.equal(findImagePath('use "C:\\a b\\c.JPG"'), 'C:\\a b\\c.JPG');
  assert.equal(findImagePath('~/pics/x.webp'), '~/pics/x.webp');
  assert.equal(findImagePath('no image here.txt'), null);
  for (const t of ['make the HUD look like ~/pics/x.png', 'give the hud purple accents', 'change the HUD colors to match my desk', 'restyle the hud, darker']) assert.equal(isThemeRequest(t), true, t);
  for (const t of ['why is the HUD broken on windows', 'fix the hud flicker', 'open the hud', 'make the readme look nicer']) assert.equal(isThemeRequest(t), false, t);
});

test('theme store: save keeps the last one for undo; reset; images get safe names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-theme-'));
  const s = createThemeStore(dir);
  assert.equal(s.get().name, 'FRIDAY');
  s.save({ name: 'Zero', colors: { accent: [1, 2, 3] } });
  assert.equal(s.undo().name, 'FRIDAY', 'the first theme can be undone back to the built-in one');
  assert.match(fs.readFileSync(s.file, 'utf8'), /"accent": "#5fe1ff"/, 'colors are hex on disk');
  s.save({ name: 'One' });
  s.save({ name: 'Two' });
  assert.equal(s.get().name, 'Two');
  assert.equal(s.undo().name, 'One');
  assert.equal(s.get().name, 'One');
  assert.equal(s.undo().name, 'Two', 'undo twice swaps back');
  assert.equal(s.reset().name, 'FRIDAY');
  const img = path.join(dir, 'My Photo.PNG');
  fs.writeFileSync(img, 'x');
  const name = s.addImage(img);
  assert.match(name, /^theme-\d+\.png$/);
  assert.ok(fs.existsSync(path.join(s.assets, name)));
  assert.throws(() => s.addImage(path.join(dir, 'a.txt')), /png/);
});

test('terminal HUD repaints with the theme: colors and background', () => {
  applyTheme({ colors: { text: '#102030', bg: '#010203' } });
  const scr = new Screen(4, 1);
  scr.put(0, 0, 'ab');
  assert.match(scr.row(0), /48;2;1;2;3;38;2;16;32;48m/);
  assert.equal(scr.row(0, 3).replace(/\x1b\[[0-9;]*m/g, ''), 'ab ', 'a row can stop short of the last column');
  applyTheme(null);
  assert.doesNotMatch(new Screen(2, 1).row(0), /48;2/, 'the default theme leaves the terminal background alone');
});

test('HUD server: theme in state, images served by name only, uploads handed over', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-assets-'));
  fs.writeFileSync(path.join(dir, 'theme-1.png'), 'PNG');
  const got = [];
  const hud = createHud({ port: 0, assets: dir, theme: normalizeTheme({ name: 'X' }), onTheme: (t) => got.push(t) });
  await hud.listen();
  const req = (p, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: hud.port, path: p, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, type: res.headers['content-type'] }));
    });
    r.end(body);
  });
  try {
    assert.equal(JSON.parse((await req('/api/state')).body).theme.name, 'X');
    const img = await req('/theme-asset/theme-1.png');
    assert.deepEqual([img.status, img.type, img.body], [200, 'image/png', 'PNG']);
    assert.equal((await req('/theme-asset/..%2Fsecret.png')).status, 404);
    const png = 'data:image/png;base64,' + Buffer.from('fake').toString('base64');
    const up = await req('/api/theme', { method: 'POST', body: JSON.stringify({ image: png, request: 'darker' }), headers: { 'content-type': 'application/json' } });
    assert.equal(up.status, 202);
    assert.deepEqual([got[0].data.toString(), got[0].ext, got[0].request], ['fake', 'png', 'darker']);
    const words = await req('/api/theme', { method: 'POST', body: JSON.stringify({ request: 'purple' }) });
    assert.equal(words.status, 202);
    assert.equal(got[1].data, null);
    assert.equal((await req('/api/theme', { method: 'POST', body: JSON.stringify({ image: 'data:text/html;base64,AAAA' }) })).status, 400);
    assert.equal((await req('/api/theme', { method: 'POST', body: '{}', headers: { origin: 'http://evil.example' } })).status, 403);
  } finally { hud.close(); }
});
