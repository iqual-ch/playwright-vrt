import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeConfigHash } from '../../src/config.js';

test('computeConfigHash: nested key order does not affect the hash', () => {
  const a = { a: { b: 1, c: 2 } };
  const b = { a: { c: 2, b: 1 } };
  assert.equal(computeConfigHash(a), computeConfigHash(b));
});

test('computeConfigHash: a changed nested value changes the hash', () => {
  const a = { a: { b: 1, c: 2 } };
  const b = { a: { b: 1, c: 3 } };
  assert.notEqual(computeConfigHash(a), computeConfigHash(b));
});

test('computeConfigHash: arrays are order-sensitive', () => {
  const a = { list: [1, 2, 3] };
  const b = { list: [3, 2, 1] };
  assert.notEqual(computeConfigHash(a), computeConfigHash(b));
});
