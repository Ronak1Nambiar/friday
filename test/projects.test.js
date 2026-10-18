import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { detectProject, findProject, loadRegistry, scanProject } from '../src/projects.js';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-'));
  const projects = path.join(base, 'Projects');
  const repo = path.join(projects, 'beta-sim');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'main.py'), 'print(1)\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# beta\n');
  fs.writeFileSync(path.join(repo, 'node_modules', 'x', 'i.js'), '');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'src', 'README.md');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first');
  fs.writeFileSync(path.join(repo, 'src', 'main.py'), 'print(2)\n');

  const notes = path.join(base, 'vault', '01_Projects');
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'project-beta.md'),
    '---\ntype: project\nstatus: active\n---\n\n# Beta\n\n## Now\n*Rewritten in place.*\n- **Status:** sim works\n\n---\n## History\nold\n');
  fs.writeFileSync(path.join(notes, 'project-sealedproj-repo.md'), '---\ntype: project\n---\n# SEALEDPROJ\n## Now\n- training\n');
  fs.writeFileSync(path.join(notes, 'project-sealedproj-repo-notes.md'), '# SEALEDPROJ extra\n');
  fs.writeFileSync(path.join(notes, 'project-gamma.md'), '---\nstatus: archived\n---\n# Gamma\n');
  return { base, projects, repo, vault: path.join(base, 'vault') };
}

test('registry joins folders to vault notes and skips archived and sub-notes', () => {
  const f = fixture();
  const reg = loadRegistry({ roots: [f.projects], vault: f.vault });
  const names = reg.map((p) => p.display).sort();
  assert.deepEqual(names, ['Beta', 'SEALEDPROJ']);
  const station = reg.find((p) => p.display === 'Beta');
  assert.equal(station.dir, f.repo);
  assert.equal(station.note.now, '- **Status:** sim works');
});

test('mentions focus the right project and ignore generic words', () => {
  const f = fixture();
  const reg = loadRegistry({ roots: [f.projects], vault: f.vault });
  assert.equal(detectProject('how is the Beta doing?', reg)?.display, 'Beta');
  assert.equal(detectProject('ping sealedproj about the data', reg)?.display, 'SEALEDPROJ');
  assert.equal(detectProject('my memory is bad', reg), null);
  assert.equal(findProject('seal', reg)?.display, 'SEALEDPROJ');
});

test('ordinary words do not grab focus; real projects and /project still work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-reg-'));
  const dl = path.join(root, 'Downloads');
  const vault = path.join(dl, 'Brain');
  const repo = (name) => { fs.mkdirSync(path.join(dl, name, '.git'), { recursive: true }); };
  for (const d of ['Agent-Demo', 'files', 'Misc-Stuff', 'Misc-Lab']) fs.mkdirSync(path.join(dl, d), { recursive: true });
  for (const d of ['Group-Chat-Trivia', 'Remote', 'Telegram Desktop', 'delta-app', 'friday']) repo(d);
  fs.mkdirSync(path.join(vault, '01_Projects'), { recursive: true });
  fs.mkdirSync(path.join(vault, '.git'));
  fs.writeFileSync(path.join(vault, '01_Projects', 'project-delta.md'), '---\ntype: project\nstatus: active\n---\n\n# Delta ("delta-app")\n\n## Now\n- shipping\n');
  const reg = loadRegistry({ roots: [dl], vault });
  const auto = (m) => detectProject(m, reg, { auto: true, vault })?.display || null;
  for (const m of ['which agent gets this message', 'ask claude to create a group of files', 'remote work and the lab', 'telegram is noisy'])
    assert.equal(auto(m), null, m);
  assert.equal(auto("how's delta-app doing"), 'Delta');
  assert.equal(auto('delta landing page'), 'Delta');
  assert.equal(auto('group chat trivia scores'), 'Group-Chat-Trivia');
  assert.equal(auto('friday hud colors'), 'friday');
  const ts = reg.find((p) => p.display === 'Delta');
  assert.equal(path.basename(ts.dir), 'delta-app', 'the note attaches to the repo named in its title');
  for (const [q, want] of [['agent', 'Agent-Demo'], ['files', 'files'], ['brain', 'Brain'], ['remote', 'Remote']]) assert.equal(findProject(q, reg)?.display, want, q);
});

test('scan reports files, languages, git state, and skips vendored folders', () => {
  const f = fixture();
  const reg = loadRegistry({ roots: [f.projects], vault: f.vault });
  const s = scanProject(reg.find((p) => p.dir));
  assert.deepEqual(s.files.map((x) => x.path).sort(), ['README.md', 'src/main.py']);
  assert.equal(s.branch, 'main');
  assert.deepEqual(s.dirty, ['src/main.py']);
  assert.equal(s.commits.length, 1);
  assert.equal(s.activity.at(-1), 1);
  assert.ok(s.languages.Python > 0 && s.languages.Docs > 0);
  assert.equal(s.files.find((x) => x.path === 'src/main.py').heat, 1);
});
