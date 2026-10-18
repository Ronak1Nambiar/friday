import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquire, answerRun, askByFile, autoAnswer, findRun, listRuns, workerFor, writeRun } from '../src/missionrun.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'friday-runs-'));

test('a run is held by one live process: a second worker refuses; a dead one is taken over', () => {
  const dir = tmp();
  writeRun(dir, { id: 'r1', goal: 'g', pid: null, started: 1 });
  assert.equal(acquire(dir, 'r1', process.pid).run.pid, process.pid);
  assert.match(acquire(dir, 'r1', 999999).error, /already running/, 'this test process is alive and holds it');
  writeRun(dir, { id: 'r2', goal: 'g', pid: 2147480000, started: 2 });
  assert.equal(acquire(dir, 'r2', process.pid).run.pid, process.pid, 'a dead pid does not hold a run');
  assert.match(acquire(dir, 'nope').error, /no run/);
});

test('workerFor finds the live worker of a mission, never the asking one itself', () => {
  const dir = tmp();
  writeRun(dir, { id: 'a', missionId: 'm1', pid: process.pid, started: 1 });
  writeRun(dir, { id: 'b', missionId: 'm2', pid: 2147480000, started: 2 });
  assert.equal(workerFor(dir, 'm1').id, 'a');
  assert.equal(workerFor(dir, 'm1', { exceptRun: 'a' }), null);
  assert.equal(workerFor(dir, 'm2'), null, 'its worker is gone');
  writeRun(dir, { id: 'a', missionId: 'm1', pid: process.pid, started: 1, done: true });
  assert.equal(workerFor(dir, 'm1'), null, 'a finished run holds nothing');
  assert.equal(findRun(dir, '1').id, 'b', 'newest first');
  assert.equal(findRun(dir, 'm1').id, 'a');
});

test('askByFile: the question waits in a file; an answer from the terminal or the phone settles it, first one wins', async () => {
  const dir = tmp();
  writeRun(dir, { id: 'r', goal: 'g', pid: process.pid, started: 1 });
  const p = askByFile(dir, 'r', 'Run this research? go / cancel', { pollMs: 20 });
  assert.equal(listRuns(dir)[0].asking, 'Run this research? go / cancel');
  assert.equal(answerRun(dir, 'r', 'go'), true);
  assert.deepEqual(await p, { answer: 'go', from: 'terminal' });
  assert.equal(listRuns(dir)[0].asking, null, 'cleared');
  assert.equal(answerRun(dir, 'r', 'go'), false, 'nothing is waiting now');

  let tap;
  const phone = new Promise((r) => { tap = r; });
  const q = askByFile(dir, 'r', 'Build it?', { pollMs: 20, also: phone });
  tap('add a pricing page');
  assert.deepEqual(await q, { answer: 'add a pricing page', from: 'phone' });
  assert.equal(fs.existsSync(path.join(dir, 'r.ask')), false);
});

test('--yes answers only the approval gates; PRs, failing builds and anything else still ask', () => {
  assert.equal(autoAnswer('Run this research? go / cancel / or say what to change'), 'go');
  assert.equal(autoAnswer('Run this research (nothing gets built)? go / cancel / or say what to change'), 'go');
  assert.equal(autoAnswer('Build it? go / cancel / folder <path> / or say what to change'), 'go');
  assert.equal(autoAnswer('Done? ok / or say what to change'), 'ok');
  assert.equal(autoAnswer('Open a pull request from friday/x? yes / no'), 'no');
  assert.equal(autoAnswer('more (more fix rounds) / accept (keep it as it is) / stop'), 'stop');
  assert.equal(autoAnswer('claude is at 91% of its 5-hour limit. go / use <agent> / pause'), null);
  assert.equal(autoAnswer('Where should missions be saved?'), null);
});
