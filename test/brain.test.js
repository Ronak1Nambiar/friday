import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CLOUD_MODEL, brainStatus, chat, fromOpenAiMessage, loadKey, resolveBrain, saveKey, signInOpenRouter, toOpenAiMessages } from '../src/brain.js';
import { orchestrate } from '../src/orchestrator.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'friday-brain-'));
const noEnv = {};

test('auto picks the cloud once signed in, local before; the environment key wins', () => {
  const dir = tmp();
  assert.equal(resolveBrain({}, dir, noEnv).provider, 'ollama');
  saveKey(dir, 'openrouter', 'sk-or-file1234');
  const b = resolveBrain({}, dir, noEnv);
  assert.deepEqual([b.provider, b.model, b.key, b.cloud], ['openrouter', DEFAULT_CLOUD_MODEL, 'sk-or-file1234', true]);
  assert.equal(loadKey(dir, 'openrouter', { OPENROUTER_API_KEY: 'sk-env' }), 'sk-env');
  assert.equal(resolveBrain({ brain: { provider: 'ollama', localModel: 'llama3' } }, dir, noEnv).model, 'llama3');
  assert.equal(resolveBrain({ brain: { model: 'openai/gpt-6-luna' } }, dir, noEnv).model, 'openai/gpt-6-luna');
  saveKey(dir, 'openrouter', '');
  assert.equal(loadKey(dir, 'openrouter', noEnv), '');
});

test('Ollama-shaped tool turns translate to OpenAI shape and back', () => {
  const msgs = toOpenAiMessages([
    { role: 'system', content: 's' },
    { role: 'user', content: 'fix it and have codex check' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'ask_claude', arguments: { task: 'fix' } } }] },
    { role: 'tool', tool_name: 'ask_claude', content: 'done' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'ask_codex', arguments: { task: 'review' } } }] },
    { role: 'tool', tool_name: 'ask_codex', content: 'pass' },
  ]);
  const calls = msgs.filter((m) => m.tool_calls).map((m) => m.tool_calls[0]);
  assert.equal(calls[0].function.arguments, '{"task":"fix"}');
  const results = msgs.filter((m) => m.role === 'tool');
  assert.deepEqual(results.map((r) => r.tool_call_id), calls.map((c) => c.id));
  const back = fromOpenAiMessage({ content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'ask_codex', arguments: '{"task":"t"}' } }] });
  assert.deepEqual(back.tool_calls[0].function, { name: 'ask_codex', arguments: { task: 't' } });
  assert.equal(back.content, '');
});

function fakeOpenRouter(replies, seen = []) {
  return async (url, init) => {
    seen.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = replies.shift();
    if (typeof r === 'number') return new Response('{"error":{"message":"nope"}}', { status: r });
    return new Response(JSON.stringify({ choices: [{ message: r }], usage: { total_tokens: 10 } }), { status: 200 });
  };
}

test('a cloud call sends the key and model, and maps errors to a fix', async () => {
  const seen = [];
  const brain = { provider: 'openrouter', model: 'm/x', key: 'sk-1', cloud: true };
  const r = await chat(brain, { messages: [{ role: 'user', content: 'hi' }], fetchImpl: fakeOpenRouter([{ content: 'hello' }], seen) });
  assert.equal(r.ok, true);
  assert.equal(r.message.content, 'hello');
  assert.match(seen[0].url, /openrouter\.ai\/api\/v1\/chat\/completions$/);
  assert.equal(seen[0].init.headers.Authorization, 'Bearer sk-1');
  assert.equal(seen[0].body.model, 'm/x');
  for (const [code, re] of [[401, /rejected the key/], [402, /out of credit/], [429, /rate limit/]]) {
    const e = await chat(brain, { messages: [], fetchImpl: fakeOpenRouter([code]) });
    assert.equal(e.ok, false);
    assert.match(e.reason, re);
  }
  const none = await chat({ ...brain, key: '' }, { messages: [] });
  assert.match(none.reason, /friday login/);
});

test('structured output falls back to plain JSON when the model rejects a schema', async () => {
  const seen = [];
  const brain = { provider: 'openrouter', model: 'm/x', key: 'k', cloud: true };
  const r = await chat(brain, { messages: [{ role: 'user', content: 'plan' }], format: { type: 'object' }, fetchImpl: fakeOpenRouter([400, { content: '{"a":1}' }], seen) });
  assert.equal(r.message.content, '{"a":1}');
  assert.equal(seen[0].body.response_format.type, 'json_schema');
  assert.equal(seen[1].body.response_format.type, 'json_object');
});

test('the orchestrator runs on a cloud brain: delegates, then stops', async () => {
  const seen = [];
  const fetchImpl = fakeOpenRouter([
    { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ask_claude', arguments: '{"task":"explain render.js"}' } }] },
  ], seen);
  const ran = [];
  const profile = { orchestrator: { model: 'unused', maxSteps: 4 }, agents: { claude: { strengths: ['code'] } } };
  const r = await orchestrate('what does render.js do', {
    agents: ['claude'], profile, brain: { provider: 'openrouter', model: 'm/x', key: 'k', cloud: true },
    context: { cwd: '~', mode: 'edit' }, fetchImpl,
    callAgent: async (agent, prompt) => { ran.push([agent, prompt]); return { ok: true, text: 'It renders.' }; },
  });
  assert.equal(r.handled, true);
  assert.deepEqual(r.calls.map((c) => c.agent), ['claude']);
  assert.match(ran[0][1], /explain render\.js/);
  assert.equal(seen.length, 1, 'no extra brain call after a good answer');
  assert.equal(seen[0].body.tools[0].type, 'function');
});

test('cloud status: signed in with credit left, or a rejected key', async () => {
  const ok = await brainStatus({ provider: 'openrouter', key: 'k' }, { fetchImpl: async () => new Response(JSON.stringify({ data: { limit: 10, usage: 2.5 } })) });
  assert.deepEqual([ok.ready, ok.reason], [true, 'signed in · $7.50 left']);
  const bad = await brainStatus({ provider: 'openrouter', key: 'k' }, { fetchImpl: async () => new Response('', { status: 401 }) });
  assert.equal(bad.ready, false);
  assert.equal((await brainStatus({ provider: 'openrouter', key: '' })).ready, false);
});

test('OpenRouter sign-in: the browser hits the loopback callback, the code becomes a key', async () => {
  let exchanged = null;
  const fetchImpl = async (url, init) => { exchanged = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ key: 'sk-or-new' })); };
  const key = await signInOpenRouter({
    fetchImpl,
    open: async (link) => {
      const u = new URL(link);
      assert.equal(u.origin + u.pathname, 'https://openrouter.ai/auth');
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      const cb = new URL(u.searchParams.get('callback_url'));
      // A stray request to another path does nothing.
      assert.equal((await fetch(`http://127.0.0.1:${cb.port}/callback/wrong?code=evil`)).status, 404);
      await fetch(`http://127.0.0.1:${cb.port}${cb.pathname}?code=abc`);
    },
  });
  assert.equal(key, 'sk-or-new');
  assert.equal(exchanged.url, 'https://openrouter.ai/api/v1/auth/keys');
  assert.equal(exchanged.body.code, 'abc');
  assert.ok(exchanged.body.code_verifier.length > 40);
});

test('a CLI brain: the conversation becomes one prompt, the JSON reply becomes a tool call', async () => {
  const { chat, cliPrompt, fromCliText, extractJson } = await import('../src/brain.js');
  const tools = [{ type: 'function', function: { name: 'ask_codex', description: 'codex: tests', parameters: { properties: { task: {} } } } }];
  const prompt = cliPrompt([{ role: 'system', content: 'You are FRIDAY.' }, { role: 'user', content: 'run the tests' }], tools);
  assert.match(prompt, /\[Instructions\]\nYou are FRIDAY\./);
  assert.match(prompt, /- ask_codex\(task\): codex: tests/);
  assert.match(prompt, /Reply with ONLY one JSON object/);
  assert.deepEqual(extractJson('Sure! ```json\n{"tool":"ask_codex","args":{"task":"run them"}}\n```'), { tool: 'ask_codex', args: { task: 'run them' } });
  const call = fromCliText('{"tool":"ask_codex","args":{"task":"run them"}}', { tools });
  assert.deepEqual(call.tool_calls[0].function, { name: 'ask_codex', arguments: { task: 'run them' } });
  assert.equal(fromCliText('{"answer":"hi there"}', { tools }).content, 'hi there');
  assert.equal(fromCliText('plain words', {}).content, 'plain words');
  const seen = [];
  const r = await chat({ provider: 'claude', model: 'haiku', cloud: true, cli: true }, {
    messages: [{ role: 'user', content: 'thanks' }], tools,
    cliRun: async (p, text, o) => { seen.push([p, o.model, o.timeoutMs]); return { ok: true, text: '{"answer":"any time"}' }; },
  });
  assert.equal(r.message.content, 'any time');
  assert.deepEqual(seen, [['claude', 'haiku', 60000]]);
  const down = await chat({ provider: 'codex', model: 'gpt-6-luna' }, { messages: [], cliRun: async () => ({ ok: false, error: 'not logged in' }) });
  assert.deepEqual([down.ok, down.reason], [false, 'not logged in']);
});

test('CLI brain status: not installed, not signed in, ready', async () => {
  const st = (s) => brainStatus({ provider: 'claude', model: 'haiku' }, { cli: () => s });
  assert.equal((await st({ installed: false })).fix, 'install');
  assert.equal((await st({ installed: true, signedIn: false })).fix, 'login');
  assert.equal((await st({ installed: true, signedIn: true })).ready, true);
  assert.deepEqual(resolveBrain({ brain: { provider: 'codex', models: { codex: 'gpt-6.1-sol' } } }, tmp(), noEnv).label, 'Codex gpt-6.1-sol');
});
