import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ABILITIES, abilityLines, unavailable } from '../src/abilities.js';

const all = { agents: 2, ollama: true, vault: true };
const byName = (n) => ABILITIES.find((a) => a.name === n);

test('every ability is listed with an example when everything is ready', () => {
  const lines = abilityLines(all, { width: 200 });
  assert.equal(lines.length, ABILITIES.length);
  for (const [i, a] of ABILITIES.entries()) assert.ok(lines[i].includes(a.name) && lines[i].includes(a.try), a.name);
  assert.ok(lines.some((l) => l.includes('/mission')), 'missions are named');
});

test('what cannot run now says why', () => {
  assert.equal(unavailable(byName('Missions'), { ...all, ollama: false }), 'friday login, or start Ollama');
  assert.equal(unavailable(byName('Missions'), { ...all, ollama: false, brain: true }), null, 'a cloud brain plans missions without Ollama');
  assert.equal(unavailable(byName('Council'), { ...all, agents: 1 }), 'needs 2 AIs ready');
  assert.equal(unavailable(byName('Just ask'), { ...all, agents: 0 }), 'no AI ready');
  assert.equal(unavailable(byName('Second brain'), { ...all, vault: false }), 'no vault configured');
  assert.equal(unavailable(byName('Projects'), {}), null);
  const line = abilityLines({ ...all, ollama: false }, { width: 200 }).find((l) => l.includes('Missions'));
  assert.match(line, /\(friday login, or start Ollama\)$/);
});

test('lines fit narrow terminals', () => {
  for (const w of [60, 80]) {
    for (const l of abilityLines({ ...all, ollama: false }, { width: w })) assert.ok(l.length <= w, `${l.length} > ${w}: ${l}`);
  }
});
