import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitBill } from '../src/money.js';

test('splits evenly', () => {
  assert.deepEqual(splitBill(100, 4), [25, 25, 25, 25]);
  assert.deepEqual(splitBill(0, 3), [0, 0, 0]);
});

test('rejects bad input', () => {
  assert.throws(() => splitBill(-1, 2), TypeError);
  assert.throws(() => splitBill(10, 0), TypeError);
  assert.throws(() => splitBill(1.5, 2), TypeError);
});
