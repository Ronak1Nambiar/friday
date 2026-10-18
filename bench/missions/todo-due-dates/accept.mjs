// Hidden acceptance test (the agents never see it). cwd: the changed repo.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const todo = path.resolve('todo.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-accept-'));
const run = (...args) => spawnSync(process.execPath, [todo, ...args], { cwd: work, encoding: 'utf8', timeout: 20000 });
const lines = (s) => s.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const fails = [];
const check = (name, ok) => { if (!ok) fails.push(name); };

check('add with --due', /added #1/.test(run('add', 'pay rent', '--due', '2000-01-01').stdout));
check('add a future one', /added #2/.test(run('add', 'renew passport', '--due', '2999-12-31').stdout));
check('add without --due', /added #3/.test(run('add', 'call mom').stdout));
const bad = run('add', 'nonsense', '--due', '2001-02-30');
check('invalid date: exit 1, stderr', bad.status === 1 && bad.stderr.trim().length > 0);
const bad2 = run('add', 'nonsense', '--due', '01/02/2001');
check('wrong format: exit 1', bad2.status === 1);

const list = lines(run('list').stdout);
check('list keeps 3 todos (nothing added on errors)', list.length === 3);
check('list shows the due date after the text', list.some((l) => /^#1 \[ \] pay rent \(due 2000-01-01\)$/.test(l)) && list.some((l) => /^#2 \[ \] renew passport \(due 2999-12-31\)$/.test(l)));
check('no due date: unchanged line', list.some((l) => /^#3 \[ \] call mom$/.test(l)));

const over = lines(run('list', '--overdue').stdout);
check('--overdue lists only the past-due open todo', over.length === 1 && /^#1 .*pay rent/.test(over[0]));
run('done', '1');
check('--overdue skips done todos', lines(run('list', '--overdue').stdout).length === 0);

// A todos.json from the old version still loads.
const old = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-old-'));
fs.writeFileSync(path.join(old, 'todos.json'), JSON.stringify({ next: 3, items: [{ id: 1, text: 'old one', done: false }, { id: 2, text: 'old two', done: true }] }, null, 2));
const legacy = spawnSync(process.execPath, [todo, 'list'], { cwd: old, encoding: 'utf8', timeout: 20000 });
check('old todos.json loads', legacy.status === 0 && /#1 \[ \] old one/.test(legacy.stdout) && /#2 \[x\] old two/.test(legacy.stdout));
const legacyOver = spawnSync(process.execPath, [todo, 'list', '--overdue'], { cwd: old, encoding: 'utf8', timeout: 20000 });
check('old todos have no due date, so none are overdue', legacyOver.status === 0 && legacyOver.stdout.trim() === '');

const t = spawnSync('npm', ['test', '--silent'], { cwd: process.cwd(), encoding: 'utf8', shell: process.platform === 'win32', timeout: 120000 });
check('npm test passes', t.status === 0);

console.log(fails.length ? `FAIL: ${fails.join('; ')}` : 'PASS');
process.exit(fails.length ? 1 : 0);
