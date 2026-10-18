import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { designLinkIn, designPrompt, findDesignSystem, implementPrompt, paneCommand, resyncPrompt, testCommandFor, watchHandoff } from '../src/design.js';

test('a pasted claude.ai/design link becomes the design project, and prompts work without sync notes', () => {
  const app = { name: 'thoughtspace', display: 'Thoughtspace', dir: '/r/ts' };
  assert.equal(designLinkIn('redesign the UI', app), null);
  assert.equal(designLinkIn('see https://claude.ai/design/x', app), null);
  const ds = designLinkIn('make no mistakes https://claude.ai/design/p/22DA50C4-c281-4e36-baec-9db40616b4ea.', app);
  assert.equal(ds.project, '22da50c4-c281-4e36-baec-9db40616b4ea');
  assert.equal(ds.link, 'https://claude.ai/design/p/22DA50C4-c281-4e36-baec-9db40616b4ea');
  assert.equal(findDesignSystem(app, { designSystems: { thoughtspace: { project: ds.project, link: ds.link } } }).project, ds.project);
  const prompt = designPrompt({ request: 'r', app, ds, handoff: '/cfg/design/1.json' });
  assert.match(prompt, /Claude Design project 22da50c4[\s\S]*claude\.ai\/design\/p\//);
  assert.match(resyncPrompt({ app, ds, branch: 'b' }), /\.design-sync\/NOTES\.md \(create it/);
});

test('finds a synced design system in the repo or one of its worktrees', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-app-'));
  const app = { name: 'myapp', display: 'MyApp', dir };
  assert.equal(findDesignSystem(app, {}), null);
  const ds = path.join(dir, '.claude', 'worktrees', 'design-sync', '.design-sync');
  fs.mkdirSync(ds, { recursive: true });
  fs.writeFileSync(path.join(ds, 'NOTES.md'), '# notes\n\nTarget: claude.ai/design project "MyApp Design System" (`11111111-2222-4333-8444-555555555555`).\n');
  const found = findDesignSystem(app, {});
  assert.equal(found.project, '11111111-2222-4333-8444-555555555555');
  assert.equal(found.name, 'MyApp Design System');
  assert.equal(found.dir, ds);
  assert.equal(findDesignSystem(app, { designSystems: { MyApp: { project: 'p1', name: 'X', dir: '/x' } } }).project, 'p1');
});

test('the design pane may not touch the repo, and writes its link to the handoff', () => {
  const app = { name: 'myapp', display: 'MyApp', dir: '/r/myapp' };
  const prompt = designPrompt({ request: 'Redesign the workspace', app, ds: { name: 'TS DS', project: 'abc', dir: '/r/ts/.design-sync' }, handoff: '/cfg/design/1.json' });
  assert.match(prompt, /Claude Design/);
  assert.match(prompt, /Do not change any file in the repo/);
  assert.match(prompt, /\/cfg\/design\/1\.json/);
  assert.match(prompt, /project abc/);
  const cmd = paneCommand({ prompt, repoDir: '/r/ts', handoffDir: '/cfg/design' });
  assert.equal(cmd[0], 'claude');
  assert.equal(cmd[1], prompt, 'prompt before the variadic --disallowedTools');
  const ts = process.platform === 'win32' ? `//${path.resolve('/r/ts')[0].toLowerCase()}/r/ts/**` : '//r/ts/**';
  assert.deepEqual(cmd.slice(-3), ['NotebookEdit', `Edit(${ts})`, `Write(${ts})`]);
  assert.match(implementPrompt({ request: 'r', handoff: { link: 'https://claude.ai/design/x', spec: 'inbox left' }, app }), /inbox left[\s\S]*CSS tokens/);
});

test('handoff watcher reports each new revision once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-ho-'));
  const f = path.join(dir, 'h.json');
  const seen = [];
  const w = watchHandoff(f, (h) => seen.push(h.revision), { interval: 1e6 });
  w.check();
  fs.writeFileSync(f, JSON.stringify({ link: 'https://claude.ai/design/p/1', revision: 1 }));
  w.check(); w.check();
  fs.writeFileSync(f, JSON.stringify({ link: 'https://claude.ai/design/p/1', revision: 2 }));
  w.check();
  w.stop();
  assert.deepEqual(seen, [1, 2]);
});

test('test command comes from the repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-tc-'));
  assert.equal(testCommandFor(dir), null);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"node --test"}}');
  assert.equal(testCommandFor(dir), 'npm test --silent');
});

test('cockpit and its new modules load together', async () => {
  const m = await import('../src/cockpit.js');
  assert.equal(typeof m.startCockpit, 'function');
  assert.equal(m.RESTART_CODE, 75);
  assert.equal(typeof m.openTerminal, 'function');
});
