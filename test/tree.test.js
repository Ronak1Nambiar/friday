import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PROFILE } from '../src/profile.js';
import { cliPrompt } from '../src/brain.js';
import { agentTools, orchestrate, parseCall } from '../src/orchestrator.js';
import { DEFAULT_TREE, dispatchTool, planTwigs, runTwigs, treeLines, treeReport, twigPrompt } from '../src/tree.js';

const tree = structuredClone(DEFAULT_TREE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the profile carries the tree: five sonnets on the claude limb, astra as codex large', () => {
  assert.equal(DEFAULT_PROFILE.tree.limbs.claude.max, 5);
  assert.equal(DEFAULT_PROFILE.tree.limbs.claude.models.small, 'sonnet');
  assert.equal(DEFAULT_PROFILE.tree.limbs.codex.models.large, 'gpt-6-astra');
});

test('planTwigs: tiers pick models, missing limbs hand over, writers need a CLI limb, the list is capped', () => {
  const ready = ['claude', 'codex', 'openrouter'];
  const { twigs, notes } = planTwigs([
    { limb: 'claude', task: 'summarize a.md' },
    { limb: 'codex', tier: 'large', task: 'find the bug' },
    { limb: 'gemini', tier: 'small', task: 'research x' },
    { limb: 'openrouter', task: 'fix b.js', writes: true },
    { limb: 'claude', task: '   ' },
  ], { tree, ready });
  assert.equal(twigs.length, 4);
  assert.deepEqual(twigs.map((t) => [t.n, t.limb, t.model]), [[1, 'claude', 'sonnet'], [2, 'codex', 'gpt-6-astra'], [3, 'claude', 'sonnet'], [4, 'claude', 'sonnet']]);
  assert.equal(twigs[2].moved, 'gemini');
  assert.equal(twigs[3].moved, 'openrouter'); // a chat limb cannot change files
  assert.equal(twigs[3].writes, true);
  assert.equal(notes.length, 2);
  const many = planTwigs(Array.from({ length: 12 }, (_, i) => ({ limb: 'claude', task: `t${i}` })), { tree, ready });
  assert.equal(many.twigs.length, 8);
  assert.match(many.notes[0], /4 part/);
  assert.equal(planTwigs([{ limb: 'claude', task: 'x' }], { tree, ready: [] }).twigs.length, 0);
});

test('runTwigs: at most max per limb at once, writers alone after the readers, results in order', async () => {
  const t2 = { ...tree, limbs: { ...tree.limbs, claude: { ...tree.limbs.claude, max: 2 }, codex: { ...tree.limbs.codex, max: 1 } } };
  const { twigs } = planTwigs([
    { limb: 'claude', task: 'a' }, { limb: 'claude', task: 'b' }, { limb: 'claude', task: 'c' },
    { limb: 'codex', task: 'd' }, { limb: 'codex', task: 'e', writes: true }, { limb: 'claude', task: 'f', writes: true },
  ], { tree: t2, ready: ['claude', 'codex'] });
  const now = new Map();
  let peakClaude = 0;
  let peakAll = 0;
  let writing = 0;
  const log = [];
  const results = await runTwigs(twigs, {
    tree: t2,
    runTwig: async (t) => {
      now.set(t.limb, (now.get(t.limb) || 0) + 1);
      peakClaude = Math.max(peakClaude, now.get('claude') || 0);
      peakAll = Math.max(peakAll, [...now.values()].reduce((a, b) => a + b, 0));
      if (t.writes) { assert.equal([...now.values()].reduce((a, b) => a + b, 0), 1); writing++; }
      log.push(`start ${t.task}`);
      await sleep(10);
      now.set(t.limb, now.get(t.limb) - 1);
      if (t.task === 'c') throw new Error('boom');
      return { ok: true, text: `did ${t.task}` };
    },
  });
  assert.equal(peakClaude, 2);
  assert.equal(peakAll, 3);
  assert.equal(writing, 2);
  assert.deepEqual(log.slice(-2), ['start e', 'start f']);
  assert.deepEqual(results.map((r) => r.ok), [true, true, false, true, true, true]);
  assert.match(results[2].errors[0], /boom/);
  assert.equal(results[5].text, 'did f');
});

test('runTwigs: once stopped, twigs not yet started are skipped', async () => {
  const { twigs } = planTwigs([{ limb: 'codex', task: 'a' }, { limb: 'codex', task: 'b' }], { tree: { ...tree, limbs: { ...tree.limbs, codex: { max: 1, models: {} } } }, ready: ['codex'] });
  let stop = false;
  const r = await runTwigs(twigs, { tree, shouldStop: () => stop, runTwig: async () => { stop = true; return { ok: false, aborted: true, text: '' }; } });
  assert.equal(r[1].skipped, true);
});

test('the report tells the brain the user has not seen the parts, and marks failures', () => {
  const { twigs } = planTwigs([{ limb: 'claude', task: 'a' }, { limb: 'codex', task: 'b' }], { tree, ready: ['claude', 'codex'] });
  const rep = treeReport(twigs, [{ ok: true, text: 'x'.repeat(5000) }, { ok: false, errors: ['timed out'] }], { resultChars: 1000 });
  assert.match(rep, /1\/2 subagents finished\. The user has NOT seen/);
  assert.match(rep, /part 2 \(codex gpt-6-luna\): b\nFAILED: timed out/);
  assert.ok(rep.length < 1600);
  assert.match(twigPrompt(twigs[0], { total: 2, request: 'r' }), /subagent 1 of 2[\s\S]*Do not change any files/);
  assert.doesNotMatch(twigPrompt({ ...twigs[0], writes: true }, { total: 2, request: 'r' }), /Do not change any files/);
});

test('dispatch: offered only with limbs, parsed from objects or strings, shown to a CLI brain with its schema', () => {
  const p = structuredClone(DEFAULT_PROFILE);
  assert.ok(!agentTools(['claude'], p).some((t) => t.function.name === 'dispatch'));
  const tools = agentTools(['claude'], p, { limbs: ['claude', 'openrouter'] });
  const d = tools.find((t) => t.function.name === 'dispatch');
  assert.deepEqual(d.function.parameters.properties.tasks.items.properties.limb.enum, ['claude', 'openrouter']);
  assert.match(d.function.description, /openrouter \(text only/);
  assert.deepEqual(parseCall({ function: { name: 'dispatch', arguments: { tasks: [{ limb: 'claude', task: 'x' }] } } }).tasks, [{ limb: 'claude', task: 'x' }]);
  assert.deepEqual(parseCall({ function: { name: 'dispatch', arguments: '{"tasks":"[{\\"limb\\":\\"codex\\",\\"task\\":\\"y\\"}]"}' } }).tasks, [{ limb: 'codex', task: 'y' }]);
  const cp = cliPrompt([{ role: 'user', content: 'hi' }], tools);
  assert.match(cp, /args schema: \{"type":"object","properties":\{"tasks"/);
  assert.match(cp, /"tool": "dispatch"/);
  assert.doesNotMatch(cliPrompt([{ role: 'user', content: 'hi' }], agentTools(['claude'], p)), /dispatch|args schema/);
  assert.equal(dispatchTool(['claude']).function.parameters.properties.tasks.maxItems, 8);
});

// A scripted brain, as in orchestrator.test.js.
function model(replies) {
  const seen = [];
  return { seen, fetchImpl: async (url, init) => { seen.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ message: { role: 'assistant', content: '', ...replies.shift() } }) }; } };
}

test('orchestrate: the brain dispatches, reads every answer, and writes the combined answer', async () => {
  const profile = structuredClone(DEFAULT_PROFILE);
  const tasks = [{ limb: 'claude', tier: 'small', task: 'review a.js' }, { limb: 'codex', tier: 'large', task: 'review b.js' }];
  const m = model([{ tool_calls: [{ function: { name: 'dispatch', arguments: { tasks } } }] }, { content: 'Both files are fine; b.js has one slow loop.' }]);
  let got = null;
  let noted = '';
  const r = await orchestrate('review a.js and b.js', {
    agents: ['claude', 'codex'], profile, limbs: ['claude', 'codex'], context: { cwd: '~', mode: 'edit' }, fetchImpl: m.fetchImpl, base: 'http://x',
    callAgent: async () => assert.fail('no single agent should run'),
    on: { dispatch: async (t) => { got = t; return { ok: true, report: 'part 1: fine\npart 2: slow loop' }; }, note: (t) => { noted = t; } },
  });
  assert.deepEqual(got, tasks);
  assert.equal(m.seen.length, 2); // it was asked again after the parts, without "review" needing a follow-up rule
  assert.match(m.seen[1].messages.at(-1).content, /slow loop/);
  assert.match(m.seen[0].messages[0].content, /root of an agent tree/);
  assert.equal(noted, 'Both files are fine; b.js has one slow loop.');
  assert.deepEqual(r.calls, [{ agent: 'tree', ok: true, dispatch: true }]);
});

test('orchestrate: no combined answer after a dispatch shows the parts; no on.dispatch means no tree', async () => {
  const profile = structuredClone(DEFAULT_PROFILE);
  const m = model([{ tool_calls: [{ function: { name: 'dispatch', arguments: { tasks: [{ limb: 'claude', task: 'x' }] } } }] }, { content: '' }]);
  let shown = false;
  await orchestrate('do x and y', {
    agents: ['claude'], profile, limbs: ['claude'], context: { cwd: '~', mode: 'edit' }, fetchImpl: m.fetchImpl, base: 'http://x', callAgent: async () => null,
    on: { dispatch: async () => ({ ok: true, report: 'r' }), unsummarized: () => { shown = true; } },
  });
  assert.equal(shown, true);
  const m2 = model([{ content: 'hi' }]);
  await orchestrate('hey', { agents: ['claude'], profile, limbs: ['claude'], context: { cwd: '~', mode: 'edit' }, fetchImpl: m2.fetchImpl, base: 'http://x', callAgent: async () => null, on: {} });
  assert.ok(!m2.seen[0].tools.some((t) => t.function.name === 'dispatch'));
  assert.doesNotMatch(m2.seen[0].messages[0].content, /agent tree/);
});

test('/tree lines: the root, then one limb per provider', () => {
  const lines = treeLines({ tree, root: 'Codex gpt-6-astra', status: { claude: 'ready', codex: 'ready', gemini: 'not signed in' } });
  assert.equal(lines[0], 'FRIDAY (root · Codex gpt-6-astra)');
  assert.match(lines[1], /├─ claude +×5 +small sonnet · large opus/);
  assert.match(lines[3], /gemini +not signed in/);
  assert.match(lines.at(-1), /└─ ollama/);
});
