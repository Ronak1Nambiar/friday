import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addTurn, ago, createConvoStore, dumpSessions, loadSessions, newConvo, summarize } from '../src/convos.js';

test('conversations save, list newest first, and keep agent sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-convos-'));
  const store = createConvoStore(dir);
  const a = newConvo('/tmp');
  store.save(a); // empty conversations are not written
  assert.equal(store.list().length, 0);

  const sessions = new Map([['claude\0/tmp', { id: 'abc', primed: true }], ['codex\0/tmp', {}]]);
  addTurn(a, { agent: 'claude', prompt: 'how is  myapp\ndoing', text: 'fine' });
  a.sessions = dumpSessions(sessions);
  a.updated = 1000;
  store.save(a);

  const b = newConvo('/tmp');
  addTurn(b, { agent: 'codex', prompt: 'second', text: 'ok' });
  addTurn(b, { agent: 'claude', prompt: 'third', text: 'ok' });
  store.save(b);

  const list = store.list();
  assert.deepEqual(list.map((c) => c.id), [b.id, a.id]);
  const back = loadSessions(store.load(a.id).sessions);
  assert.deepEqual([...back.keys()], ['claude\0/tmp']);
  assert.equal(back.get('claude\0/tmp').id, 'abc');
  assert.deepEqual(summarize(list[0]), { title: 'second', agents: ['codex', 'claude'], turns: 2 });
  assert.equal(summarize(list[1]).title, 'how is myapp doing');
});

test('ago is short and human', () => {
  const now = Date.UTC(2026, 9, 11, 12);
  assert.equal(ago(now - 5000, now), 'just now');
  assert.equal(ago(now - 5 * 60e3, now), '5m ago');
  assert.equal(ago(now - 3 * 3600e3, now), '3h ago');
  assert.equal(ago(now - 2 * 86400e3, now), '2d ago');
  assert.equal(ago(now - 30 * 86400e3, now), '2026-09-11');
});
