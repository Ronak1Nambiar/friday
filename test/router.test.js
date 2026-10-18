import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_PROFILE, learn, liveProfile, loadProfile, migrate, readOverrides, recordOverride } from '../src/profile.js';
import { cloudBlock, describeRoute, isPrivate, parseCategory, route, routeCategory, sealedProject } from '../src/router.js';

// A profile with a sealed project, the way a user sets one up (the defaults seal nothing).
const sealedSetup = (p) => {
  p.private.sealed = ['sealedproj'];
  p.private.projects = ['sealedproj'];
  p.private.patterns = [...p.private.patterns, '\\bdataset-x\\b'];
  return p;
};
const profile = () => sealedSetup(structuredClone(DEFAULT_PROFILE));
// This machine: Gemini not logged in, Ollama not running.
const ready = (id) => !['gemini', 'ollama'].includes(id);
ready.why = (id) => (id === 'gemini' ? 'not logged in' : 'not running');
const go = (text, opts = {}) => route(text, { profile: profile(), ready, ...opts });

test('the six acceptance inputs route sensibly', () => {
  const t1 = go('Fix the failing test in myapp and have someone check the fix.');
  assert.equal(t1.kind, 'pipeline');
  assert.deepEqual(t1.steps.map((s) => [s.agent, s.role]), [['codex', 'implement'], ['claude', 'review']]);
  assert.equal(describeRoute(t1).split(' · ')[0], '-> codex, then claude reviews');

  const t2 = go('Summarize these 300 pages of MIMIC notes for SEALEDPROJ.');
  assert.equal(t2.private, true);
  assert.deepEqual(t2.steps, [{ agent: 'ollama', role: 'answer' }]); // even though Ollama is not running

  const t3 = go("What did I decide about the alpha project, and what's next?");
  assert.equal(t3.kind, 'single');
  assert.equal(t3.category, 'vault');
  assert.equal(t3.steps[0].agent, 'claude');

  assert.equal(go('From now on, route all research questions to Gemini.').kind, 'self');
  assert.equal(go('Add a panel to the HUD showing which agent handled each of the last 10 messages.').kind, 'self');

  const t6 = go('Redesign the MyApp workspace: inbox left, map center, conversation right, in the light look.');
  assert.equal(t6.kind, 'design');
  assert.deepEqual(t6.steps.map((s) => s.role), ['design', 'implement', 'review', 'resync']);
});

test('private data never routes to a cloud agent', () => {
  for (const t of ['clean the MIMIC-IV discharge summaries', 'look at patient 4411 vitals', 'sealedproj data: count the cohort',
    'is this PHI?', 'run the eval on dataset-x']) {
    const p = go(t);
    assert.equal(p.private, true, t);
    assert.equal(p.steps[0].agent, 'ollama', t);
  }
  // Focused on SEALEDPROJ, a data word is enough.
  assert.ok(isPrivate('summarize the notes', { profile: profile(), focus: 'SEALEDPROJ' }));
  // SEALEDPROJ is sealed (2026-10-12): even without a data word it stays local.
  assert.equal(go("what's the SEALEDPROJ timeline").private, true);
  assert.equal(go("what's the SEALEDPROJ timeline").steps[0].agent, 'ollama');
});

test('categories pick by strength, and fall back when an agent is missing', () => {
  const r = go('research the best sensor under $100');
  assert.equal(r.category, 'research');
  assert.equal(r.steps[0].agent, 'claude');
  assert.match(r.notes.join(), /gemini not logged in/);
  assert.equal(route('research the best lidar', { profile: profile(), ready: () => true }).steps[0].agent, 'gemini');
  assert.equal(go('rename these variables to camelCase').steps[0].agent, 'opencode');
  assert.equal(go('what does this stack trace mean').steps[0].agent, 'codex');
  assert.equal(go('write an email to the team about the release').category, 'writing');
  assert.equal(go('ask codex what it thinks of the parser').steps[0].agent, 'codex');
  assert.equal(go('what do you all think about the launch plan').kind, 'council');
  const plan = go('plan it out first, then implement the export feature and have claude review it');
  assert.deepEqual(plan.steps.map((s) => s.role), ['plan', 'implement', 'review']);
  assert.notEqual(plan.steps[1].agent, plan.steps[2].agent);
});

test('the profile is data: editing it changes the route', () => {
  const p = profile();
  p.categories.writing = { agent: 'opencode', fallback: [] };
  assert.equal(route('draft an email to the team', { profile: p, ready }).steps[0].agent, 'opencode');
  p.categories.research = { agent: 'gemini', fallback: [], strict: true };
  const blocked = route('research lidar prices', { profile: p, ready });
  assert.match(blocked.blocked, /gemini/);
  assert.match(describeRoute(blocked), /^-> gemini only/);
});

test('unsure messages are flagged for the model, and its answer re-routes', () => {
  const p = go('hmm, thoughts on this whole thing then');
  assert.equal(p.unsure, true);
  assert.equal(parseCategory('Category: research.'), 'research');
  assert.equal(parseCategory('longContext'), 'longContext');
  assert.equal(parseCategory('no idea'), null);
  assert.equal(routeCategory('simple', { profile: profile(), ready }).steps[0].agent, 'opencode');
});

test('profile file: written on first load, hot-reloaded on change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-prof-'));
  const live = liveProfile(dir);
  assert.equal(live.get().categories.research.agent, 'gemini');
  assert.ok(fs.existsSync(path.join(dir, 'profile.json')));
  const raw = JSON.parse(fs.readFileSync(live.file, 'utf8'));
  raw.categories.research.agent = 'claude';
  fs.writeFileSync(live.file, JSON.stringify(raw));
  fs.utimesSync(live.file, new Date(), new Date(Date.now() + 5000));
  assert.equal(live.get().categories.research.agent, 'claude');
  // A broken file keeps the defaults and says why.
  fs.writeFileSync(path.join(dir, 'profile.json'), '{nope');
  assert.match(loadProfile(dir).error, /profile\.json/);
});

test('repeated @agent overrides teach the profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-ovr-'));
  const p = profile();
  recordOverride(dir, { category: 'research', routed: 'gemini', chosen: 'claude' });
  recordOverride(dir, { category: 'research', routed: 'gemini', chosen: 'claude' });
  assert.equal(learn(p, readOverrides(dir), 'research'), null);
  recordOverride(dir, { category: 'research', routed: 'gemini', chosen: 'claude' });
  const l = learn(p, readOverrides(dir), 'research');
  assert.deepEqual({ ...l }, { category: 'research', from: 'gemini', to: 'claude', count: 3, of: 3 });
  // Once learned, the same overrides do not fire again.
  p.categories.research.agent = 'claude';
  assert.equal(learn(p, readOverrides(dir), 'research'), null);
  // Mixed overrides below the share do not teach.
  recordOverride(dir, { category: 'writing', chosen: 'codex' });
  recordOverride(dir, { category: 'writing', chosen: 'opencode' });
  recordOverride(dir, { category: 'writing', chosen: 'codex' });
  recordOverride(dir, { category: 'writing', chosen: 'opencode' });
  assert.equal(learn(profile(), readOverrides(dir), 'writing'), null);
});

test('old profiles drop the old 25 s router timeout, keep anything the user set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-mig-'));
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ version: 1, classifier: { agents: ['ollama', 'opencode'], timeoutMs: 25000 }, default: 'codex' }));
  const p = loadProfile(dir);
  assert.equal(p.classifier.timeoutMs, DEFAULT_PROFILE.classifier.timeoutMs);
  assert.equal(p.classifier.ollamaModel, 'qwen2.5:7b-instruct');
  assert.equal(p.default, 'codex');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'));
  assert.equal(saved.version, DEFAULT_PROFILE.version);
  assert.equal(saved.classifier.timeoutMs, undefined);
  const mine = { version: 1, classifier: { timeoutMs: 9000 } };
  assert.equal(migrate(mine), true);
  assert.equal(mine.classifier.timeoutMs, 9000, 'a value the user chose is kept');
  assert.equal(migrate(mine), false, 'runs once');
});

test('nothing is sealed by default; the sealed lists a profile holds are never touched', () => {
  assert.deepEqual(DEFAULT_PROFILE.private.sealed, []);
  assert.deepEqual(DEFAULT_PROFILE.private.projects, []);
  // An older profile keeps its own lists through the migration, even an empty one.
  const mine = { version: 2, private: { sealed: ['secret'], projects: [], patterns: ['x'] } };
  migrate(mine);
  assert.deepEqual(mine.private, { sealed: ['secret'], projects: [], patterns: ['x'] });
  assert.equal(mine.version, DEFAULT_PROFILE.version);
  // A fresh install gets the defaults written out in full, so its lists are explicit
  // from then on (a later change of defaults cannot unseal anything).
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-fresh-'));
  assert.deepEqual(loadProfile(fresh).private.sealed, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fresh, 'profile.json'), 'utf8')).private.sealed, [], 'written down');
  // The user's arrays win over the defaults' arrays when merged.
  fs.writeFileSync(path.join(fresh, 'profile.json'), JSON.stringify({ version: 3, private: { sealed: ['a', 'b'] } }));
  assert.deepEqual(loadProfile(fresh).private.sealed, ['a', 'b']);
});

test('SEALEDPROJ is sealed: any mention, focus or folder keeps it off every cloud agent', () => {
  const profile = sealedSetup(structuredClone(DEFAULT_PROFILE));
  const dirs = [String.raw`C:\Users\me\Downloads\sealedproj-repo`];
  // Mentions alone are enough now (no data word needed), in any phrasing.
  for (const m of ['fix the loader bug in SEALEDPROJ', 'sealedproj: refactor the eval script', 'what is next for Sealedproj?', "summarize sealedproj's README"]) {
    assert.equal(sealedProject(m, { profile }), 'sealedproj', m);
    const p = route(m, { profile });
    assert.equal(p.private, true, m);
    assert.equal(p.sealed, 'sealedproj', m);
    assert.equal(p.steps[0].agent, 'ollama', m);
  }
  // Focused on SEALEDPROJ: even a message that does not name it.
  assert.equal(route('refactor the eval script', { profile, focus: 'sealedproj-repo' }).sealed, 'sealedproj');
  // The last line of defence, for every cloud agent; Ollama is never blocked.
  for (const agent of ['claude', 'codex', 'gemini', 'opencode']) {
    assert.match(cloudBlock({ agent, text: 'review sealedproj', cwd: String.raw`C:\x`, profile }), /sealed/);
    assert.match(cloudBlock({ agent, text: 'review this', cwd: String.raw`C:\Users\me\Downloads\sealedproj-repo\src`, profile, sealedDirs: dirs }), /sealed project/);
    assert.match(cloudBlock({ agent, text: 'review this', cwd: 'c:/users/me/downloads/sealedproj-repo', profile, sealedDirs: dirs }), /sealed project/);
    assert.equal(cloudBlock({ agent, text: 'review this', cwd: String.raw`C:\Users\me\Downloads\sealedproj-repo-old`, profile, sealedDirs: dirs }), null, 'a sibling folder is not inside');
  }
  assert.equal(cloudBlock({ agent: 'ollama', text: 'review sealedproj', cwd: dirs[0], profile, sealedDirs: dirs }), null);
  // Unrelated work is untouched.
  assert.equal(route('fix the failing test in myapp', { profile }).private, false);
  assert.equal(sealedProject('the sealedprojing layer', { profile }), null, 'whole word only');
});
