import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_PROFILE, liveProfile } from '../src/profile.js';
import { route } from '../src/router.js';
import { applySettingsChange, codeChange, createSelfHistory, parseSettingsChange, testFailureSummary, undoSelf } from '../src/selfmod.js';

const profile = () => structuredClone(DEFAULT_PROFILE);
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('settings requests parse into profile edits', () => {
  const r = parseSettingsChange('From now on, route all research questions to Gemini.', profile());
  assert.deepEqual(r.ops, [{ path: ['categories', 'research'], value: { agent: 'gemini', fallback: [], strict: true } }]);
  assert.match(r.summary, /research: gemini \(fallback claude\) -> gemini only/);

  const w = parseSettingsChange('use opencode for writing', profile());
  assert.deepEqual(w.ops[0].value, { agent: 'opencode', fallback: ['claude'] });

  const rev = parseSettingsChange('from now on claude should do the reviews', profile());
  assert.equal(rev.ops.find((o) => o.path[0] === 'categories').value.agent, 'claude');
  assert.deepEqual(rev.ops.filter((o) => o.path[0] === 'pipelines').map((o) => [o.path[1], o.value.role, o.value.agent]),
    [['implementReview', 'review', 'claude'], ['planImplementReview', 'review', 'claude']].filter(([k]) => DEFAULT_PROFILE.pipelines[k].find((s) => s.role === 'review').agent !== 'claude'));
  assert.ok(parseSettingsChange('codex reviews from now on', profile()).ops.every((o) => o.path[0] === 'pipelines' && o.value.agent === 'codex'));

  assert.deepEqual(parseSettingsChange('tell codex to always run the tests first', profile()).ops,
    [{ path: ['instructions', 'codex'], value: ['always run the tests first'] }]);
  assert.equal(parseSettingsChange('stop auto routing', profile()).ops[0].value, 'manual');
  assert.deepEqual(parseSettingsChange('make codex purple', profile()).ops, [{ path: ['colors', 'codex'], value: [170, 120, 255] }]);
  assert.deepEqual(parseSettingsChange('from now on keep answers under 10 lines', profile()).ops[0].path, ['instructions', 'all']);
  assert.match(parseSettingsChange('send patient data to claude', profile()).refuse, /stays on this machine/);
  // Feature requests are code, not settings.
  assert.equal(parseSettingsChange('Add a panel to the HUD showing which agent handled each of the last 10 messages.', profile()), null);
});

test('settings change: live on the next route, logged in history, undone by /undo-self', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-self-'));
  const store = liveProfile(dir);
  const history = createSelfHistory(dir);
  const text = 'From now on, route all writing to opencode.';
  const ready = () => true;
  assert.equal(route('draft an email to the team', { profile: store.get(), ready }).steps[0].agent, 'claude');
  applySettingsChange({ profileStore: store, history, text, change: parseSettingsChange(text, store.get()) });
  assert.equal(route('draft an email to the team', { profile: store.get(), ready }).steps[0].agent, 'opencode');
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).categories.writing.agent, 'opencode');
  assert.equal(history.last().text, text);

  const u = undoSelf({ history, profileStore: store });
  assert.ok(u.ok && !u.restart);
  assert.deepEqual(store.get().categories.writing, DEFAULT_PROFILE.categories.writing);
  assert.equal(route('draft an email to the team', { profile: store.get(), ready }).steps[0].agent, 'claude');
  assert.equal(history.last(), null);
  assert.equal(undoSelf({ history, profileStore: store }).ok, false);
});

// A tiny FRIDAY-like repo: src/greet.js and a test that pins its output.
function repoFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-src-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(repo, 'src/greet.js'), "export const greet = () => 'hi';\n");
  fs.writeFileSync(path.join(repo, 'test/greet.test.js'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { greet } from '../src/greet.js';\ntest('greet', () => assert.equal(greet(), 'hi'));\n");
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false'); // Windows' default would check out CRLF
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  return repo;
}

test('code change: agent edits a worktree branch, tests pass, branch lands, undo reverts', async () => {
  const repo = repoFixture();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-cfg-'));
  const history = createSelfHistory(cfg);
  const base = git(repo, 'rev-parse', 'HEAD');
  let sawPrompt = '';
  let agentDir = '';
  const res = await codeChange({
    repo, configDir: cfg, history, text: 'say hello instead of hi',
    runAgent: async (dir, prompt) => {
      agentDir = dir;
      sawPrompt = prompt;
      // The running checkout is untouched while the agent works.
      assert.equal(fs.readFileSync(path.join(repo, 'src/greet.js'), 'utf8'), "export const greet = () => 'hi';\n");
      fs.writeFileSync(path.join(dir, 'src/greet.js'), "export const greet = () => 'hello';\n");
      fs.writeFileSync(path.join(dir, 'test/greet.test.js'), fs.readFileSync(path.join(dir, 'test/greet.test.js'), 'utf8').replace("'hi'", "'hello'"));
      return { ok: true, text: 'changed greet' };
    },
  });
  assert.ok(res.ok, res.why);
  assert.match(sawPrompt, /say hello instead of hi/);
  assert.match(res.entry.branch, /^friday-self\/\d{12}-say-hello-instead-of-hi$/);
  assert.deepEqual(res.entry.files.sort(), ['src/greet.js', 'test/greet.test.js']);
  assert.equal(res.entry.tests, '1 pass');
  assert.equal(fs.readFileSync(path.join(repo, 'src/greet.js'), 'utf8'), "export const greet = () => 'hello';\n");
  assert.equal(git(repo, 'rev-parse', 'HEAD'), res.entry.head);
  assert.ok(!fs.existsSync(agentDir), 'worktree removed');

  const u = undoSelf({ history, profileStore: null, repo });
  assert.ok(u.ok && u.restart, u.why);
  assert.equal(fs.readFileSync(path.join(repo, 'src/greet.js'), 'utf8'), "export const greet = () => 'hi';\n");
  assert.equal(git(repo, 'diff', base, 'HEAD'), '');
});

test('code change with failing tests changes nothing and says why', async () => {
  const repo = repoFixture();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-cfg-'));
  const history = createSelfHistory(cfg);
  const head = git(repo, 'rev-parse', 'HEAD');
  let agentDir = '';
  const res = await codeChange({
    repo, configDir: cfg, history, text: 'break greet',
    runAgent: async (dir) => { agentDir = dir; fs.writeFileSync(path.join(dir, 'src/greet.js'), "export const greet = () => 'bye';\n"); return { ok: true, text: '' }; },
  });
  assert.equal(res.ok, false);
  assert.match(res.why, /tests failed, nothing changed/);
  assert.match(res.why, /not ok|✖|fail/i);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(repo, 'src/greet.js'), 'utf8'), "export const greet = () => 'hi';\n");
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'branch', '--list', 'friday-self/*'), '');
  assert.ok(!fs.existsSync(agentDir));
  assert.match(fs.readFileSync(res.patch, 'utf8'), /'bye'/);
  assert.equal(history.list().length, 0);
});

test('code change refuses a dirty checkout and an agent that changed nothing', async () => {
  const repo = repoFixture();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-cfg-'));
  const history = createSelfHistory(cfg);
  const noop = await codeChange({ repo, configDir: cfg, history, text: 'nothing', runAgent: async () => ({ ok: true, text: '' }) });
  assert.match(noop.why, /no changes/);
  fs.appendFileSync(path.join(repo, 'src/greet.js'), '// local edit\n');
  const dirty = await codeChange({ repo, configDir: cfg, history, text: 'x', runAgent: async () => assert.fail('must not run') });
  assert.match(dirty.why, /uncommitted changes/);
});

test('failure summary keeps the lines that explain the failure', () => {
  const out = 'TAP version 13\n# Subtest: greet\nnot ok 1 - greet\n  ---\n  error: |-\n    Expected values to be strictly equal:\n  ...\n# pass 0\n# fail 1\n';
  assert.match(testFailureSummary(out), /not ok 1 - greet[\s\S]*Expected values[\s\S]*# fail 1/);
});

test('a settings change that would send a sealed project to a cloud agent is refused', () => {
  const p = structuredClone(DEFAULT_PROFILE);
  p.private.sealed = ['sealedproj'];
  assert.match(parseSettingsChange('codex should handle sealedproj', p).refuse, /stays on this machine/);
  assert.equal(parseSettingsChange('codex should handle sealedproj', structuredClone(DEFAULT_PROFILE))?.refuse, undefined, 'not sealed here: an ordinary word');
});
