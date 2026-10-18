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
// The author, from the LICENSE ("Copyright (c) <year> <First> <Last>"), and the repo
// owner's handle, from package.json: neither may reach a prompt.
const AUTHOR = /Copyright \(c\) \d{4} (\S+)/.exec(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'))[1];
const OWNER = /github\.com\/([^/]+)\//.exec(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).repository.url)[1];

test("no prompt names the author: their name appears only in comments and the repo's URL", () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'src')).map((f) => path.join(ROOT, 'src', f)),
    ...fs.readdirSync(path.join(ROOT, 'context')).map((f) => path.join(ROOT, 'context', f)),
    path.join(ROOT, 'bin', 'friday.js'),
  ];
  const hits = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/^\s*\/\/.*$/, '').replaceAll(OWNER, '');
      if (code.includes(AUTHOR)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
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
    assert.doesNotMatch(proto, /\{\{/);
    assert.ok(!proto.includes(AUTHOR));
  } finally { setUserName(''); }
});
