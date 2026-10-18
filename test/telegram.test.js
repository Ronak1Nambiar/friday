import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { botName, createTelegram, findChat } from '../src/telegram.js';

// A stand-in Bot API: records calls, serves queued updates to getUpdates.
async function fakeApi() {
  const calls = [];
  const queue = [];
  let id = 100;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const b = body ? JSON.parse(body) : {};
      calls.push({ method, body: b, token: req.url.split('/')[1] });
      const reply = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
      if (method === 'getMe') return reply({ username: 'friday_test_bot' });
      if (method === 'sendMessage') return reply({ message_id: 7, date: 1000, chat: { id: b.chat_id } });
      if (method === 'getUpdates') {
        if (b.offset === -1) return reply(queue.length ? [queue[queue.length - 1]] : []);
        const ready = queue.filter((u) => b.offset == null || u.update_id >= b.offset);
        if (ready.length || !b.timeout) return reply(ready);
        setTimeout(() => reply(queue.filter((u) => u.update_id >= b.offset)), 60);
        return;
      }
      reply(true);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    calls,
    push: (u) => queue.push({ update_id: id++, ...u }),
    close: () => server.close(),
  };
}

test('a question goes out with its options as buttons; a tap from the user answers it', async () => {
  const api = await fakeApi();
  try {
    api.push({ message: { chat: { id: 42 }, date: 1, text: 'old message' } });
    const tg = createTelegram({ token: 'T', chatId: 42, base: api.base, pollTimeout: 1, retryMs: 10 });
    const p = tg.ask('Run this research? go / cancel / or say what to change', { summary: 'MyApp: 3 research jobs' });
    await new Promise((r) => setTimeout(r, 100));
    const sent = api.calls.find((c) => c.method === 'sendMessage');
    assert.equal(sent.body.chat_id, 42);
    assert.match(sent.body.text, /MyApp: 3 research jobs[\s\S]*Run this research\?[\s\S]*or reply with: say what to change/);
    const buttons = sent.body.reply_markup.inline_keyboard[0];
    assert.deepEqual(buttons.map((b) => b.text), ['go', 'cancel']);
    // A tap from someone else's chat and a stale button are ignored.
    api.push({ callback_query: { id: 'x', data: buttons[0].callback_data, message: { chat: { id: 666 } } } });
    api.push({ callback_query: { id: 'y', data: 'qold:go', message: { chat: { id: 42 } } } });
    api.push({ callback_query: { id: 'z', data: buttons[0].callback_data, message: { chat: { id: 42 } } } });
    assert.equal(await p, 'go');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(api.calls.some((c) => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'z'));
    assert.equal(api.calls.filter((c) => c.method === 'getUpdates')[0].body.offset, -1, 'old updates are skipped first');
  } finally { api.close(); }
});

test('a typed reply is the answer (feedback); one sent before the question is not', async () => {
  const api = await fakeApi();
  try {
    const tg = createTelegram({ token: 'T', chatId: 42, base: api.base, pollTimeout: 1, retryMs: 10 });
    const p = tg.ask('Build it? go / cancel / folder <path> / or say what to change');
    await new Promise((r) => setTimeout(r, 100));
    api.push({ message: { chat: { id: 42 }, date: 999, text: 'typed too early' } });
    api.push({ message: { chat: { id: 42 }, date: 1001, text: 'add a pricing page' } });
    assert.equal(await p, 'add a pricing page');
  } finally { api.close(); }
});

test('the guard replaces sealed text before anything leaves; an abort stops the wait', async () => {
  const api = await fakeApi();
  try {
    const guard = (t) => (/sealedproj/i.test(t) ? 'A FRIDAY mission needs you in the terminal.' : t);
    const tg = createTelegram({ token: 'T', chatId: 42, base: api.base, pollTimeout: 1, retryMs: 10, guard });
    const ac = new AbortController();
    const p = tg.ask('Run this research? go / cancel', { summary: 'SEALEDPROJ cohort plan', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 100));
    const text = api.calls.find((c) => c.method === 'sendMessage').body.text;
    assert.doesNotMatch(text, /sealedproj/i);
    assert.match(text, /needs you in the terminal/);
    ac.abort();
    assert.equal(await p, null);
  } finally { api.close(); }
});

test('setup helpers: the bot name checks the token; the chat comes from the user\'s /start', async () => {
  const api = await fakeApi();
  try {
    assert.equal(await botName({ token: 'T', base: api.base }), 'friday_test_bot');
    assert.equal(await findChat({ token: 'T', base: api.base }), null);
    api.push({ message: { chat: { id: 42, type: 'private', first_name: 'Test' }, date: 5, text: '/start' } });
    assert.deepEqual(await findChat({ token: 'T', base: api.base }), { chatId: 42, name: 'Test' });
  } finally { api.close(); }
});

test('setup: token checked, chat found from /start, token saved to keys.json, test message sent', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { telegramSetup } = await import('../src/setup.js');
  const api = await fakeApi();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-tg-'));
    const said = [];
    const answers = ['123:ABC', ''];
    api.push({ message: { chat: { id: 42, type: 'private', first_name: 'R' }, date: 5, text: '/start' } });
    const tg = await telegramSetup({ configDir: dir, ask: async () => answers.shift(), say: (x) => said.push(x), api: { base: api.base } });
    assert.deepEqual(tg, { chatId: 42, enabled: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')).telegram, '123:ABC');
    assert.ok(api.calls.some((c) => c.method === 'sendMessage' && c.body.chat_id === 42));
    assert.match(said.join('\n'), /t\.me\/friday_test_bot/);
  } finally { api.close(); }
});
