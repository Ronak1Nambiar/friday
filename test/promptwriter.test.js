import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_PROFILE } from '../src/profile.js';
import {
  addedActions, checkCurated, cleanRewrite, curate, estimateTokens, extractTerms, logEntry, readLog, rewrite, shouldRewrite, summarizeLog, writerStatus,
} from '../src/promptwriter.js';

const pw = { ...structuredClone(DEFAULT_PROFILE.promptWriter), enabled: true };
const profile = structuredClone(DEFAULT_PROFILE);
const projects = ['MyApp', 'SEALEDPROJ', 'OtherApp', 'friday'];

const LONG = 'Hey so I was looking at myapp again today and honestly the thing that keeps bugging me is that '
  + 'the failing test in `test/sync.test.js` still fails on Windows after PR #2, can you please fix it so it passes, '
  + 'and you must not touch src/router.js:121 at all, and never push to main, and only change files under src/parser. '
  + 'Also the timeout should be 8000 ms not 5000, see https://github.com/example/myapp/pull/2 for context, '
  + 'and keep the "offline mode" behaviour exactly as it is. Thanks so much, really appreciate it!';

// A fake Ollama: answers /api/chat with `reply` (or fails), records the request.
function fakeOllama({ reply, status = 200, body, delayMs = 0, throws } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (throws) throw throws;
    if (delayMs) {
      await new Promise((res, rej) => {
        const t = setTimeout(res, delayMs);
        init.signal?.addEventListener('abort', () => { clearTimeout(t); rej(init.signal.reason); });
      });
    }
    return {
      ok: status === 200, status,
      text: async () => body || '',
      json: async () => body || { message: { content: reply }, prompt_eval_count: 310, eval_count: 60 },
    };
  };
  return { fetchImpl, calls };
}

const GOOD = 'Fix the failing test in `test/sync.test.js` on Windows (still failing after PR #2) in myapp.\n'
  + '- Constraints: must not touch src/router.js:121; never push to main; only change files under src/parser.\n'
  + '- Set the timeout to 8000 ms (not 5000).\n- Keep the "offline mode" behaviour unchanged.\n'
  + '- Context: https://github.com/example/myapp/pull/2\n- Done when the test passes.';

test('when to rewrite: long routed messages to cloud agents only', () => {
  assert.equal(shouldRewrite(LONG, { agent: 'claude', pw }).ok, true);
  assert.equal(shouldRewrite(LONG, { agent: 'claude', pw: { ...pw, enabled: false } }).reason, 'disabled');
  assert.equal(shouldRewrite('fix the test', { agent: 'claude', pw }).reason, 'short');
  assert.equal(shouldRewrite(LONG, { agent: 'ollama', pw }).reason, 'ollama is skipped');
  assert.equal(shouldRewrite(LONG, { agent: 'codex', pw, pinned: true }).reason, 'pinned agent');
  assert.equal(shouldRewrite(LONG, { agent: 'claude', pw, kind: 'relay' }).reason, 'relay');
  assert.equal(shouldRewrite(LONG, { agent: 'claude', pw: { ...pw, minWords: 500 } }).reason, 'short');
});

test('key terms: paths, identifiers, numbers, quotes, urls, projects, constraints', () => {
  const t = extractTerms(LONG, { projects });
  const has = (kind, value) => t.some((x) => x.kind === kind && x.value === value);
  assert.ok(has('code', 'test/sync.test.js'));
  assert.ok(has('path', 'src/router.js:121'));
  assert.ok(has('ident', '#2'));
  assert.ok(has('number', '8000') && has('number', '5000'));
  assert.ok(has('quote', 'offline mode'));
  assert.ok(has('url', 'https://github.com/example/myapp/pull/2'));
  assert.ok(has('project', 'MyApp'));
  assert.ok(has('constraint', 'never push main'));
  assert.ok(has('constraint', 'must not touch src'));
  assert.ok(has('constraint', 'only change files'));
  // Real FRIDAY-style identifiers.
  const u = extractTerms('set OPENAI_API_KEY and promptWriter.timeoutMs, run node --test, then check MIMIC-IV notes in v1.11', {});
  for (const v of ['OPENAI_API_KEY', 'promptWriter', 'timeoutMs', '--test', 'MIMIC-IV', 'v1.11']) assert.ok(u.some((x) => x.value === v), v);
  // "e.g." and plain prose are not terms.
  assert.equal(extractTerms('please make it nicer, e.g. friendlier and calmer, thanks', {}).length, 0);
});

test('a faithful rewrite passes; dropping or weakening anything falls back', () => {
  assert.deepEqual(checkCurated(LONG, GOOD, { projects, profile }), { ok: true });
  const cases = [
    [GOOD.replace('src/router.js:121', 'the router'), /missing path/],
    [GOOD.replace('8000', 'eight seconds'), /missing number/],
    [GOOD.replace('https://github.com/example/myapp/pull/2', 'the PR'), /missing url/],
    [GOOD.replace('never push to main', 'push to main when done'), /missing constraint|never/],
    [GOOD.replace('only change files under src/parser', 'change files under src/parser'), /missing constraint/],
    [GOOD.replace('"offline mode"', 'offline'), /missing quote/],
    ['', /empty/],
    ["I'm sorry, but I can't help rewrite that.", /refused/],
    [LONG + ' Also please be careful.', /not shorter/],
  ];
  for (const [cur, re] of cases) assert.match(checkCurated(LONG, cur, { projects, profile }).reason, re, cur.slice(0, 60));
  const proj = 'Could you take a look at the onboarding flow in OtherApp and tell me honestly what you think is confusing for a brand new user who has never seen it before';
  assert.match(checkCurated(proj, 'Review the onboarding flow; list what confuses a first-time user.', { projects }).reason, /missing project/);
  assert.equal(checkCurated(proj, 'Review the OtherApp onboarding flow; list what confuses a first-time user.', { projects }).ok, true);
});

test('a rewrite may not change what is asked: no added actions, placeholders, or lost "no X"', () => {
  // Rewrites of the kind a small model produces.
  const debug = 'I keep getting an error when I run node --test on Windows in this repo, something about the selfmod test and line endings I think, '
    + 'it was failing before with CRLF stuff and I am not sure if it is fixed now, can you debug why the selfmod tests might fail on Windows and tell me the root cause';
  assert.match(checkCurated(debug, 'Debug selfmod tests for line ending issues on Windows. Review and fix any CRLF problems. Run `node --test` to test changes.').reason, /added action/);
  assert.equal(checkCurated(debug, 'Debug why the selfmod tests fail on Windows (CRLF line endings?) when you run `node --test`; report the root cause.').ok, true);
  const spec = 'Please implement the export command we talked about, writing markdown files with one heading per turn, keeping private turns out unless asked, and adding tests for the slug and the private filter';
  assert.match(checkCurated(spec, 'Implement export: markdown, heading per turn, exclude private turns unless asked; add tests (slug, private filter). Must be done by [specific date/time].').reason, /placeholder/);
  const writing = 'Can you write me a short README paragraph, four or five sentences, explaining what the prompt-writer does, plain and direct, no marketing words, and mention that it is off by default';
  assert.match(checkCurated(writing, 'Write a 4-5 sentence README paragraph explaining the prompt-writer in a plain tone. Mention it is off by default.').reason, /missing constraint/);
  assert.equal(checkCurated(writing, 'Write a four or five sentence README paragraph on the prompt-writer: plain, direct, no marketing words; say it is off by default.').ok, true);
  for (const [o, c] of [['write it', 'writes it'], ['run tests', 'running tests'], ['add one', 'adding one']]) assert.deepEqual(addedActions(o, c), [], `${o} / ${c}`);
  assert.deepEqual(addedActions('explain it', 'rewrite it'), ['rewrite']);
});

test('private data: the rewrite may not drop the words that keep it local', () => {
  const orig = 'Summarize the cohort statistics from the MIMIC-IV discharge summaries we pulled for the SEALEDPROJ project, '
    + 'grouped by admission type, and list the five most common diagnoses with counts, no patient identifiers at all please.';
  const r = checkCurated(orig, 'Summarize cohort statistics grouped by admission type; list five most common diagnoses with counts.', { profile });
  assert.equal(r.ok, false);
  assert.match(r.reason, /private|missing/);
});

test('cleanRewrite strips prefaces, fences and wrapping quotes', () => {
  assert.equal(cleanRewrite("Here's the rewritten prompt:\nFix X."), 'Fix X.');
  assert.equal(cleanRewrite('```\nFix X.\n```'), 'Fix X.');
  assert.equal(cleanRewrite('"Fix X."'), 'Fix X.');
  assert.equal(cleanRewrite('Fix "X" now.'), 'Fix "X" now.');
});

test('curate: a good rewrite is used, with writer token counts from Ollama', async () => {
  const o = fakeOllama({ reply: GOOD });
  const c = await curate(LONG, { agent: 'claude', label: 'Claude Code', pw, projects, profile, fetchImpl: o.fetchImpl, base: 'http://x' });
  assert.equal(c.rewritten, true);
  assert.equal(c.text, GOOD);
  assert.equal(c.stats.writerInTok, 310);
  assert.ok(c.stats.curTok < c.stats.origTok);
  const req = o.calls[0].body;
  assert.equal(req.model, 'qwen2.5:7b-instruct');
  assert.equal(req.stream, false);
  assert.match(req.messages[0].content, /Claude Code/);
  assert.equal(req.messages[1].content, LONG, 'only the message goes to the writer');
});

test('curate never blocks a turn: every failure sends the original', async () => {
  const fails = [
    [fakeOllama({ throws: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }), /not running/],
    [fakeOllama({ delayMs: 500 }), /timed out/, { timeoutMs: 50 }],
    [fakeOllama({ status: 404, body: '{"error":"model \\"qwen2.5:7b-instruct\\" not found"}' }), /not pulled/],
    [fakeOllama({ reply: '' }), /empty/],
    [fakeOllama({ reply: GOOD.replace('8000', '8s') }), /missing number/],
    [fakeOllama({ reply: LONG + ' More.' }), /not shorter/],
  ];
  for (const [o, re, extra] of fails) {
    const c = await curate(LONG, { agent: 'codex', pw: { ...pw, ...extra }, projects, profile, fetchImpl: o.fetchImpl, base: 'http://x' });
    assert.equal(c.text, LONG);
    assert.equal(c.rewritten, false);
    assert.equal(c.fallback, true);
    assert.match(c.reason, re);
  }
  // Skips are not fallbacks and never call the model.
  const o = fakeOllama({ reply: GOOD });
  const s = await curate('short one', { agent: 'claude', pw, fetchImpl: o.fetchImpl, base: 'http://x' });
  assert.deepEqual([s.text, s.fallback, o.calls.length], ['short one', false, 0]);
});

test('rewrite budget grows with long pasted specs', async () => {
  const spec = Array.from({ length: 400 }, (_, i) => `word${i % 7 ? '' : i}`).join(' ');
  const o = fakeOllama({ reply: 'x' });
  await rewrite(spec, { agent: 'claude', pw, fetchImpl: o.fetchImpl, base: 'http://x' });
  assert.match(o.calls[0].body.messages[0].content, /At most 200 words/);
});

test('the log keeps counts only, never message text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-pw-'));
  const e = logEntry(dir, { agent: 'claude', category: 'code', rewritten: false, fallback: true,
    reason: 'missing path "src/secret-thing.js"', origTok: 120, rewriteMs: 900, text: LONG, prompt: LONG, billing: 'plan' });
  assert.equal(e.reason, 'missing path');
  const raw = fs.readFileSync(path.join(dir, 'promptwriter.jsonl'), 'utf8');
  assert.ok(!raw.includes('myapp') && !raw.includes('secret-thing') && !raw.includes('"text"'));
  logEntry(dir, { agent: 'codex', rewritten: true, fallback: false, origTok: 200, curTok: 100, rewriteMs: 1100 });
  logEntry(dir, { agent: 'claude', rewritten: false, fallback: false, reason: 'short', origTok: 10 });
  const s = summarizeLog(readLog(dir));
  assert.deepEqual([s.turns, s.tried, s.rewritten, s.fallbacks, s.tokSaved], [3, 2, 1, 1, 100]);
  assert.equal(s.avgSaved, 0.5);
  assert.equal(s.avgMs, 1000);
  assert.deepEqual(s.reasons, { 'missing path': 1 });
});

test('health check: up and pulled, up but missing, down', async () => {
  const tags = (names) => async () => ({ ok: true, json: async () => ({ models: names.map((name) => ({ name })) }) });
  assert.deepEqual(await writerStatus(pw, { fetchImpl: tags(['qwen2.5:7b-instruct', 'gemma4:26b']), base: 'http://x' }), { up: true, pulled: true });
  assert.deepEqual(await writerStatus(pw, { fetchImpl: tags(['gemma4:26b']), base: 'http://x' }), { up: true, pulled: false });
  assert.deepEqual(await writerStatus(pw, { fetchImpl: async () => { throw new TypeError('fetch failed'); }, base: 'http://x' }), { up: false, pulled: false });
  assert.equal(estimateTokens('abcdefgh'), 2);
});
