import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REMEMBER_TOOL, createMemory, summaryPrompt } from '../src/memory.js';
import { orchestrate, aboutMemory, systemPrompt } from '../src/orchestrator.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'friday-mem-'));
const conv = (id, updated, turns, extra = {}) => ({ id, updated, cwd: 'C:/x/friday', focus: 'friday', turns, ...extra });
const t = (prompt, text, extra = {}) => ({ agent: 'claude', prompt, text, ...extra });

test('facts: remember, no duplicates, forget by number or text; a plain file the user can edit', () => {
  const m = createMemory(tmp());
  assert.deepEqual(m.facts(), []);
  m.remember('I prefer short answers');
  m.remember('i prefer short answers');
  m.remember('FRIDAY ships with the cloud brain by default');
  assert.deepEqual(m.facts(), ['I prefer short answers', 'FRIDAY ships with the cloud brain by default']);
  assert.match(fs.readFileSync(path.join(m.dir, 'memory.md'), 'utf8'), /^- I prefer short answers$/m);
  assert.equal(m.forget('1'), 1);
  assert.equal(m.forget('cloud'), 1);
  assert.deepEqual(m.facts(), []);
});

test('recall: facts, past conversations newest first, the last exchanges of the latest; never the current one or sealed turns', () => {
  const m = createMemory(tmp());
  m.remember('use pnpm');
  const convs = [
    conv('now', 300, [t('current question', 'x')]),
    conv('b', 200, [t('add a --version flag to friday', 'Added --version in bin/friday.js; tests pass.'), t('[sealed project: not saved]', '[sealed project: not saved]', { sealed: true })]),
    conv('a', 100, [t('set up the parts list', 'Wrote reports/parts.md')]),
  ];
  m.saveSummary(convs[2], 'Made the parts list; ordering is next.');
  const r = m.recall(convs, { currentId: 'now' });
  assert.match(r, /- use pnpm/);
  assert.ok(r.indexOf('--version') < r.indexOf('parts list'), 'newest first');
  assert.match(r, /Made the parts list; ordering is next\./, 'the brain summary when there is one');
  assert.match(r, /asked: "add a --version flag to friday"/, 'the questions when there is none yet');
  assert.match(r, /- user: add a --version flag to friday\n {2}claude: Added --version in bin\/friday\.js/);
  assert.doesNotMatch(r, /current question|sealed/);
});

test('which conversations still need a summary', () => {
  const m = createMemory(tmp());
  const a = conv('a', 1, [t('q', 'a')]);
  const b = conv('b', 2, [t('q', 'a')]);
  assert.deepEqual(m.unsummarized([b, a], { exceptId: 'b' }).map((c) => c.id), ['a']);
  m.saveSummary(a, 's');
  assert.deepEqual(m.unsummarized([a]), []);
  a.turns.push(t('q2', 'a2'));
  assert.deepEqual(m.unsummarized([a]).map((c) => c.id), ['a'], 'grown since: summarize again');
  assert.match(summaryPrompt(a), /User: q2\nclaude: a2/);
});

test('the brain gets its memory and may answer "what did we do last?" itself', async () => {
  assert.ok(aboutMemory('what did we work on last time?'));
  assert.ok(aboutMemory('continue where we left off'));
  assert.ok(!aboutMemory('fix the tests'));
  assert.ok(aboutMemory('what is my test codename?'));
  const sys = systemPrompt({ agents: ['claude'], cwd: '~', mode: 'edit', memory: '- use pnpm' });
  assert.match(sys, /\[Memory\]\n- use pnpm\n\[end memory\]/);
  assert.doesNotMatch(systemPrompt({ agents: ['claude'], cwd: '~', mode: 'edit' }), /\[Memory\]/);
  // "what did we work on in the friday project last time" names a project, which would
  // normally force a delegation; a memory question may be answered by the brain.
  let answered = null;
  const fetchImpl = async () => new Response(JSON.stringify({ message: { role: 'assistant', content: 'We added a --version flag.' } }));
  const r = await orchestrate('what did we work on in the friday project last time?', {
    agents: ['claude'], profile: { orchestrator: { maxSteps: 3 }, agents: {} }, context: { cwd: '~', mode: 'edit', memory: 'x' },
    callAgent: async () => { throw new Error('should not delegate'); }, fetchImpl, base: 'http://x', on: { answer: (a) => { answered = a; } },
  });
  assert.equal(r.calls.length, 0);
  assert.equal(answered, 'We added a --version flag.');
});

test('"remember that …" reaches the remember tool and is saved', async () => {
  const replies = [
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'remember', arguments: { fact: 'I prefer short answers' } } }] },
    { role: 'assistant', content: 'Got it.' },
  ];
  const seenTools = [];
  const fetchImpl = async (url, init) => { seenTools.push(JSON.parse(init.body).tools?.map((x) => x.function.name)); return new Response(JSON.stringify({ message: replies.shift() })); };
  const saved = [];
  let answered = null;
  await orchestrate('remember that I prefer short answers', {
    agents: ['claude'], profile: { orchestrator: { maxSteps: 3 }, agents: {} }, context: { cwd: '~', mode: 'edit' },
    callAgent: async () => null, fetchImpl, base: 'http://x',
    on: { remember: (f) => { saved.push(f); return true; }, answer: (a) => { answered = a; } },
  });
  assert.ok(seenTools[0].includes(REMEMBER_TOOL.function.name));
  assert.deepEqual(saved, ['I prefer short answers']);
  assert.equal(answered, 'Got it.');
});
