import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PROFILE } from '../src/profile.js';
import { agentPrompt, agentTools, needsTools, orchestrate, parseCall, rememberExchange } from '../src/orchestrator.js';

const profile = structuredClone(DEFAULT_PROFILE);
const agents = ['claude', 'codex', 'gemini'];
// The local model is asked again after every answer (closing lines, chained steps).
const follow = { ...profile, orchestrator: { ...profile.orchestrator, alwaysFollowUp: true } };
const context = { cwd: '~/proj', focus: null, mode: 'edit' };

// A scripted local model: each /api/chat call returns the next reply.
function model(replies) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return { ok: true, json: async () => ({ message: { role: 'assistant', content: '', ...r } }) };
  };
  return { fetchImpl, seen };
}
const call = (name, task) => ({ function: { name, arguments: { task } } });
function agentsDo(answers = {}) {
  const ran = [];
  return { ran, callAgent: async (agent, prompt) => { ran.push({ agent, prompt }); return answers[agent] === null ? null : { ok: answers[agent]?.ok ?? true, text: answers[agent]?.text ?? `${agent} answer` }; } };
}

test('tools: one per ready agent, described by profile strengths', () => {
  const t = agentTools(agents, profile);
  assert.deepEqual(t.map((x) => x.function.name), ['ask_claude', 'ask_codex', 'ask_gemini']);
  assert.match(t[1].function.description, /codex: .*running tests/);
  assert.deepEqual(t[0].function.parameters.required, ['task']);
});

test('small talk is answered locally, no agent runs', async () => {
  const m = model([{ content: 'Hey there.' }]);
  const a = agentsDo();
  let answered = '';
  const r = await orchestrate('hey friday', { agents, profile, context, callAgent: a.callAgent, fetchImpl: m.fetchImpl, base: 'http://x', on: { answer: (t) => { answered = t; } } });
  assert.equal(r.handled, true);
  assert.deepEqual(r.calls, []);
  assert.equal(answered, 'Hey there.');
  assert.equal(a.ran.length, 0);
  assert.equal(m.seen[0].tools.length, 3);
  assert.equal(m.seen[0].stream, false);
});

test('delegates, keeps the user\'s words when the task is a summary, then ends', async () => {
  const m = model([{ tool_calls: [call('ask_codex', 'debug the login test')] }, { content: 'Codex found it.' }]);
  const a = agentsDo({ codex: { text: 'root cause: CRLF in fixtures' } });
  const notes = [];
  const r = await orchestrate('the login test fails on windows after PR #2, find out why but do not change anything', {
    agents, profile: follow, context, callAgent: a.callAgent, fetchImpl: m.fetchImpl, base: 'http://x', on: { note: (t) => notes.push(t) } });
  assert.deepEqual(r.calls, [{ agent: 'codex', ok: true }]);
  assert.match(a.ran[0].prompt, /^debug the login test\n\nThe user's request, in their words:\nthe login test fails on windows after PR #2, find out why but do not change anything$/);
  // The model saw the agent's answer as a tool result before finishing.
  const tool = m.seen[1].messages.at(-1);
  assert.equal(tool.role, 'tool');
  assert.match(tool.content, /root cause: CRLF/);
  assert.deepEqual(notes, ['Codex found it.']);
});

test('chains: the work, then a review by a different agent', async () => {
  const m = model([{ tool_calls: [call('ask_codex', 'fix the CRLF bug in selfmod')] }, { tool_calls: [call('ask_claude', 'review the CRLF fix codex just made')] }, { content: '' }]);
  const a = agentsDo();
  const r = await orchestrate('fix the CRLF bug in selfmod and then have it reviewed', { agents, profile, context, callAgent: a.callAgent, fetchImpl: m.fetchImpl, base: 'http://x' });
  assert.deepEqual(r.calls.map((c) => c.agent), ['codex', 'claude']);
  assert.equal(r.final, '');
});

test('bad tool names and repeats are refused back to the model; steps are capped', async () => {
  const m = model([
    { tool_calls: [call('ask_ollama', 'x'), call('ask_codex', 'run tests')] },
    { tool_calls: [call('ask_codex', 'run tests')] },
    { tool_calls: [call('ask_gemini', 'a')] },
    { tool_calls: [call('ask_claude', 'b')] },
    { tool_calls: [call('ask_codex', 'never reached')] },
  ]);
  const a = agentsDo();
  const r = await orchestrate('run the tests', { agents, profile: { ...follow, orchestrator: { ...follow.orchestrator, maxSteps: 4 } }, context, callAgent: a.callAgent, fetchImpl: m.fetchImpl, base: 'http://x' });
  assert.deepEqual(a.ran.map((x) => x.agent), ['codex', 'gemini', 'claude'], 'unknown tool and the repeat never ran; step 5 never happened');
  assert.match(m.seen[1].messages.find((x) => x.role === 'tool').content, /no tool ask_ollama/);
  assert.match(m.seen[2].messages.filter((x) => x.role === 'tool').at(-1).content, /already asked/);
  assert.equal(r.handled, true);
});

test('local model unreachable before anything ran: the rules take over; after: it stops', async () => {
  const down = model([Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })]);
  const r1 = await orchestrate('fix it', { agents, profile, context, callAgent: agentsDo().callAgent, fetchImpl: down.fetchImpl, base: 'http://x' });
  assert.deepEqual([r1.handled, r1.reason], [false, 'ollama not running']);
  const mid = model([{ tool_calls: [call('ask_claude', 'fix it')] }, new TypeError('boom')]);
  const fails = [];
  const r2 = await orchestrate('fix it', { agents, profile: follow, context, callAgent: agentsDo().callAgent, fetchImpl: mid.fetchImpl, base: 'http://x', on: { fail: (x) => fails.push(x) } });
  assert.equal(r2.handled, true);
  assert.equal(fails.length, 1);
});

test('an agent that could not run (blocked) is reported to the model as such', async () => {
  const m = model([{ tool_calls: [call('ask_claude', 'x')] }, { content: 'ok' }]);
  const r = await orchestrate('do x', { agents, profile, context, callAgent: agentsDo({ claude: null }).callAgent, fetchImpl: m.fetchImpl, base: 'http://x' });
  assert.deepEqual(r.calls.map((c) => [c.agent, c.ok]), [['claude', false], ['codex', true]], 'and the task moved on');
  assert.match(m.seen[1].messages.at(-1).content, /^NOT RUN/);
});

test('one good answer ends the turn: no second local call unless more was asked for', async () => {
  const m = model([{ tool_calls: [call('ask_claude', 'explain render.js')] }, { content: 'should never be asked' }]);
  const notes = [];
  const r = await orchestrate('what does render.js do', { agents, profile, context, callAgent: agentsDo().callAgent, fetchImpl: m.fetchImpl, base: 'http://x', on: { note: (t) => notes.push(t) } });
  assert.equal(m.seen.length, 1, 'the local model was asked once');
  assert.deepEqual([r.calls, notes, r.transcript.at(-1)], [[{ agent: 'claude', ok: true }], [], { role: 'assistant', content: '' }]);
  // A check, a review or a "then" keeps the loop going.
  const chain = model([{ tool_calls: [call('ask_codex', 'fix it')] }, { tool_calls: [call('ask_claude', 'review the fix')] }, { content: '' }]);
  const a = agentsDo();
  await orchestrate('fix the bug and have claude check it', { agents, profile, context, callAgent: a.callAgent, fetchImpl: chain.fetchImpl, base: 'http://x' });
  assert.deepEqual(a.ran.map((x) => x.agent), ['codex', 'claude']);
});

test('helpers: string arguments, task coverage, short memory', () => {
  assert.deepEqual(parseCall({ function: { name: 'ask_codex', arguments: '{"task":"run tests"}' } }), { name: 'ask_codex', agent: 'codex', task: 'run tests' });
  assert.equal(parseCall({ function: { name: 'weird' } }).agent, null);
  assert.equal(agentPrompt('Fix src/router.js line 121 tests', 'fix src/router.js line 121 tests'), 'Fix src/router.js line 121 tests');
  assert.equal(agentPrompt('', 'do the thing'), 'do the thing');
  let h = [];
  for (let i = 0; i < 5; i++) h = rememberExchange(h, [{ role: 'user', content: `msg ${i}` }, { role: 'assistant', content: `a${i}` }], 3);
  assert.equal(h.length, 6);
  assert.deepEqual(h.filter((m) => m.role === 'user').map((m) => m.content), ['msg 2', 'msg 3', 'msg 4']);
});

test('closing lines: none after a failed agent, none that restate the answer', async () => {
  const failed = model([{ tool_calls: [call('ask_codex', 'review it')] }, { content: 'Review complete, all good.' }]);
  const notes = [];
  const r1 = await orchestrate('review it', { agents, profile, context, callAgent: agentsDo({ codex: { ok: false, text: '' } }).callAgent, fetchImpl: failed.fetchImpl, base: 'http://x', on: { note: (t) => notes.push(t) } });
  assert.deepEqual(notes, [], 'a small model claimed success after a failure; it is not shown');
  assert.equal(r1.final, '');
  assert.match(failed.seen[1].messages.at(-1).content, /^FAILED/);
  const echo = model([{ tool_calls: [call('ask_claude', 'summarize render.js')] }, { content: 'render.js provides ANSI color helpers and a streaming markdown renderer.' }]);
  await orchestrate('what does render.js do', { agents, profile, context, callAgent: agentsDo({ claude: { text: 'src/render.js provides ANSI color and style helpers and a streaming markdown renderer for the terminal.' } }).callAgent, fetchImpl: echo.fetchImpl, base: 'http://x', on: { note: (t) => notes.push(t) } });
  assert.deepEqual(notes, [], 'a restatement of the answer is not shown');
  const useful = model([{ tool_calls: [call('ask_claude', 'fix it')] }, { content: 'Next: run the Windows CI job to confirm.' }]);
  await orchestrate('fix it', { agents, profile: follow, context, callAgent: agentsDo({ claude: { text: 'Changed selfmod cleanup to retry.' } }).callAgent, fetchImpl: useful.fetchImpl, base: 'http://x', on: { note: (t) => notes.push(t) } });
  assert.deepEqual(notes, ['Next: run the Windows CI job to confirm.']);
});

test('a failed agent is dropped and the task goes to the next one, even if the model gives up', async () => {
  // The model stops after the failure; FRIDAY hands the same task on, once.
  const m = model([{ tool_calls: [call('ask_codex', 'find why selfmod fails on windows')] }, { content: 'Sorry, that failed.' }, { content: '' }]);
  const a = agentsDo({ codex: { ok: false, text: '' } });
  const moved = [];
  const r = await orchestrate('find why selfmod fails on windows', { agents, profile, context, callAgent: a.callAgent, fetchImpl: m.fetchImpl, base: 'http://x', on: { fallback: (f, t) => moved.push([f, t]) } });
  assert.deepEqual(a.ran.map((x) => x.agent), ['codex', 'claude']);
  assert.equal(a.ran[1].prompt, a.ran[0].prompt, 'the same task');
  assert.deepEqual(moved, [['codex', 'claude']]);
  assert.deepEqual(r.calls.map((c) => [c.agent, c.ok]), [['codex', false], ['claude', true]]);
  // The failed agent is no longer offered as a tool.
  assert.deepEqual(m.seen[1].tools.map((t) => t.function.name), ['ask_claude', 'ask_gemini']);
  assert.match(m.seen[1].messages.at(-1).content, /Call ask_claude with the same task now/);
  // When every agent failed, it stops instead of looping.
  const m2 = model([{ tool_calls: [call('ask_codex', 'x')] }, { content: '' }, { content: '' }, { content: '' }]);
  const all = agentsDo({ codex: { ok: false }, claude: { ok: false }, gemini: { ok: false } });
  await orchestrate('x', { agents, profile, context, callAgent: all.callAgent, fetchImpl: m2.fetchImpl, base: 'http://x' });
  assert.deepEqual(all.ran.map((x) => x.agent), ['codex', 'claude', 'gemini']);
});

test('an agent that stops partway (a usage limit) is finished by the next one, not redone', async () => {
  // The model gives up: FRIDAY's own hand-over carries what was done.
  const m = model([{ tool_calls: [call('ask_claude', 'implement the queue and write docs')] }, { content: '' }, { content: '' }]);
  const a = agentsDo({ claude: { ok: false, text: 'Build passes. Tests 113/113. Now docs. Checking the relevant sections.' } });
  const failing = async (agent, prompt) => { const r = await a.callAgent(agent, prompt); return agent === 'claude' ? { ...r, errors: ["You've hit your session limit"] } : r; };
  const r = await orchestrate('implement the queue and write docs', { agents, profile, context, callAgent: failing, fetchImpl: m.fetchImpl, base: 'http://x' });
  assert.deepEqual(a.ran.map((x) => x.agent), ['claude', 'codex']);
  assert.match(a.ran[1].prompt, /^implement the queue and write docs\n\nclaude already started this and stopped partway \(You've hit your session limit\)/);
  assert.match(a.ran[1].prompt, /Now docs\. Checking the relevant sections\.[\s\S]*git status, git diff[\s\S]*only what is left/);
  assert.match(m.seen[1].messages.at(-1).content, /stopped partway[\s\S]*Call ask_codex to finish it/);
  assert.doesNotMatch(m.seen[1].messages.at(-1).content, /Nothing was done/);
  assert.equal(r.calls[0].partial.endsWith('relevant sections.'), true);
  // The model picks the next agent itself and repeats the original task: still a hand-over.
  const m2 = model([{ tool_calls: [call('ask_claude', 'do x')] }, { tool_calls: [call('ask_gemini', 'do x')] }, { content: '' }]);
  const b = agentsDo({ claude: { ok: false, text: 'did half of x' } });
  await orchestrate('do x', { agents, profile, context, callAgent: b.callAgent, fetchImpl: m2.fetchImpl, base: 'http://x' });
  assert.match(b.ran[1].prompt, /^do x\n\nclaude already started this and stopped partway\.[\s\S]*did half of x/);
  // A failure before any work keeps the plain hand-over.
  const m3 = model([{ tool_calls: [call('ask_claude', 'y')] }, { content: '' }, { content: '' }]);
  const c3 = agentsDo({ claude: { ok: false, text: '' } });
  await orchestrate('y', { agents, profile, context, callAgent: c3.callAgent, fetchImpl: m3.fetchImpl, base: 'http://x' });
  assert.equal(c3.ran[1].prompt, c3.ran[0].prompt);
});

test('memory holds the real exchange: tool call, cut-short result, and the closing line', async () => {
  const m = model([{ tool_calls: [call('ask_claude', 'summarize render.js')] }, { content: '' }]);
  const r = await orchestrate('what does render.js do', { agents, profile, context, callAgent: agentsDo({ claude: { text: 'x'.repeat(3000) } }).callAgent, fetchImpl: m.fetchImpl, base: 'http://x' });
  assert.deepEqual(r.transcript.map((x) => x.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(r.transcript[1].tool_calls[0].function.name, 'ask_claude');
  assert.ok(r.transcript[2].content.length <= 600);
  // A follow-up sees it.
  const m2 = model([{ tool_calls: [call('ask_codex', 'review what claude said about render.js')] }, { content: '' }]);
  await orchestrate('have codex check that', { agents, profile, context, history: rememberExchange([], r.transcript, 3), callAgent: agentsDo().callAgent, fetchImpl: m2.fetchImpl, base: 'http://x' });
  assert.deepEqual(m2.seen[0].messages.map((x) => x.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
});

test('a files/code/web question is never answered from nothing by the local model', async () => {
  assert.equal(needsTools('In one sentence, what does src/render.js do? Read it.'), true);
  assert.equal(needsTools('why does npm test fail'), true);
  assert.equal(needsTools('what are people saying about the latest gemini release'), true);
  assert.equal(needsTools('explain what this repo does'), true);
  for (const t of ['hey friday', 'thanks!', 'what is a git worktree, in one sentence?', 'suggest a name for a flag that skips confirmation']) assert.equal(needsTools(t), false, t);
  // It answers anyway: pushed back once, then delegates.
  const m = model([{ content: 'render.js renders the UI from props.' }, { tool_calls: [call('ask_claude', 'read src/render.js and summarize')] }, { content: '' }]);
  const a = agentsDo();
  const answered = [];
  await orchestrate('what does src/render.js do? Read it.', { agents, profile, context, callAgent: a.callAgent, fetchImpl: m.fetchImpl, base: 'http://x', on: { answer: (t) => answered.push(t) } });
  assert.deepEqual(answered, [], 'the made-up answer is never shown');
  assert.deepEqual(a.ran.map((x) => x.agent), ['claude']);
  assert.match(m.seen[1].messages.at(-1).content, /cannot read files/);
  assert.ok(!m.seen[1].messages.some((x) => /renders the UI from props/.test(x.content || '')), 'and it is not kept in the conversation');
  // It insists: the rules' agent gets the message as written.
  const stubborn = model([{ content: 'It renders UI.' }, { content: 'Still: it renders UI.' }, { content: '' }]);
  const b = agentsDo();
  await orchestrate('what does src/render.js do? Read it.', { agents, profile, context, defaultAgent: 'codex', callAgent: b.callAgent, fetchImpl: stubborn.fetchImpl, base: 'http://x' });
  assert.deepEqual(b.ran.map((x) => [x.agent, x.prompt]), [['codex', 'what does src/render.js do? Read it.']]);
});

test('the push-back is not kept in memory', async () => {
  const m = model([{ content: 'made up' }, { tool_calls: [call('ask_claude', 'read src/x.js')] }, { content: '' }]);
  const r = await orchestrate('read src/x.js and tell me what it does', { agents, profile, context, callAgent: agentsDo().callAgent, fetchImpl: m.fetchImpl, base: 'http://x' });
  assert.deepEqual(r.transcript.map((x) => x.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(r.transcript[0].content, 'read src/x.js and tell me what it does');
});

test('missions: offered only when asked for, and handed back before any agent runs', async () => {
  const fm = { function: { name: 'start_mission', arguments: { goal: 'build a campus food app, research it first' } } };
  const mm = model([{ tool_calls: [fm] }]);
  const a = agentsDo();
  const r = await orchestrate('I need to build a campus food app and research it first', { agents, profile, context, missions: true, callAgent: a.callAgent, fetchImpl: mm.fetchImpl, base: 'http://x' });
  assert.equal(r.mission, 'build a campus food app, research it first');
  assert.equal(a.ran.length, 0);
  assert.equal(mm.seen[0].tools[0].function.name, 'start_mission');
  assert.match(mm.seen[0].messages[0].content, /start_mission/);
  // Off by default (tests, other callers): no mission tool, no mention.
  const plain = model([{ content: 'hi' }]);
  await orchestrate('hi', { agents, profile, context, callAgent: a.callAgent, fetchImpl: plain.fetchImpl, base: 'http://x' });
  assert.ok(!plain.seen[0].tools.some((t) => t.function.name === 'start_mission'));
  assert.doesNotMatch(plain.seen[0].messages[0].content, /start_mission/);
});
