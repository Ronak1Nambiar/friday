import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas, Screen, mdSegs, wrap } from '../src/term-hud.js';

const text = (line) => line.map((s) => s.t).join('');

test('wrap breaks on words, indents continuation lines, and splits long words', () => {
  const ls = wrap([{ t: 'alpha beta gamma delta' }], 11, '  ');
  assert.deepEqual(ls.map(text), ['alpha beta', '  gamma', '  delta']);
  assert.deepEqual(wrap([{ t: 'abcdefghij' }], 4).map(text), ['abcd', 'efgh', 'ij']);
});

test('markdown segments: bold, code, wikilinks with alias', () => {
  const segs = mdSegs('**Status:** see `x` and [[note|the note]]');
  assert.equal(text(segs), 'Status: see x and the note');
  assert.equal(segs[0].st, 1);
});

test('canvas packs 2x4 dots into one braille cell and overlays labels', () => {
  const cv = new Canvas(2, 1);
  for (let y = 0; y < 4; y++) { cv.set(0, y, [1, 2, 3]); cv.set(1, y, [1, 2, 3]); }
  cv.set(2, 0, [9, 9, 9]);
  const scr = new Screen(2, 1);
  cv.blit(scr, 0, 0);
  assert.equal(scr.ch[0], '⣿');
  assert.equal(scr.ch[1], '⠁');
  cv.label(0, 0, 'AB', [0, 0, 0]);
  cv.blit(scr, 0, 0);
  assert.equal(scr.ch.join(''), 'AB');
});

test('screen rows carry truecolor and clip at the edge', () => {
  const scr = new Screen(4, 1);
  scr.put(2, 0, 'xyz', [10, 20, 30]);
  const row = scr.row(0);
  assert.match(row, /38;2;10;20;30m/);
  assert.equal(row.replace(/\x1b\[[0-9;]*m/g, ''), '  xy');
});
