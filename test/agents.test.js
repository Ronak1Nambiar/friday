import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AGENTS, claudePermission, claudeSupportsAuto, closeLive, describeTool, ollamaLoaded, runTurn, sessionExited, settleAgents, touchedPaths, winCommand } from '../src/agents.js';

function collect(agent, events) {
  const got = { text: '', tools: [], errors: [], done: null };
  const session = {};
  const out = {
    text: (t) => { got.text += t; },
    tool: (n, i) => got.tools.push([n, i]),
    error: (m) => got.errors.push(m),
    done: (m) => { got.done = m; },
  };
  for (const ev of events) AGENTS[agent].parse(ev, out, session);
  return { got, session };
}

test('claude: streams text deltas, tool calls, result', () => {
  const { got, session } = collect('claude', [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } }, parent_tool_use_id: null },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }, parent_tool_use_id: null },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }, parent_tool_use_id: null },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'subagent noise' } }, parent_tool_use_id: 'toolu_1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/r/a.js' } }] }, parent_tool_use_id: null },
    { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0.05 },
  ]);
  assert.equal(got.text, 'Hello');
  assert.deepEqual(got.tools, [['Edit', { file_path: '/r/a.js' }]]);
  assert.equal(got.done.cost, 0.05);
  assert.equal(session.id, 's1');
});

test('input tokens: claude sums fresh + cache, codex and opencode report theirs', () => {
  const c = collect('claude', [{ type: 'result', subtype: 'success', total_cost_usd: 0.1,
    usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 15000, output_tokens: 40 } }]);
  assert.deepEqual([c.got.done.inTokens, c.got.done.cachedIn, c.got.done.outTokens], [15210, 15000, 40]);
  const x = collect('codex', [{ type: 'turn.completed', usage: { input_tokens: 9000, cached_input_tokens: 8000, output_tokens: 12 } }]);
  assert.deepEqual([x.got.done.inTokens, x.got.done.cachedIn, x.got.done.outTokens], [9000, 8000, 12]);
  const o = collect('opencode', [{ type: 'step_finish', part: { cost: 0, tokens: { input: 300, output: 20, cache: { read: 100 } } } }]);
  assert.deepEqual([o.got.done.inTokens, o.got.done.cachedIn, o.got.done.outTokens], [300, 100, 20]);
});

test('claude: resume and permission flags', () => {
  const a = AGENTS.claude.args('hi', { id: 'abc' }, 'plan');
  assert.deepEqual(a.slice(0, 2), ['-p', 'hi']);
  assert.ok(a.includes('--resume') && a.includes('abc'));
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'plan');
  process.env.FRIDAY_CLAUDE_EDIT = 'acceptEdits';
  try {
    assert.equal(AGENTS.claude.args('x', {}, 'edit')[AGENTS.claude.args('x', {}, 'edit').indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.equal(AGENTS.claude.liveArgs({}, 'edit')[AGENTS.claude.liveArgs({}, 'edit').indexOf('--permission-mode') + 1], 'acceptEdits');
  } finally { delete process.env.FRIDAY_CLAUDE_EDIT; }
});

test('claude edit mode: auto (no stop for routine commands) when the CLI has it, else acceptEdits', () => {
  assert.equal(claudePermission('edit', { env: {}, auto: () => true }), 'auto');
  assert.equal(claudePermission('edit', { env: {}, auto: () => false }), 'acceptEdits');
  assert.equal(claudePermission('edit', { env: { FRIDAY_CLAUDE_EDIT: 'acceptEdits' }, auto: () => true }), 'acceptEdits');
  assert.equal(claudePermission('plan', { env: {}, auto: () => true }), 'plan');
  assert.equal(claudePermission('yolo', { env: {}, auto: () => true }), 'bypassPermissions');
  assert.equal(claudeSupportsAuto('  --permission-mode <mode>   Permission mode\n      (choices: "acceptEdits", "auto",\n      "bypassPermissions", "plan")'), true);
  assert.equal(claudeSupportsAuto('  --permission-mode <mode>   (choices: "acceptEdits", "bypassPermissions", "default", "plan")'), false);
});

test('codex: thread id, messages, commands, file changes, failures', () => {
  const { got, session } = collect('codex', [
    { type: 'thread.started', thread_id: 't9' },
    { type: 'turn.started' },
    { type: 'item.started', item: { type: 'command_execution', command: 'ls -la' } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/x.py', kind: 'update' }] } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { output_tokens: 12 } },
  ]);
  assert.equal(session.id, 't9');
  assert.equal(got.text, 'done\n');
  assert.deepEqual(got.tools.map((t) => t[0]), ['Shell', 'Update']);
  assert.equal(got.done.tokens, 12);
  const f = collect('codex', [{ type: 'turn.failed', error: { message: 'quota' } }]);
  assert.deepEqual(f.got.errors, ['quota']);
});

test('codex: resume puts the session first and keeps the sandbox', () => {
  assert.deepEqual(AGENTS.codex.args('go', { id: 't9' }, 'plan'),
    ['exec', 'resume', 't9', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', 'go']);
  assert.ok(AGENTS.codex.args('go', {}, 'yolo').includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('opencode and gemini parse their event shapes', () => {
  const o = collect('opencode', [
    { type: 'step_start', sessionID: 'ses_1', part: {} },
    { type: 'tool_use', sessionID: 'ses_1', part: { tool: 'read', state: { input: { filePath: 'a.md' } } } },
    { type: 'text', sessionID: 'ses_1', part: { text: 'hi' } },
  ]);
  assert.equal(o.session.id, 'ses_1');
  assert.equal(o.got.text, 'hi\n');
  assert.equal(o.got.tools[0][0], 'read');
  const g = collect('gemini', [
    { type: 'init', session_id: 'g1' },
    { type: 'message', role: 'user', content: 'q' },
    { type: 'message', role: 'assistant', content: 'an', delta: true },
    { type: 'message', role: 'assistant', content: 'swer', delta: true },
    { type: 'tool_use', tool_name: 'read_file', parameters: { file_path: 'b.ts' } },
    { type: 'result', status: 'success' },
  ]);
  assert.equal(g.got.text, 'answer');
  assert.equal(g.got.tools[0][0], 'read_file');
});

test('touchedPaths finds paths at any depth and makes them relative', () => {
  assert.deepEqual(touchedPaths({ file_path: '/r/src/a.js' }, '/r'), ['src/a.js']);
  assert.deepEqual(touchedPaths({ edits: [{ path: 'b.js' }], other: 'x' }, '/r'), ['b.js']);
  assert.deepEqual(touchedPaths({ command: 'cat /r/a' }, '/r'), []);
  assert.deepEqual(touchedPaths({ file_path: '/elsewhere/z' }, '/r'), [path.resolve('/elsewhere/z')]);
});

test('windows: npm shims run their target without cmd.exe, so multi-line prompts survive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-shim-'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'x', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'bin', 'x.exe'), '');
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'cli.js'), '');
  fs.writeFileSync(path.join(dir, 'x.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\x\\bin\\x.exe"   %*\r\n');
  fs.writeFileSync(path.join(dir, 'y.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\x\\cli.js" %*\r\n');
  fs.writeFileSync(path.join(dir, 'z.cmd'), '@ECHO off\r\nsomething else %*\r\n');
  const prompt = 'line one\nline "two"';
  assert.deepEqual(winCommand('x', ['-p', prompt], path.join(dir, 'x.cmd')),
    { file: path.join(dir, 'node_modules', 'x', 'bin', 'x.exe'), args: ['-p', prompt], shell: false });
  assert.deepEqual(winCommand('y', ['-p', prompt], path.join(dir, 'y.cmd')),
    { file: process.execPath, args: [path.join(dir, 'node_modules', 'x', 'cli.js'), '-p', prompt], shell: false });
  assert.deepEqual(winCommand('w', [prompt], path.join(dir, 'w.exe')), { file: path.join(dir, 'w.exe'), args: [prompt], shell: false });
  assert.equal(winCommand('z', [prompt], path.join(dir, 'z.cmd')).shell, true, 'unknown shim falls back to the shell');
});

// A stand-in `claude` on PATH: streams an answer, sends `result`, then stays alive
// like Claude running the user's SessionEnd hooks.
function fakeClaude(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-fake-'));
  fs.writeFileSync(path.join(dir, 'fake.js'), script);
  if (process.platform === 'win32') fs.writeFileSync(path.join(dir, 'fakeclaude.cmd'), '@ECHO off\r\n"%_prog%" "%dp0%\\fake.js" %*\r\n');
  else fs.writeFileSync(path.join(dir, 'fakeclaude'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'fake.js')}" "$@"\n`, { mode: 0o755 });
  return dir;
}
async function withFake(script, fn) {
  const dir = fakeClaude(script);
  const saved = [AGENTS.claude.bin, process.env.PATH];
  AGENTS.claude.bin = 'fakeclaude';
  process.env.PATH = dir + path.delimiter + process.env.PATH;
  try { return await fn(); } finally { [AGENTS.claude.bin, process.env.PATH] = saved; }
}
const say = (o) => `console.log(${JSON.stringify(JSON.stringify(o))});`;
const delta = (t) => say({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });

test('claude: the turn ends at `result`, not when its SessionEnd hooks finish', async () => {
  await withFake(`${say({ type: 'system', subtype: 'init', session_id: 's1' })}${delta('hi')}
${say({ type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0.01 })}
setTimeout(() => process.exit(0), 1500);`, async () => {
    const session = {};
    const t0 = Date.now();
    const run = runTurn('claude', 'q', { cwd: os.tmpdir(), session, on: {} });
    const r = await run.done;
    const answered = Date.now() - t0;
    assert.equal(r.ok, true);
    assert.equal(r.text, 'hi');
    assert.equal(session.id, 's1');
    let gone = false;
    run.exited.then(() => { gone = true; });
    assert.equal(gone, false, 'process still finishing its hooks');
    run.abort(); // the answer is in: abort must not kill the hooks
    await sessionExited(session);
    const exited = Date.now() - t0;
    assert.ok(exited - answered >= 1000, `answered at ${answered}ms, exited at ${exited}ms`);
    assert.equal(await settleAgents(50), 0);
  });
});

test('claude: with no `result`, the turn still ends at exit and reports the failure', async () => {
  await withFake(`${delta('partial')}\nconsole.error('boom'); process.exit(3);`, async () => {
    const r = await runTurn('claude', 'q', { cwd: os.tmpdir(), session: {}, on: {} }).done;
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /boom/);
  });
  await withFake(`${say({ type: 'result', is_error: true, result: 'session limit' })}\nsetTimeout(() => {}, 300);`, async () => {
    const r = await runTurn('claude', 'q', { cwd: os.tmpdir(), session: {}, on: {} }).done;
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ['session limit']);
  });
});

test('a turn past its timeout is stopped and reported as timedOut, not aborted; partial text kept', async () => {
  await withFake(`${delta('half an answer')}\nsetTimeout(() => {}, 60000);`, async () => {
    const t0 = Date.now();
    const r = await runTurn('claude', 'q', { cwd: os.tmpdir(), session: {}, on: {}, timeoutMs: 800 }).done;
    assert.ok(Date.now() - t0 < 10000);
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    assert.equal(r.aborted, false);
    assert.equal(r.text, 'half an answer');
    assert.match(r.errors.join(' '), /timed out after 1s/);
  });
});

test('a failed turn reports its exit code and stderr tail', async () => {
  await withFake(`console.error('line one'); console.error('the real reason'); process.exit(7);`, async () => {
    const r = await runTurn('claude', 'q', { cwd: os.tmpdir(), session: {}, on: {} }).done;
    assert.equal(r.code, 7);
    assert.match(r.stderrTail, /the real reason/);
  });
});

test('claude: a plan-mode answer given as ExitPlanMode becomes the text when nothing else was said', async () => {
  const plan = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: '## Findings\n- one' } }] } };
  await withFake(`${say(plan)}${say({ type: 'result', subtype: 'success' })}`, async () => {
    const r = await runTurn('claude', 'q', { cwd: os.tmpdir(), session: {}, on: {} }).done;
    assert.equal(r.ok, true);
    assert.equal(r.text, '## Findings\n- one');
  });
  await withFake(`${delta('said in text')}${say(plan)}${say({ type: 'result', subtype: 'success' })}`, async () => {
    const r = await runTurn('claude', 'q', { cwd: os.tmpdir(), session: {}, on: {} }).done;
    assert.equal(r.text, 'said in text');
  });
});

// A stand-in for `claude -p --input-format stream-json`: one answer per input line,
// and a count of how many times it was started.
const liveFake = (counter) => `
require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');
const resumed = process.argv.includes('--resume');
let n = 0;
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const msg = JSON.parse(l).message.content;
  n++;
  ${say({ type: 'system', subtype: 'init', session_id: 'live1', apiKeySource: 'none' })}
  console.log(JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: (resumed ? 'resumed ' : '') + 'turn ' + n + ': ' + msg } } }));
  if (msg === 'slow') return;
  ${say({ type: 'result', subtype: 'success', session_id: 'live1', total_cost_usd: 0 })}
});`;

test('claude live: one process serves every turn; a new mode or an abort starts one that resumes', async () => {
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'friday-live-')), 'starts');
  await withFake(liveFake(counter), async () => {
    const session = {};
    const opts = { cwd: os.tmpdir(), session, on: {}, live: true, mode: 'edit' };
    const a = await runTurn('claude', 'one', opts).done;
    const b = await runTurn('claude', 'two', opts).done;
    assert.deepEqual([a.ok, a.text, b.text, b.billing], [true, 'turn 1: one', 'turn 2: two', 'plan']);
    assert.equal(fs.readFileSync(counter, 'utf8'), 'x', 'started once');
    assert.equal(session.id, 'live1');
    // Plan mode needs other flags: the old process ends, the new one resumes the session.
    const c = await runTurn('claude', 'three', { ...opts, mode: 'plan' }).done;
    assert.deepEqual([c.ok, c.text], [true, 'resumed turn 1: three']);
    assert.equal(fs.readFileSync(counter, 'utf8'), 'xx');
    // Interrupted mid-answer: the turn ends now, and the next turn gets a fresh process.
    const run = runTurn('claude', 'slow', { ...opts, mode: 'plan' });
    setTimeout(() => run.abort(), 300);
    const d = await run.done;
    assert.deepEqual([d.ok, d.aborted], [false, true]);
    const e = await runTurn('claude', 'four', { ...opts, mode: 'plan' }).done;
    assert.deepEqual([e.ok, e.text], [true, 'resumed turn 1: four']);
    closeLive();
    assert.equal(await settleAgents(5000) >= 1, true, 'closing waits for the process');
  });
});

test('claude live: its questions and permission requests go to FRIDAY and wait for the answer', async () => {
  // Asks a question, then for a permission; prints what came back.
  const fake = `
const rl = require('readline').createInterface({ input: process.stdin });
let step = 0;
const send = (o) => console.log(JSON.stringify(o));
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.type === 'user') { step = 1; send({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Color?', options: [{ label: 'red' }] }] } } }); return; }
  if (m.type === 'control_response' && step === 1) { step = 2; send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer=' + m.response.response.updatedInput.answers['Color?'] + ' ' } } });
    send({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm x' } } }); return; }
  if (m.type === 'control_response' && step === 2) { send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: m.response.response.behavior + ':' + m.response.response.message } } });
    send({ type: 'result', subtype: 'success' }); }
});`;
  await withFake(fake, async () => {
    const asked = [];
    const on = {
      permission: async (req) => {
        asked.push(req.tool_name);
        return req.tool_name === 'AskUserQuestion'
          ? { behavior: 'allow', updatedInput: { ...req.input, answers: { 'Color?': 'red' } } }
          : { behavior: 'deny', message: 'no' };
      },
    };
    const r = await runTurn('claude', 'go', { cwd: os.tmpdir(), session: {}, on, live: true }).done;
    assert.deepEqual(asked, ['AskUserQuestion', 'Bash']);
    assert.equal(r.text, 'answer=red deny:no');
    assert.ok(AGENTS.claude.liveArgs({}, 'edit').join(' ').includes('--permission-prompt-tool stdio'));
    closeLive();
  });
});

test('ollamaLoaded: true only for a model in memory; false when Ollama is down', async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5:7b-instruct', model: 'qwen2.5:7b-instruct' }] }) });
    assert.equal(await ollamaLoaded('qwen2.5:7b-instruct'), true);
    assert.equal(await ollamaLoaded('gemma4:26b'), false);
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    assert.equal(await ollamaLoaded('qwen2.5:7b-instruct'), false);
  } finally { globalThis.fetch = real; }
});

test('describeTool prefers files, then commands', () => {
  assert.equal(describeTool('Edit', { file_path: '/r/a.js' }, '/r'), 'Edit a.js');
  assert.equal(describeTool('Bash', { command: 'npm   test' }, '/r'), 'Bash npm test');
});
