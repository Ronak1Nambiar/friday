import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchMarkdown, checkTasks, loadTasks } from '../scripts/bench-missions.js';

test('benchmark tasks: each hidden check fails on the starting code and passes on the reference', () => {
  const tasks = loadTasks();
  assert.ok(tasks.length >= 4);
  assert.deepEqual(checkTasks(tasks), []);
});

test('benchmark report: the score line and every row, losses included', () => {
  const md = benchMarkdown([
    { task: 'a', approach: 'claude', pass: true, ms: 90000, fiveHourAfter: 0.2, cost: null, acceptOut: 'PASS' },
    { task: 'a', approach: 'friday', pass: false, ms: 600000, fixRounds: 2, fiveHourAfter: 0.31, cost: 0, note: 'needs you: 1 open issue' },
  ], { date: '2026-10-17' });
  assert.match(md, /\*\*FRIDAY mission: 0\/1 tasks pass\. One Claude Code turn: 1\/1\.\*\*/);
  assert.match(md, /\| a \| friday \| fail \| 10\.0 min \| 2 \| 31% \| - \| needs you: 1 open issue \|/);
  assert.match(md, /\| a \| claude \| pass \| 1\.5 min \| - \| 20% \| - \| PASS \|/);
});
