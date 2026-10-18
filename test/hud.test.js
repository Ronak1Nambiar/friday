import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createHud } from '../src/hud-server.js';

test('serves the page and state, streams patches, and accepts same-origin commands', async () => {
  const commands = [];
  const hud = createHud({ port: 0, onCommand: (c) => commands.push(c) });
  await hud.listen();
  try {
    const page = await fetch(hud.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /F\.R\.I\.D\.A\.Y\./);

    hud.set({ mode: 'plan' });
    assert.equal((await (await fetch(hud.url + 'api/state')).json()).mode, 'plan');

    const events = await new Promise((resolve) => {
      http.get(hud.url + 'events', (res) => {
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          if (buf.includes('event: state') && !buf.includes('event: feed')) hud.feed({ kind: 'agent', agent: 'codex', text: 'hi' });
          if (buf.includes('event: feed')) { res.destroy(); resolve(buf); }
        });
      });
    });
    assert.match(events, /"text":"hi"/);

    const ok = await fetch(hud.url + 'api/command', { method: 'POST', body: JSON.stringify({ command: '/hud' }) });
    assert.equal(ok.status, 204);
    const bad = await fetch(hud.url + 'api/command', { method: 'POST', headers: { origin: 'http://evil.test' }, body: '{"command":"/mode yolo"}' });
    assert.equal(bad.status, 403);
    assert.deepEqual(commands, ['/hud']);

    assert.equal((await fetch(hud.url + '../package.json')).status, 404);
  } finally {
    hud.close();
  }
});
