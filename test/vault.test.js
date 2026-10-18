import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyOp, contextNote, denyGlob, createVaultQueue, nowBlock, ollamaSystem, parseProposals, renderProtocol, retrieve, vaultAccess, vaultStatus, writeAgentContext,
} from '../src/vault.js';

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function vaultFixture() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-vault-'));
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true }); fs.writeFileSync(path.join(v, rel), s); };
  w('_INDEX.md', '# Index\n\n## Projects — `01_Projects/`\n- [[project-alpha]]: alpha\n- [[project-beta]]: beta\n\n## Areas — `02_Areas/`\n- [[about-me]]: who\n');
  w('_System/log.md', '# Log\n\n## [2026-10-10] build | first\nbody\n');
  w('_System/decisions.md', '# Decisions\n\nintro\n\n- **2026-10-01** · [[project-beta]] · **Beta.** *"build the beta"*\n- **2026-09-01** · [[project-alpha]] · **Old alpha call.** *"alpha later"*\n');
  w('_System/CRITICAL_FACTS.md', '---\ntype: system\n---\n# Facts\n- User, alpha.\n');
  w('01_Projects/project-alpha.md', '---\ntype: project\nupdated: 2026-10-01\n---\n\n# Alpha\n\n## Now\n*Rewritten in place, never appended. Updated 2026-10-01.*\n- **Status:** picked\n\n---\n## History\nolder alpha stuff\n');
  w('01_Projects/project-beta.md', '# Beta\n\n## Now\n- parked\n');
  w('00_Raw/daily/2026-10-11.md', 'my words\n');
  return v;
}

test('protocol renders per agent; agents get read and write access to the vault', () => {
  const v = vaultFixture();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-cfg-'));
  assert.match(renderProtocol(v), new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const files = writeAgentContext(cfg, v);
  assert.deepEqual(Object.keys(files).sort(), ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
  const proto = fs.readFileSync(files['CLAUDE.md'], 'utf8');
  assert.match(proto, /Edit the vault directly/);
  assert.doesNotMatch(proto, /```friday-vault|propose, never write/, 'tool agents are not taught the ops');

  const c = vaultAccess('claude', { vault: v, files });
  assert.deepEqual(c.args, ['--add-dir', v, '--append-system-prompt-file', files['CLAUDE.md']], 'no edit tools denied in the vault');
  assert.match(denyGlob(v), /^\/\/[^\\:]+\/\*\*$/, 'POSIX form, no drive colon or backslashes');
  const x = vaultAccess('codex', { vault: v, files });
  assert.match(x.args[1], /^developer_instructions="/);
  assert.equal(x.args[3], `sandbox_workspace_write.writable_roots=[${JSON.stringify(v)}]`, 'the vault is writable for codex, new or resumed');
  // Ollama has no file tools: it still proposes ops.
  assert.match(ollamaSystem(v, 'alpha').system, /```friday-vault/);
  assert.deepEqual(vaultAccess('gemini', { vault: v, files }).args, ['--include-directories', v]);
  assert.ok(vaultAccess('gemini', { vault: v, files }).firstTurn.includes('Second brain protocol'));
  const o = JSON.parse(vaultAccess('opencode', { vault: v, files }).env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(o.instructions, [files['AGENTS.md']]);
});

test('CRLF notes: every op works and the file keeps its line endings', () => {
  const v = vaultFixture();
  const crlf = (rel) => { const f = path.join(v, rel); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n/g, '\r\n')); };
  for (const rel of ['01_Projects/project-alpha.md', '_System/log.md', '_System/decisions.md', '_INDEX.md']) crlf(rel);
  const day = new Date(2026, 9, 13);
  applyOp(v, { op: 'now', path: '01_Projects/project-alpha.md', body: '- **Status:** flying' }, { date: day });
  applyOp(v, { op: 'log', title: 'crlf', body: 'b' }, { date: day });
  applyOp(v, { op: 'decision', note: 'project-alpha', summary: 'Fly', quote: 'fly it' }, { date: day });
  applyOp(v, { op: 'create', path: '01_Projects/project-kite.md', content: '# Kite', index: 'kites' }, { date: day });
  const alpha = fs.readFileSync(path.join(v, '01_Projects/project-alpha.md'), 'utf8');
  assert.match(alpha, /## Now\r\n\*Rewritten in place, never appended\. Updated 2026-10-13\.\*\r\n- \*\*Status:\*\* flying\r\n/);
  assert.match(alpha, /updated: 2026-10-13/);
  assert.match(alpha, /older alpha stuff/);
  for (const rel of ['01_Projects/project-alpha.md', '_System/log.md', '_System/decisions.md', '_INDEX.md']) {
    assert.doesNotMatch(fs.readFileSync(path.join(v, rel), 'utf8'), /[^\r]\n/, `${rel} stays CRLF throughout`);
  }
  assert.equal(nowBlock(alpha), '- **Status:** flying');
});

test('an agent\'s direct edits: only those files are committed, then pushed', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-ce-'));
  const seed = vaultFixture();
  const remote = path.join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'seed'], ['remote', 'add', 'origin', remote], ['push', '-q', '-u', 'origin', 'main']]) git(seed, ...a);
  const before = await vaultStatus(seed);
  assert.deepEqual([...before], []);
  // The user has an unfinished edit; the agent then edits one note and creates another.
  fs.appendFileSync(path.join(seed, '01_Projects/project-beta.md'), 'user typing\n');
  fs.appendFileSync(path.join(seed, '01_Projects/project-alpha.md'), 'agent edit\n');
  fs.mkdirSync(path.join(seed, '03_Resources'), { recursive: true });
  fs.writeFileSync(path.join(seed, '03_Resources/new-note.md'), '# New\n');
  const after = await vaultStatus(seed);
  assert.deepEqual([...after].sort(), ['01_Projects/project-alpha.md', '01_Projects/project-beta.md', '03_Resources/new-note.md']);
  const q = createVaultQueue({ vault: seed });
  const rep = await q.commitEdits(['01_Projects/project-alpha.md', '03_Resources/new-note.md'], { source: 'claude' });
  assert.deepEqual([rep.committed, rep.pushed], [true, true], JSON.stringify(rep));
  assert.equal(git(seed, 'log', '-1', '--format=%s'), 'FRIDAY (claude): project-alpha, new-note');
  assert.equal(git(seed, 'status', '--porcelain'), 'M 01_Projects/project-beta.md', 'the user\'s edit is untouched and uncommitted');
  assert.equal(git(seed, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'main'));
});

test('retrieval: index lookup plus grep, decisions newest first, only what matches', () => {
  const v = vaultFixture();
  const r = retrieve(v, "What did I decide about the alpha project, and what's next?");
  assert.deepEqual(r.tokens, ['alpha']);
  assert.equal(r.notes[0].name, 'project-alpha');
  assert.equal(r.notes[0].now, '- **Status:** picked');
  assert.ok(!r.notes.some((n) => n.name === 'project-beta'));
  assert.equal(r.decisions.length, 1);
  assert.match(contextNote(r, { full: true }), /\[\[project-alpha\]\][\s\S]*Status:\*\* picked[\s\S]*Old alpha call/);
  const sys = ollamaSystem(v, 'alpha status').system;
  assert.match(sys, /User, alpha/);
  assert.match(sys, /\[\[project-alpha\]\]/);
  assert.equal(contextNote(retrieve(v, 'unrelated quantum topic')), '');
});

test('proposals parse from fenced blocks; bad ones are reported', () => {
  const text = 'done.\n```friday-vault\n{"op":"log","kind":"build","title":"t","body":"b"}\n```\n'
    + '```friday-vault\n[{"op":"now","path":"01_Projects/project-alpha.md","body":"- x"},{"op":"zap"}]\n```\n```friday-vault\n{oops\n```';
  const { ops, errors } = parseProposals(text);
  assert.deepEqual(ops.map((o) => o.op), ['log', 'now']);
  assert.equal(errors.length, 2);
});

test('ops follow the vault rules', () => {
  const v = vaultFixture();
  const date = new Date(2026, 9, 11, 12);
  applyOp(v, { op: 'log', kind: 'build', title: 'FRIDAY v0.3', body: 'routing' }, { date });
  assert.match(fs.readFileSync(path.join(v, '_System/log.md'), 'utf8'), /\n## \[2026-10-11\] build \| FRIDAY v0\.3\nrouting\n$/);

  applyOp(v, { op: 'decision', note: 'project-alpha', summary: 'Ref first', quote: 'do the thing first' }, { date });
  const dec = fs.readFileSync(path.join(v, '_System/decisions.md'), 'utf8').split('\n');
  assert.equal(dec[4], '- **2026-10-11** · [[project-alpha]] · **Ref first.** *"do the thing first"*');
  assert.throws(() => applyOp(v, { op: 'decision', summary: 'x' }), /exact words/);

  applyOp(v, { op: 'now', path: '01_Projects/project-alpha.md', body: '- **Status:** testing on footage' }, { date });
  const note = fs.readFileSync(path.join(v, '01_Projects/project-alpha.md'), 'utf8');
  assert.match(note, /## Now\n\*Rewritten in place, never appended\. Updated 2026-10-11\.\*\n- \*\*Status:\*\* testing on footage\n\n---\n## History/);
  assert.match(note, /updated: 2026-10-11/);
  assert.ok(!note.includes('picked'));

  applyOp(v, { op: 'create', path: '01_Projects/project-friday-test.md', content: '# T\n', index: 'a test note' }, { date });
  const idx = fs.readFileSync(path.join(v, '_INDEX.md'), 'utf8');
  assert.match(idx, /- \[\[project-beta\]\]: beta\n- \[\[project-friday-test\]\]: a test note\n\n## Areas/);
  assert.throws(() => applyOp(v, { op: 'create', path: '01_Projects/project-friday-test.md', content: 'x' }), /already exists/);

  assert.throws(() => applyOp(v, { op: 'append', path: '00_Raw/daily/2026-10-11.md', content: 'x' }), /read-only/);
  assert.throws(() => applyOp(v, { op: 'now', path: '../outside.md', body: 'x' }), /outside the vault/);
  assert.throws(() => applyOp(v, { op: 'create', path: 'random/x.md', content: 'x' }), /new notes go under/);
  assert.throws(() => applyOp(v, { op: 'append', path: '_System/CRITICAL_FACTS.md', content: 'x' }), /_System/);
  assert.equal(fs.readFileSync(path.join(v, '00_Raw/daily/2026-10-11.md'), 'utf8'), 'my words\n');
});

test('write queue: concurrent agents, one writer, pull before, commit and push after', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-q-'));
  const seed = vaultFixture();
  const remote = path.join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  const vault = path.join(base, 'vault');
  execFileSync('git', ['clone', '-q', remote, vault]);
  git(vault, 'config', 'user.email', 't@t');
  git(vault, 'config', 'user.name', 't');

  // Another machine (Obsidian Git on Windows) pushes first; the queue must pull it in.
  fs.appendFileSync(path.join(seed, '01_Projects/project-beta.md'), '\nfrom the other machine\n');
  git(seed, 'commit', '-qam', 'other machine');
  git(seed, 'push', '-q');

  const q = createVaultQueue({ vault, now: () => new Date(2026, 9, 11) });
  const jobs = Array.from({ length: 10 }, (_, i) => q.submit([{ op: 'log', kind: 'test', title: `agent ${i}`, body: `entry ${i}` }], { source: `agent${i}` }));
  assert.equal(q.pending, 10);
  const reports = await Promise.all(jobs);
  assert.ok(reports.every((r) => r.committed && r.pushed && r.results[0].ok), JSON.stringify(reports.find((r) => !r.pushed)));

  // (git may check the log out as CRLF on Windows; FRIDAY keeps a file's line endings.)
  const log = fs.readFileSync(path.join(vault, '_System/log.md'), 'utf8').replace(/\r\n/g, '\n');
  for (let i = 0; i < 10; i++) assert.ok(log.includes(`## [2026-10-11] test | agent ${i}\nentry ${i}\n`), `entry ${i}`);
  // In submission order, one commit each, on top of the other machine's commit.
  assert.deepEqual([...log.matchAll(/agent (\d)/g)].map((m) => +m[1]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.match(fs.readFileSync(path.join(vault, '01_Projects/project-beta.md'), 'utf8'), /from the other machine/);
  assert.equal(git(vault, 'rev-list', '--count', 'HEAD'), '12');
  assert.equal(git(vault, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'main'));
  assert.equal(git(vault, 'status', '--porcelain'), '');

  // A rejected op does not stop the rest of its batch, and nothing is committed for it.
  const r = await q.submit([{ op: 'append', path: '00_Raw/x.md', content: 'no' }, { op: 'log', title: 'ok' }]);
  assert.deepEqual(r.results.map((x) => x.ok), [false, true]);
  assert.ok(r.committed);
});

test('sealed projects get an explicit rule in every agent instruction file', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-sv-'));
  fs.mkdirSync(path.join(v, '_System'), { recursive: true });
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-sc-'));
  const files = writeAgentContext(cfg, v, { sealed: ['sealedproj'] });
  for (const f of Object.values(files)) {
    const t = fs.readFileSync(f, 'utf8');
    assert.match(t, /## Sealed projects/);
    assert.match(t, /SEALEDPROJ is sealed/);
    assert.match(t, /shell command/);
  }
  const plain = writeAgentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'friday-sc-')), v);
  assert.doesNotMatch(fs.readFileSync(plain['CLAUDE.md'], 'utf8'), /Sealed projects/);
});

test('a vault with uncommitted edits is never pulled, committed or pushed by FRIDAY', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-dirty-'));
  const seed = vaultFixture();
  const remote = path.join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(seed, 'init', '-q', '-b', 'main'); git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'seed');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', '-q', '-u', 'origin', 'main');
  const vault = path.join(base, 'vault');
  execFileSync('git', ['clone', '-q', remote, vault]);
  git(vault, 'config', 'user.email', 't@t'); git(vault, 'config', 'user.name', 't');
  // The other machine changes _INDEX.md; here the user has an unfinished edit to it too.
  fs.appendFileSync(path.join(seed, '_INDEX.md'), '\nremote line\n'); git(seed, 'commit', '-qam', 'remote'); git(seed, 'push', '-q');
  fs.appendFileSync(path.join(vault, '_INDEX.md'), '\nmy unfinished edit\n');
  const head = git(vault, 'rev-parse', 'HEAD');
  const q = createVaultQueue({ vault, now: () => new Date(2026, 9, 12) });
  const rep = await q.submit([{ op: 'create', path: '03_Resources/friday-missions/2026-10-12-x.md', content: '# X\n', index: 'FRIDAY mission: X' }]);
  assert.ok(rep.results[0].ok, 'the note is written');
  assert.ok(fs.existsSync(path.join(vault, '03_Resources/friday-missions/2026-10-12-x.md')));
  assert.deepEqual([rep.committed, rep.pushed], [false, false]);
  assert.match(rep.warnings.join(' '), /uncommitted changes/);
  assert.equal(git(vault, 'rev-parse', 'HEAD'), head, 'no pull, no commit');
  const idx = fs.readFileSync(path.join(vault, '_INDEX.md'), 'utf8');
  assert.ok(idx.includes('my unfinished edit') && !idx.includes('<<<<<<<'), 'his edit is intact, no conflict markers');
});
