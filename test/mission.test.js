import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildMessages, extractJson, missionMarkdown, pickHeadroom, prBody, researchOnly, usageTable, missionStateStore, normalizeBuild, normalizePlan, parseLessons, parseVerdict, partsOverlap, planMessages,
  planSchema, recentLessons, renderBuild, renderPlan, reviewPlanPrompt, runMission, slugify, writeMissionFolder,
} from '../src/mission.js';

const agents = ['codex', 'claude'];
const PLAN = { title: 'Campus Free Food Finder', build_intent: 'A web app listing today\'s free food events.', research: [
  { id: 'market', agent: 'codex', purpose: 'Market and competitors', prompt: 'Research apps that list free campus food events...' },
  { id: 'tech', agent: 'claude', purpose: 'Technical needs', prompt: 'Outline the stack for a small web app...' },
] };
const BUILD = { brief: '# Brief\nBuild it: students miss free food.', build: [
  { id: 'build', agent: 'claude', role: 'build', prompt: 'Create a Vite app that...' },
  { id: 'review', agent: 'codex', role: 'review', prompt: 'Review the app for...' },
] };

// A reviewer's reply with its verdict block.
const verdict = (v, issues = []) => `Checked it.\n\`\`\`json\n${JSON.stringify({ verdict: v, issues })}\n\`\`\``;

// Scripted I/O: replies to checkpoints in order, records everything.
function io({ replies = ['go', 'go'], local, claude, research, build, verify, extra = {} } = {}) {
  const log = { shown: [], asked: [], status: [], local: [], claude: [], research: [], build: [], verify: [], checkpoints: [], saved: null };
  const q = [...replies];
  return {
    log,
    io: {
      agents,
      local: async (messages, opts) => { log.local.push({ messages, opts }); return local ? local(log.local.length, messages) : JSON.stringify(opts.format.required.includes('research') ? PLAN : BUILD); },
      claude: async (prompt) => { log.claude.push(prompt); return claude ? claude(log.claude.length, prompt) : { ok: true, text: 'Improved:\n```json\n' + JSON.stringify(prompt.includes('research plan') ? PLAN : BUILD) + '\n```' }; },
      ask: async (question) => { log.asked.push(question); return q.shift() ?? 'cancel'; },
      show: (t) => log.shown.push(t),
      status: (t) => log.status.push(t),
      runResearch: async (jobs) => { log.research.push(jobs); return research ? research(jobs) : jobs.map((j) => ({ id: j.id, agent: j.agent, ok: true, text: `${j.id} findings` })); },
      runBuild: async (job, dir) => { log.build.push({ job, dir }); return build ? build(job, log.build.length) : { ok: true, text: job.role === 'review' || job.role === 'test' ? verdict('pass') : `${job.role} done` }; },
      verify: async (dir, cmd) => { log.verify.push({ dir, cmd }); return verify ? verify(log.verify.length) : { ran: true, ok: true, command: cmd || 'npm test' }; },
      checkpoint: (m) => log.checkpoints.push(structuredClone(m)),
      workdir: (plan) => `/projects/${slugify(plan.title)}`,
      save: async (m) => { log.saved = structuredClone(m); return 'vault: 03_Resources/friday-missions/x.md'; },
      ...extra,
    },
  };
}

test('a mission runs plan -> review -> go -> research -> brief -> review -> go -> build, and saves', async () => {
  const { io: x, log } = io();
  const m = await runMission('I want to build a free food finder for students, research it first', x, { date: '2026-10-12' });
  assert.equal(m.status, 'built and verified');
  assert.equal(log.local.length, 2, 'local drafted the plan and the brief');
  assert.equal(log.claude.length, 2, 'Claude reviewed both');
  assert.match(log.claude[0], /research plan[\s\S]*Do not use any tools[\s\S]*```json/);
  assert.equal(log.local[0].opts.format.properties.research.items.properties.agent.enum.join(), 'codex,claude', 'the plan schema only offers ready agents');
  assert.deepEqual(log.research[0].map((j) => [j.id, j.agent]), [['market', 'codex'], ['tech', 'claude']]);
  // The brief step saw the research.
  assert.match(log.local[1].messages.at(-1).content, /market findings[\s\S]*tech findings/);
  assert.deepEqual(log.build.map((b) => [b.job.role, b.job.agent, b.dir]), [['build', 'claude', '/projects/campus-free-food-finder'], ['review', 'codex', '/projects/campus-free-food-finder']]);
  assert.equal(log.asked.length, 2, 'two checkpoints');
  assert.equal(log.saved.status, 'built and verified');
  assert.equal(log.saved.slug, 'campus-free-food-finder');
});

test('checkpoints: cancel stops before anything runs; feedback revises; folder moves the build', async () => {
  const c = io({ replies: ['cancel'] });
  const m1 = await runMission('build x', c.io);
  assert.equal(m1.status, 'cancelled at the plan');
  assert.equal(c.log.research.length, 0);
  assert.ok(c.log.saved, 'still saved, so the plan is not lost');

  const r = io({ replies: ['add a job on pricing', 'go', 'folder D:\\work\\food', 'go'] });
  const m2 = await runMission('build x', r.io);
  assert.equal(m2.status, 'built and verified');
  assert.equal(r.log.local.length, 3, 'plan, revised plan, brief');
  assert.match(r.log.local[1].messages.at(-1).content, /Revise the plan: add a job on pricing/);
  assert.equal(r.log.build[0].dir, 'D:\\work\\food');

  const b = io({ replies: ['go', 'cancel'] });
  const m3 = await runMission('build x', b.io);
  assert.equal(m3.status, 'cancelled before the build');
  assert.equal(b.log.research.length, 1, 'research ran');
  assert.equal(b.log.build.length, 0, 'nothing was built');
  assert.ok(b.log.saved.build.brief, 'the brief is saved');
});

test('a bad Claude review falls back to the local draft; a bad local plan stops', async () => {
  const x = io({ claude: () => ({ ok: true, text: 'Sure! Here are my thoughts...' }) });
  const m = await runMission('build x', x.io);
  assert.equal(m.status, 'built and verified');
  assert.ok(x.log.status.some((s) => /not usable/.test(s)));
  const y = io({ local: () => 'not json at all' });
  const m2 = await runMission('build x', y.io);
  assert.match(m2.status, /did not produce a plan/);
  assert.equal(y.log.claude.length, 0);
});

test('no brief from the local model: Claude writes it from the research; neither stops', async () => {
  const local = (n) => (n === 1 ? JSON.stringify(PLAN) : '');
  const x = io({ local });
  const m = await runMission('build x', x.io);
  assert.equal(m.status, 'built and verified');
  assert.ok(x.log.status.some((s) => /Claude is writing it/.test(s)));
  assert.doesNotMatch(x.log.claude[1], /## Draft/);
  assert.match(x.log.claude[1], /market findings/);
  const y = io({ local, claude: (n, p) => (p.includes('research plan') ? { ok: true, text: JSON.stringify(PLAN) } : { ok: false, text: '' }) });
  assert.match((await runMission('build x', y.io)).status, /neither the local model nor Claude produced a brief/);
});

test('research and build failures stop the mission and say where', async () => {
  const r = io({ research: (jobs) => jobs.map((j) => ({ id: j.id, agent: j.agent, ok: false, text: '' })) });
  assert.match((await runMission('build x', r.io)).status, /every research job failed/);
  const b = io({ build: (job) => ({ ok: job.role !== 'build', text: 'boom' }) });
  const m = await runMission('build x', b.io);
  assert.equal(m.status, 'failed at build (claude)');
  assert.equal(b.log.build.length, 1, 'the review did not run on a failed build');
});

test('model output is made runnable: unknown agents, duplicate ids, empty prompts, roles', () => {
  const p = normalizePlan({ title: 'T', build_intent: 'b', research: [
    { id: 'Market Fit', agent: 'gpt4', purpose: 'p', prompt: 'x' }, { id: 'market fit', agent: 'claude', purpose: 'p', prompt: 'y' }, { id: 'z', agent: 'claude', purpose: 'p', prompt: '' },
  ] }, agents);
  assert.deepEqual(p.research.map((j) => [j.id, j.agent]), [['market-fit', 'codex'], ['market-fit-2', 'claude']]);
  assert.equal(normalizePlan({ research: [] }, agents), null);
  const b = normalizeBuild({ brief: 'b', build: [{ id: 'a', agent: 'gemini', role: 'review', prompt: 'p' }, { id: 'c', agent: 'codex', role: 'weird', prompt: 'q' }] }, agents);
  assert.deepEqual(b.build.map((j) => [j.role, j.agent]), [['build', 'claude'], ['review', 'codex']]);
  assert.equal(normalizeBuild({ brief: 'b', build: [] }, agents), null);
});

test('json from replies, plan rendering, schema, review prompt, saved markdown', () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a":1}\n```\nthanks'), { a: 1 });
  assert.deepEqual(extractJson('prefix {"b":2} suffix'), { b: 2 });
  assert.equal(extractJson('nothing'), null);
  assert.match(renderPlan(PLAN), /1\. codex\s+Market and competitors[\s\S]*2\. claude/);
  assert.deepEqual(planSchema(['claude']).properties.research.items.properties.agent.enum, ['claude']);
  assert.match(reviewPlanPrompt('g', PLAN, agents), /cannot run surveys/);
  const md = missionMarkdown({ goal: 'g', date: '2026-10-12', status: 'built', plan: PLAN, build: BUILD, workdir: '/p', results: [{ id: 'market', agent: 'codex', ok: true, text: 'found' }], outcomes: [{ role: 'build', agent: 'claude', ok: true, text: 'made it' }] });
  for (const s of ['# Campus Free Food Finder', '## Research brief', '## Build prompts', '### Research job: market (codex)', '## Research results', 'made it', 'Built in: `/p`']) assert.ok(md.includes(s), s);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-m-'));
  const out = writeMissionFolder(dir, { goal: 'g', date: '2026-10-12', slug: 'food', status: 'built', plan: PLAN });
  assert.equal(path.basename(out), '2026-10-12-food');
  assert.match(fs.readFileSync(path.join(out, 'mission.md'), 'utf8'), /Campus Free Food Finder/);
});

// ---- verify and fix -------------------------------------------------------------------
test('verify-and-fix: failing tests go back to the builder in a fix round, then it passes', async () => {
  const x = io({ verify: (n) => (n === 1 ? { ran: true, ok: false, command: 'npm test', summary: 'not ok 1 - converts -40' } : { ran: true, ok: true, command: 'npm test' }) });
  const m = await runMission('build x', x.io);
  assert.equal(m.status, 'built and verified');
  const fix = x.log.build.find((b) => b.job.role === 'fix');
  assert.equal(fix.job.agent, 'claude', 'the builder fixes its own work');
  assert.match(fix.job.prompt, /Fix round 1[\s\S]*not ok 1 - converts -40[\s\S]*do not weaken or delete tests/);
  assert.equal(m.rounds.length, 2);
  assert.equal(m.rounds[0].fixer, 'claude');
  // The reviewer saw the test result and was told to give a verdict.
  assert.match(x.log.build.find((b) => b.job.role === 'review').job.prompt, /tests fail[\s\S]*Do not change any files[\s\S]*"verdict"/);
});

test('verify-and-fix: a reviewer\'s fail verdict lists issues; the fix gets them', async () => {
  let reviews = 0;
  const x = io({ build: (job) => ({ ok: true, text: job.role === 'review' ? (++reviews === 1 ? verdict('fail', ['cli.py: -40 parsed as a flag']) : verdict('pass')) : 'done' }) });
  const m = await runMission('build x', x.io);
  assert.equal(m.status, 'built and verified');
  assert.match(x.log.build.find((b) => b.job.role === 'fix').job.prompt, /codex: cli\.py: -40 parsed as a flag/);
});

test('verify-and-fix: stuck on the same problem, another agent takes over; past the cap the user decides', async () => {
  const failing = () => ({ ran: true, ok: false, command: 'npm test', summary: 'not ok 3 - rounds 37 to 98.6' });
  const x = io({ verify: failing, replies: ['go', 'go', 'accept'], extra: { nextAgent: (a) => (a === 'claude' ? 'codex' : 'claude') } });
  const m = await runMission('build x', x.io, { fixRounds: 3 });
  const fixers = x.log.build.filter((b) => b.job.role === 'fix').map((b) => b.job.agent);
  assert.deepEqual(fixers, ['claude', 'codex', 'claude'], 'same failure after a fix: the next agent takes over');
  assert.match(x.log.asked.at(-1), /more .* accept .* stop/);
  assert.equal(m.status, 'built, accepted with 1 open issue');
  const y = io({ verify: failing, replies: ['go', 'go', 'more', 'stop'] });
  const m2 = await runMission('build x', y.io, { fixRounds: 1 });
  assert.equal(y.log.build.filter((b) => b.job.role === 'fix').length, 2, '"more" gave another round');
  assert.match(m2.status, /^needs you: 1 open issue after 2 fix rounds/);
});

test('verify: no tests and no verdict is reported, never called verified', async () => {
  const x = io({ verify: () => ({ ran: false }), build: (job) => ({ ok: true, text: job.role === 'review' ? 'Looks fine to me.' : 'done' }) });
  const m = await runMission('build x', x.io);
  assert.equal(m.status, 'built, partly verified (no tests ran; codex: no verdict)');
  assert.equal(x.log.build.filter((b) => b.job.role === 'fix').length, 0, 'nothing concrete to fix');
});

test('verdicts: last json block wins; bare json; none', () => {
  assert.deepEqual(parseVerdict('```json\n{"verdict":"fail","issues":["a"]}\n```\nlater\n```json\n{"verdict":"pass","issues":[]}\n```'), { pass: true, issues: [] });
  assert.deepEqual(parseVerdict('ok {"verdict":"FAIL","issues":["x", ""]}'), { pass: false, issues: ['x'] });
  assert.equal(parseVerdict('no verdict here'), null);
  assert.equal(parseVerdict('```json\n{"verdict":"maybe"}\n```'), null);
});

// ---- resume and budget ------------------------------------------------------------------
test('resume: checkpoints after each phase; a paused mission carries on from its phase', async () => {
  // The build hits a session limit: paused, not failed, and not saved yet.
  const x = io({ build: () => ({ ok: false, text: '', paused: true }) });
  const m = await runMission('build x', x.io);
  assert.equal(m.paused, true);
  assert.match(m.status, /^paused: claude hit its limit during the build/);
  assert.equal(x.log.saved, null, 'a paused mission is checkpointed, not saved');
  assert.deepEqual([...new Set(x.log.checkpoints.map((c) => c.phase))], ['research', 'brief', 'build']);
  // Resumed: no plan, no research, no brief questions; straight to the build.
  const state = structuredClone(x.log.checkpoints.at(-1));
  const y = io({ replies: [] });
  const m2 = await runMission(state.goal, y.io, { state });
  assert.equal(m2.status, 'built and verified');
  assert.equal(y.log.local.length + y.log.claude.length + y.log.research.length + y.log.asked.length, 0);
  assert.equal(y.log.build[0].job.role, 'build');
  assert.equal(m2.done, true);
});

test('resume in research: only the jobs without an answer run again', async () => {
  const x = io({ replies: ['go', 'cancel'], research: (jobs) => jobs.map((j) => ({ id: j.id, agent: j.agent, ok: j.id === 'market', text: j.id === 'market' ? 'market findings' : '', paused: j.id !== 'market' })) });
  await runMission('build x', x.io);
  const state = structuredClone(x.log.checkpoints.find((c) => c.phase === 'research'));
  state.results = [{ id: 'market', agent: 'codex', ok: true, text: 'market findings' }];
  const y = io({ replies: ['cancel'] });
  const m = await runMission(state.goal, y.io, { state });
  assert.deepEqual(y.log.research[0].map((j) => j.id), ['tech']);
  assert.deepEqual(m.results.map((r) => r.id), ['market', 'tech'], 'plan order kept');
});

test('budget: over the limit, the user can pause, switch agent, or go (once per agent)', async () => {
  const over = (a) => (a === 'claude' ? 'claude is at 91% of its 5-hour limit' : null);
  const p = io({ replies: ['go', 'pause'], extra: { budget: over } });
  const m = await runMission('build x', p.io);
  assert.match(m.status, /^paused: you paused it/);
  assert.match(p.log.asked.at(-1), /91% of its 5-hour limit\. go \/ use <agent> \/ pause/);
  const s = io({ replies: ['go', 'use codex', 'go', 'go'], extra: { budget: over } });
  const m2 = await runMission('build x', s.io);
  assert.equal(m2.status, 'built and verified');
  assert.equal(s.log.research[0].find((j) => j.id === 'tech').agent, 'codex', 'switched for the research');
  assert.equal(s.log.build[0].job.agent, 'claude', '"go" at the build: claude builds');
  assert.equal(s.log.asked.filter((q) => /5-hour limit/.test(q)).length, 2, 'asked once for the research, once for the build; the go holds after that');
});

// ---- lessons -----------------------------------------------------------------------------
test('lessons: earlier ones go into the prompts; new ones are written at the end, not when cancelled at the plan', async () => {
  const lessons = '- Ask codex for download counts, not stars.';
  const reflected = [];
  const reflect = async (p) => { reflected.push(p); return '```json\n{"lessons":["Have the builder test negative numbers first."]}\n```'; };
  const x = io({ extra: { lessons, reflect } });
  const m = await runMission('build x', x.io);
  assert.match(x.log.local[0].messages[0].content, /Lessons from earlier missions[\s\S]*download counts/);
  assert.match(x.log.claude[0], /download counts/);
  assert.match(x.log.local[1].messages[0].content, /download counts/);
  assert.deepEqual(m.lessons, ['Have the builder test negative numbers first.']);
  assert.match(reflected[0], /Status: built and verified[\s\S]*Verify rounds/);
  assert.match(missionMarkdown(m), /## Lessons\n\n- Have the builder test negative numbers first\./);
  const c = io({ replies: ['cancel'], extra: { reflect } });
  await runMission('build x', c.io);
  assert.equal(reflected.length, 1, 'nothing to learn from a cancelled plan');
});

test('lessons: parsing and the newest-first cap', () => {
  assert.deepEqual(parseLessons('```json\n{"lessons":["a  b", "", "c"]}\n```'), ['a b', 'c']);
  assert.deepEqual(parseLessons('nope'), []);
  const md = ['# L', '## d1', ...Array.from({ length: 14 }, (_, i) => `- lesson ${i}`)].join('\n');
  assert.equal(recentLessons(md).split('\n').length, 10);
  assert.match(recentLessons(md), /lesson 13$/);
  assert.equal(recentLessons(md, { chars: 30 }).split('\n').length, 2);
  assert.doesNotMatch(planMessages('g', { agents })[0].content, /Lessons/);
});

// ---- parallel parts --------------------------------------------------------------------
test('parts: kept only when each owns separate paths; a build with parts runs through runParts', async () => {
  const parts = [{ id: 'cli', agent: 'claude', owns: ['src/cli/', './tests/cli'], prompt: 'CLI' }, { id: 'Web', agent: 'codex', owns: ['web/**'], prompt: 'page' }];
  const b = normalizeBuild({ brief: 'b', test_command: 'npm test', build: [{ id: 'build', agent: 'claude', role: 'build', prompt: 'p', parts }] }, agents);
  assert.deepEqual(b.build[0].parts.map((p) => [p.id, p.owns]), [['cli', ['src/cli', 'tests/cli']], ['web', ['web']]]);
  assert.equal(b.test_command, 'npm test');
  assert.match(renderBuild(b, '/p'), /in 2 parallel parts[\s\S]*cli owns src\/cli, tests\/cli[\s\S]*npm test/);
  const overlap = normalizeBuild({ brief: 'b', build: [{ role: 'build', agent: 'claude', prompt: 'p', parts: [{ id: 'a', owns: ['src'], prompt: 'x' }, { id: 'b', owns: ['src/web'], prompt: 'y' }] }] }, agents);
  assert.equal(overlap.build[0].parts, undefined, 'overlapping ownership: one sequential build');
  assert.equal(normalizeBuild({ brief: 'b', build: [{ role: 'build', agent: 'claude', prompt: 'p', parts: [{ id: 'a', owns: [], prompt: 'x' }, { id: 'b', owns: ['w'], prompt: 'y' }] }] }, agents).build[0].parts, undefined);
  assert.equal(normalizeBuild({ brief: 'b', test_command: 'npm test\nrm -rf /', build: [{ role: 'build', prompt: 'p' }] }, agents).test_command, undefined);
  assert.ok(partsOverlap(['a/b'], ['a']) && !partsOverlap(['ab'], ['a']));
  assert.match(buildMessages('g', { agents, plan: PLAN, results: [] })[0].content, /test_command[\s\S]*"parts"[\s\S]*"owns"/);

  const ran = [];
  const BP = { ...BUILD, build: [{ ...BUILD.build[0], parts: b.build[0].parts }, BUILD.build[1]] };
  const x = io({
    claude: (n, p) => ({ ok: true, text: '```json\n' + JSON.stringify(p.includes('research plan') ? PLAN : BP) + '\n```' }),
    extra: { runParts: async (job, dir) => { ran.push({ job, dir }); return { ok: true, text: 'parts merged', agent: job.agent }; } },
  });
  const m = await runMission('build x', x.io);
  assert.equal(m.status, 'built and verified');
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0].job.parts.map((p) => p.id), ['cli', 'web']);
  assert.ok(!x.log.build.some((b2) => b2.job.role === 'build'), 'not built a second time sequentially');
});

test('state store: save, list unfinished newest first, find by number or name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-ms-'));
  const s = missionStateStore(dir);
  const a = { goal: 'build a', date: '2026-10-12', slug: 'a', phase: 'research', status: 'researching', plan: { title: 'Alpha' } };
  const b = { goal: 'build b', date: '2026-10-12', slug: 'b', phase: 'build', status: 'paused: limit' };
  const c = { goal: 'build c', date: '2026-10-12', slug: 'c', phase: 'verify', status: 'built and verified', done: true };
  s.save(a); s.save(c); s.save(b);
  assert.deepEqual(s.list().map((m) => m.slug).sort(), ['a', 'b']);
  assert.equal(s.find('alpha').slug, 'a');
  assert.equal(s.find('1').slug, s.list()[0].slug);
  assert.equal(s.find('zzz'), null);
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')));
});

test('verify: a blocked reviewer never passes the build; another agent checks instead', async () => {
  const blocked = verdict('blocked', ['the folder could not be opened']);
  const x = io({ build: (job) => ({ ok: true, text: job.role !== 'review' ? 'done' : job.agent === 'codex' ? blocked : verdict('pass') }),
    extra: { nextAgent: (a) => (a === 'codex' ? 'claude' : 'codex') } });
  const m = await runMission('build x', x.io);
  assert.equal(m.status, 'built and verified');
  assert.deepEqual(x.log.build.filter((b) => b.job.role === 'review').map((b) => b.job.agent), ['codex', 'claude']);
  assert.ok(x.log.status.some((s) => /codex could not check the build \(the folder could not be opened\); claude checks it instead/.test(s)));
  // No other agent: reported, not passed, not sent to the builder as a defect.
  const y = io({ build: (job) => ({ ok: true, text: job.role === 'review' ? blocked : 'done' }) });
  const m2 = await runMission('build x', y.io);
  assert.equal(m2.status, 'built, partly verified (codex: blocked (the folder could not be opened))');
  assert.equal(y.log.build.filter((b) => b.job.role === 'fix').length, 0);
  assert.deepEqual(parseVerdict('```json\n{"verdict":"blocked","issues":["no access"]}\n```'), { pass: false, blocked: true, issues: ['no access'] });
});

test('an interrupted research job pauses the mission; a resume runs only the jobs without an answer', async () => {
  const x = io({ research: (jobs) => jobs.map((j) => (j.id === 'market' ? { id: j.id, agent: j.agent, ok: false, text: 'I will research…', interrupted: true } : { id: j.id, agent: j.agent, ok: true, text: 'tech findings' })) });
  const m = await runMission('build x', x.io);
  assert.equal(m.paused, true);
  assert.match(m.status, /paused: interrupted/);
  assert.equal(m.done, undefined, 'not finished, so no lessons and nothing saved as failed');
  assert.equal(x.log.saved, null);
  const y = io({ replies: ['go'] });
  const m2 = await runMission('build x', y.io, { state: structuredClone(m) });
  assert.deepEqual(y.log.research[0].map((j) => j.id), ['market'], 'only the interrupted job runs again');
  assert.equal(m2.status, 'built and verified');
});

test('a research job that fails retries once on another agent, and the note says why', async () => {
  let calls = 0;
  const x = io({
    research: (jobs) => { calls++; return jobs.map((j) => (j.id === 'market' && j.agent === 'codex' ? { id: j.id, agent: j.agent, ok: false, text: '', errors: ['codex exited with code 1: sandbox could not open the folder'] } : { id: j.id, agent: j.agent, ok: true, text: `${j.id} by ${j.agent}` })); },
    extra: { nextAgent: (a) => (a === 'codex' ? 'claude' : 'codex') },
  });
  const m = await runMission('build x', x.io);
  assert.equal(calls, 2);
  assert.deepEqual(x.log.research[1].map((j) => [j.id, j.agent]), [['market', 'claude']]);
  const market = m.results.find((r) => r.id === 'market');
  assert.equal(market.ok, true);
  assert.equal(market.retriedFrom, 'codex');
  assert.match(missionMarkdown(m), /Retried on claude after codex failed: codex exited with code 1: sandbox/);
});

test('a failed job shows its reason in the saved note and in the lessons prompt', async () => {
  const x = io({
    research: (jobs) => jobs.map((j) => ({ id: j.id, agent: j.agent, ok: false, text: '', errors: [j.id === 'market' ? 'timed out after 20m' : 'usage limit reached'], timedOut: j.id === 'market' })),
    extra: { reflect: async (p) => { x.prompt = p; return '```json\n{"lessons":[]}\n```'; } },
  });
  const m = await runMission('build x', x.io);
  assert.match(m.status, /every research job failed/);
  const md = missionMarkdown(m);
  assert.match(md, /\*\*Failed:\*\* timed out after 20m/);
  assert.match(md, /\*\*Failed:\*\* usage limit reached/);
  assert.match(x.prompt, /market by codex: failed \(timed out after 20m\)/);
  assert.match(x.prompt, /must name the cause/);
});

test('an interrupted build or fix pauses instead of failing', async () => {
  const b = io({ build: (job) => (job.role === 'build' ? { ok: false, text: '', interrupted: true } : { ok: true, text: verdict('pass') }) });
  const m = await runMission('build x', b.io);
  assert.equal(m.paused, true);
  assert.equal(m.phase, 'build');
  assert.equal(m.outcomes.length, 0);
  let n = 0;
  const f = io({ build: (job) => (job.role === 'review' ? { ok: true, text: n++ ? verdict('pass') : verdict('fail', ['a.js: broken']) } : job.role === 'fix' ? { ok: false, text: '', interrupted: true } : { ok: true, text: 'built' }) });
  const m2 = await runMission('build x', f.io);
  assert.equal(m2.paused, true);
  assert.equal(m2.rounds.length, 0, 'the unfinished round is redone on resume');
});

test('a research-only goal ends with the brief: no build prompts, no build, status "researched"', async () => {
  const plan = { ...PLAN, build_intent: 'none' };
  const x = io({
    replies: ['go', 'ok'],
    local: (n) => JSON.stringify(n === 1 ? plan : { brief: '# Add these\n- export' }),
    claude: (n, p) => ({ ok: true, text: '```json\n' + JSON.stringify(n === 1 ? plan : { brief: '# Add these (checked)\n- export, from market' }) + '\n```' }),
    extra: { project: { name: 'myapp', dir: '/code/myapp' }, branch: async () => { throw new Error('no branch for research'); } },
  });
  const m = await runMission('look at myapp and tell me what to add', x.io);
  assert.equal(m.status, 'researched');
  assert.equal(researchOnly(m.plan), true);
  assert.equal(x.log.build.length, 0);
  assert.equal(m.build.brief, '# Add these (checked)\n- export, from market');
  assert.match(x.log.local[0].messages[0].content, /existing project, "myapp", at \/code\/myapp/);
  assert.match(x.log.local[0].messages[0].content, /build_intent is exactly "none"/);
  assert.match(x.log.asked[0], /nothing gets built/);
  const md = missionMarkdown(m);
  assert.match(md, /## Brief\n\n# Add these \(checked\)/);
  assert.doesNotMatch(md, /Build prompts|Built in/);
});

test('a build goes on its own branch, commits after the build and each fix, and offers a PR', async () => {
  const commits = [];
  let n = 0;
  const x = io({
    replies: ['go', 'go', 'yes'],
    build: (job) => (job.role === 'review' ? { ok: true, text: n++ ? verdict('pass') : verdict('fail', ['a.js: broken']) } : { ok: true, text: `${job.role} done` }),
    extra: {
      branch: async (m) => ({ branch: `friday/${m.slug}` }),
      commit: async (m, msg) => commits.push(msg),
      canPr: () => true,
      pr: async (m, body) => { x.body = body; return 'https://github.com/u/r/pull/1'; },
    },
  });
  const m = await runMission('build x', x.io);
  assert.equal(m.status, 'built and verified');
  assert.equal(m.branch, 'friday/campus-free-food-finder');
  assert.deepEqual(commits, ['FRIDAY mission: build (claude)', 'FRIDAY mission: fix round 1 (claude)']);
  assert.equal(m.pr, 'https://github.com/u/r/pull/1');
  assert.match(x.body, /## Brief[\s\S]*\| 1 \| pass \| codex: fail \| 1 \|[\s\S]*\| 2 \| pass \| codex: pass \| 0 \|/);
  assert.match(missionMarkdown(m), /on branch `friday\/campus-free-food-finder`[\s\S]*Pull request: https/);

  const d = io({ extra: { branch: async () => ({ error: '/r has uncommitted changes; commit or stash them, then /mission resume' }) } });
  const m2 = await runMission('build x', d.io);
  assert.equal(m2.paused, true);
  assert.match(m2.status, /uncommitted changes/);
  assert.equal(d.log.build.length, 0);

  const no = io({ replies: ['go', 'go', 'no'], extra: { canPr: () => true, pr: async () => { throw new Error('should not open'); } } });
  const m3 = await runMission('build x', no.io);
  assert.equal(m3.pr, undefined);
  assert.equal(prBody(m3).startsWith('FRIDAY mission: build x'), true);
});

test('overflow: an agent past its limit hands the job to the one with the most room, and the note says so', async () => {
  const used = { claude: 0.92, codex: 0.4, gemini: null };
  const over = (a) => (used[a] >= 0.85 ? `${a} is at ${Math.round(used[a] * 100)}% of its 5-hour limit` : null);
  assert.equal(pickHeadroom('claude', ['claude', 'codex', 'gemini'], { over, used: (a) => used[a] }), 'codex');
  assert.equal(pickHeadroom('claude', ['claude', 'codex', 'gemini'], { over, used: (a) => used[a], ready: (a) => a !== 'codex' }), 'gemini', 'unknown use still counts');
  assert.equal(pickHeadroom('claude', ['claude'], { over }), null);

  const x = io({ extra: { budget: over, overflow: (a) => pickHeadroom(a, agents, { over, used: (b) => used[b] }), usage: () => ({ claude: { five_hour: used.claude, seven_day: 0.3, cost: 0 }, codex: { five_hour: used.codex, seven_day: null, cost: 0.5 } }) } });
  const m = await runMission('build x', x.io);
  assert.equal(m.status, 'built and verified');
  assert.equal(x.log.asked.length, 2, 'only the two approvals: no budget question');
  assert.deepEqual(x.log.research[0].map((j) => j.agent), ['codex', 'codex'], 'claude\'s research job moved');
  assert.equal(x.log.build[0].job.agent, 'codex');
  const md = missionMarkdown(m);
  assert.match(md, /## Moved to another agent\n\n- claude → codex: claude is at 92% of its 5-hour limit/);
  assert.match(md, /\| claude \| 92% → 92% \| 30% → 30% \| - \|/);
  assert.match(md, /\| codex \| 40% → 40% \| n\/a → n\/a \| - \|/);

  const y = io({ replies: ['go', 'pause'], extra: { budget: over } });
  const m2 = await runMission('build x', y.io);
  assert.equal(m2.paused, true, 'without overflow the user still decides');
  assert.match(y.log.asked[1], /claude is at 92%/);
  assert.match(usageTable({ a: { cost: 1 } }, { a: { cost: 3.5 } }), /\| a \| n\/a → n\/a \| n\/a → n\/a \| \$2\.50 \|/);
});
