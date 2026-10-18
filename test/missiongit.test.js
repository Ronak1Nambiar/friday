import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { commitAll } from '../src/design.js';
import { ensureRepo, hasRemote, mergeParts, missionBranch, openPr, outsideOwned, partWorktree, removeWorktree } from '../src/missiongit.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (dir, f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };

test('parts build in their own worktrees and merge into the mission folder', async () => {
  const dir = path.join(tmp('friday-mg-'), 'tconv');
  const base = ensureRepo(dir);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), base, 'a fresh folder gets a repo and a first commit');
  const root = tmp('friday-mwt-');
  const a = partWorktree(dir, 'tconv', 'cli', root);
  const b = partWorktree(dir, 'tconv', 'web', root);
  write(a.dir, 'cli/main.py', 'print(1)\n');
  write(b.dir, 'web/index.html', '<p>hi</p>\n');
  write(b.dir, 'README.md', 'stray\n');
  write(b.dir, 'tests/__pycache__/t.cpython-310.pyc', 'x');
  commitAll(a.dir, 'cli');
  commitAll(b.dir, 'web');
  assert.deepEqual(outsideOwned(a.dir, ['cli'], base), []);
  assert.deepEqual(outsideOwned(b.dir, ['web'], base), ['README.md']);
  const res = await mergeParts(dir, [a.branch, b.branch]);
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'cli/main.py')) && fs.existsSync(path.join(dir, 'web/index.html')));
  removeWorktree(dir, a.dir);
  removeWorktree(dir, b.dir);
  assert.ok(!fs.existsSync(a.dir));
  assert.match(git(dir, 'branch', '--list'), /friday-mission\/tconv\/cli/, 'branches are kept');
});

test('a folder inside another repo gets its own repo; existing work is committed first', () => {
  const parent = tmp('friday-mgp-');
  ensureRepo(parent);
  const dir = path.join(parent, 'child');
  write(dir, 'notes.txt', 'mine\n');
  ensureRepo(dir);
  assert.equal(path.resolve(git(dir, 'rev-parse', '--show-toplevel')).toLowerCase(), path.resolve(dir).toLowerCase());
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('merge conflicts: resolved by the callback, or aborted and reported', async () => {
  const dir = path.join(tmp('friday-mgc-'), 'app');
  ensureRepo(dir);
  const root = tmp('friday-mwtc-');
  const mk = (id, text) => { const w = partWorktree(dir, 'app', id, root); write(w.dir, 'shared.txt', text); commitAll(w.dir, id); return w; };
  const a = mk('a', 'from a\n');
  const b = mk('b', 'from b\n');
  const c = mk('c', 'from c\n');
  const bad = await mergeParts(dir, [a.branch, b.branch]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.merged, [a.branch]);
  assert.deepEqual(bad.conflicts, ['shared.txt']);
  assert.equal(git(dir, 'status', '--porcelain'), '', 'the failed merge was aborted');

  const seen = [];
  const good = await mergeParts(dir, [c.branch], async (files) => { seen.push(files); write(dir, 'shared.txt', 'from a\nfrom c\n'); return true; });
  assert.equal(good.ok, true);
  assert.deepEqual(seen, [['shared.txt']]);
  assert.equal(fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8'), 'from a\nfrom c\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  for (const w of [a, b, c]) removeWorktree(dir, w.dir);
});

test('missionBranch: a new folder gets a repo and friday/<slug>; a dirty repo is left alone; a resume stays put', () => {
  const dir = path.join(tmp('friday-mb-'), 'food');
  const b = missionBranch(dir, 'food');
  assert.equal(b.branch, 'friday/food');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'friday/food');
  assert.equal(missionBranch(dir, 'food').branch, 'friday/food', 'resume: already on it');

  const repo = tmp('friday-mb2-');
  git(repo, 'init', '-q');
  write(repo, 'a.txt', 'one\n');
  commitAll(repo, 'first');
  const main = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  write(repo, 'a.txt', 'work in progress\n');
  const dirty = missionBranch(repo, 'x');
  assert.match(dirty.error, /uncommitted changes/);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), main, 'nothing switched');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'work in progress\n');

  commitAll(repo, 'wip');
  git(repo, 'branch', 'friday/x');
  const again = missionBranch(repo, 'x');
  assert.equal(again.branch, 'friday/x-2', 'an existing branch name is not reused');
  assert.equal(again.base, main);
  assert.equal(hasRemote(repo), false);
});

test('openPr pushes the branch, then gh opens the PR; the URL comes back', () => {
  const calls = [];
  const url = openPr('/r', { branch: 'friday/x', title: 'T', body: 'B' }, (file, args) => { calls.push([file, ...args].join(' ')); return file === 'gh' ? 'Creating pull request\nhttps://github.com/u/r/pull/7\n' : ''; });
  assert.equal(url, 'https://github.com/u/r/pull/7');
  assert.deepEqual(calls, ['git -C /r push -u origin friday/x', 'gh pr create --head friday/x --title T --body B']);
});
