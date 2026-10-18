import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAsker } from '../src/asker.js';
import { saveKey } from '../src/brain.js';
import { brainMenu } from '../src/brainmenu.js';

// The real chooser, driven by keypresses: each step is the keys for one menu.
// cli: { claude: { installed, signedIn } ... } is what the CLI checks report, and changes
// when a login or install runs.
function harness({ key = '', brain = {}, steps = [], tags = null, models = [], cli = {}, installs = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-menu-'));
  if (key) saveKey(dir, 'openrouter', key);
  let prof = { brain, orchestrator: { model: 'qwen2.5:7b-instruct' } };
  let screen = '';
  const asker = createAsker({ write: (s) => { screen += s; }, width: () => 120 });
  const said = [];
  const menus = [];
  const ran = [];
  const state = { claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: true }, gemini: { installed: false, signedIn: false }, ...cli };
  const choose = (spec) => {
    menus.push(spec);
    const p = asker.choose(spec);
    for (const k of steps.shift() || []) typeof k === 'string' && k.length === 1 ? asker.key(k, { name: k }) : asker.key(k.s || '', k);
    return p;
  };
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/tags')) return tags ? new Response(JSON.stringify({ models: tags })) : new Response('', { status: 500 });
    if (url.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }));
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: models }));
    return new Response('{}');
  };
  const deps = {
    configDir: dir, profile: () => prof, saveProfile: (p) => { prof = p; }, choose, say: (l) => said.push(l), fetchImpl,
    login: async () => { saveKey(dir, 'openrouter', 'sk-or-new1'); return true; },
    runInteractive: async (bin, args) => {
      ran.push(`${bin} ${args.join(' ')}`);
      const id = bin === 'npm' ? installs[args.at(-1)] : bin;
      if (bin === 'npm' && id) state[id].installed = true;
      else if (state[bin]) state[bin].signedIn = true;
      return true;
    },
    state: (p) => ({ installed: p === 'ollama' || p === 'openrouter' ? true : state[p].installed }),
    cli: (id) => state[id],
  };
  return { deps, said, menus, ran, screen: () => screen, profile: () => prof };
}
const DOWN = { name: 'down' };
const RIGHT = { name: 'right' };
const ENTER = { name: 'return' };
const type = (t) => [...t].map((ch) => ({ s: ch, name: ch }));

test('one row per AI, in order, the current one marked; its models open under it', async () => {
  const h = harness({ key: 'k', steps: [[{ name: 'escape' }]] });
  assert.equal(await brainMenu(h.deps), null);
  const labels = h.menus[0].options.map((o) => o.label);
  assert.deepEqual(labels, ['Local (Ollama)', 'OpenRouter  ✓ now', 'Claude', 'Codex', 'Gemini']);
  assert.ok(!labels.some((l) => /sign/i.test(l)), 'no sign-in rows: picking an AI signs in when needed');
  assert.match(h.menus[0].question, /Now: OpenRouter anthropic\/claude-haiku-5\.5/);
  assert.match(h.screen(), /↑↓ move · → see models · enter select/, 'the keys are spelled out');
  assert.match(h.menus[0].options[4].description, /installs when picked/);
});

test('OpenRouter: the menu opens on the current AI; → into its models, ↓, Enter switches', async () => {
  const h = harness({ key: 'k', steps: [[RIGHT, DOWN, ENTER]] });
  const nb = await brainMenu(h.deps);
  assert.deepEqual([nb.provider, nb.model], ['openrouter', 'openai/gpt-6-luna']);
  assert.match(h.screen(), /├ ❯ openai\/gpt-6-luna/);
  assert.match(h.screen(), /enter use this one/);
});

test('OpenRouter while signed out: the browser sign-in runs, then it switches', async () => {
  const h = harness({ brain: { provider: 'ollama' }, steps: [[DOWN, ENTER]] });
  const nb = await brainMenu(h.deps);
  assert.deepEqual([nb.provider, nb.key], ['openrouter', 'sk-or-new1']);
  assert.match(h.said.join('\n'), /opening the sign-in page/);
});

test('Claude signed in: picks the model with no detour', async () => {
  const h = harness({ key: 'k', steps: [[DOWN, RIGHT, DOWN, ENTER]] });
  const nb = await brainMenu(h.deps);
  assert.deepEqual([nb.provider, nb.model, nb.cli], ['claude', 'sonnet', true]);
  assert.deepEqual(h.ran, []);
  assert.deepEqual(h.profile().brain.models, { claude: 'sonnet' });
});

test('Codex signed out: its login runs first, then it switches', async () => {
  const h = harness({ key: 'k', cli: { codex: { installed: true, signedIn: false } }, steps: [[DOWN, DOWN, ENTER]] });
  const nb = await brainMenu(h.deps);
  assert.deepEqual(h.ran, ['codex login']);
  assert.equal(nb.provider, 'codex');
});

test('Gemini not installed: asks, installs, signs in, switches; Cancel changes nothing', async () => {
  const h = harness({ key: 'k', installs: { '@google/gemini-cli': 'gemini' }, steps: [[DOWN, DOWN, DOWN, ENTER], [ENTER]] });
  const nb = await brainMenu(h.deps);
  assert.match(h.menus[1].question, /Gemini is not installed/);
  assert.deepEqual(h.ran, ['npm i -g @google/gemini-cli', 'gemini ']);
  assert.equal(nb.provider, 'gemini');
  const no = harness({ key: 'k', steps: [[DOWN, DOWN, DOWN, ENTER], [DOWN, ENTER]] });
  assert.equal(await brainMenu(no.deps), null);
  assert.deepEqual(no.ran, []);
  assert.equal(no.profile().brain.provider, undefined);
});

test('Local: lists downloaded models; a model not downloaded yet is pulled first', async () => {
  const tags = [{ name: 'qwen2.5:7b-instruct', size: 4.7e9 }, { name: 'nomic-embed-text:latest', size: 3e8 }];
  const h = harness({ key: 'k', tags, steps: [[{ name: 'up' }, RIGHT, DOWN, ENTER, ...type('llama3.1:8b'), ENTER]] });
  await brainMenu(h.deps);
  assert.match(h.screen(), /qwen2\.5:7b-instruct {2}4\.7 GB/);
  assert.doesNotMatch(h.screen(), /nomic-embed/, 'embedding models cannot chat');
  assert.deepEqual(h.ran, ['ollama pull llama3.1:8b']);
});

test('OpenRouter "Other model…": a model it does not have changes nothing', async () => {
  const h = harness({ key: 'k', steps: [[RIGHT, ...Array(5).fill(DOWN), ENTER, ...type('no/such'), ENTER]], models: [] });
  assert.equal(await brainMenu(h.deps), null);
  assert.match(h.said.join('\n'), /no model "no\/such"/);
});
