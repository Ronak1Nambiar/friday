// Hidden acceptance test (the agents never see it). cwd: the built project.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-accept-'));
const file = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
const run = (...args) => spawnSync(process.execPath, ['wordfreq.js', ...args], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000 });
const lines = (s) => s.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const fails = [];
const check = (name, ok) => { if (!ok) fails.push(name); };

if (!fs.existsSync('wordfreq.js')) { console.log('FAIL: no wordfreq.js in the project root'); process.exit(1); }

const a = run(file('a.txt', "The cat and the hat. THE end; cat's"), '--top', '3');
check('top 3 with ties alphabetical', a.status === 0 && JSON.stringify(lines(a.stdout)) === JSON.stringify(['the 3', 'cat 2', 'and 1']));

const b = run(file('b.txt', 'b a c b\n\nA1b'));
check('default top 10, digits separate words, case folded', b.status === 0 && JSON.stringify(lines(b.stdout)) === JSON.stringify(['b 3', 'a 2', 'c 1']));

const c = run(path.join(dir, 'missing.txt'));
check('missing file: exit 1 and an error on stderr', c.status === 1 && c.stderr.trim().length > 0 && c.stdout.trim() === '');

const d = run(file('d.txt', 'x y z x y x w'), '--top', '2');
check('--top 2', d.status === 0 && JSON.stringify(lines(d.stdout)) === JSON.stringify(['x 3', 'y 2']));

const e = run(file('e.txt', '... 123 !!!'));
check('no words: no output, exit 0', e.status === 0 && e.stdout.trim() === '');

console.log(fails.length ? `FAIL: ${fails.join('; ')}` : 'PASS: 5/5');
process.exit(fails.length ? 1 : 0);
