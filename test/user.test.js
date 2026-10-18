import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planMessages } from '../src/mission.js';
import { MISSION_TOOL } from '../src/orchestrator.js';
import { cap, setUserName, userName, userPossessive } from '../src/user.js';
import { renderProtocol } from '../src/vault.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('no prompt names the author: "Ronak" appears only in comments and the repo URL', () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'src')).map((f) => path.join(ROOT, 'src', f)),
    ...fs.readdirSync(path.join(ROOT, 'context')).map((f) => path.join(ROOT, 'context', f)),
    path.join(ROOT, 'bin', 'friday.js'),
  ];
  const hits = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/^\s*\/\/.*$/, '').replace(/Ronak1Nambiar/g, '');
      if (/Ronak/.test(code)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the name from the profile reaches the prompts; "the user" until it is set', () => {
  setUserName('');
  assert.equal(userName(), 'the user');
  assert.equal(cap(userPossessive()), "The user's");
  assert.match(planMessages('g', { agents: ['claude'] })[0].content, /You are FRIDAY, the user's lead agent/);
  setUserName('TestUser');
  try {
    assert.match(planMessages('g', { agents: ['claude'] })[0].content, /You are FRIDAY, TestUser's lead agent/);
    assert.match(JSON.stringify(MISSION_TOOL), /Use when TestUser wants something built/);
    assert.match(JSON.stringify(MISSION_TOOL), /TestUser's goal, in their words/);
    const proto = renderProtocol('/v');
    assert.match(proto, /FRIDAY runs for TestUser\. TestUser's second brain is an Obsidian vault at `\/v`/);
    assert.doesNotMatch(proto, /\{\{|Ronak/);
  } finally { setUserName(''); }
});
