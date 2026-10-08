import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExternalLabel, manifestFor, review, GRANTED } from '../src/policy.mjs';

test('sending, paying and deleting are irreversible', () => {
  for (const l of ['Send', 'Delete', 'Pay now', 'Post', 'Odeslat']) assert.ok(isExternalLabel(l), l);
  for (const l of ['Add alarm', 'Search here', 'Save', 'Message']) assert.ok(!isExternalLabel(l), l);
});

test('capabilities can grow, authority cannot', () => {
  const local = manifestFor([{ op: 'tap' }, { op: 'type' }]);
  assert.deepEqual(review(local).allowed, true);
  const held = manifestFor([{ op: 'tap' }, { op: 'tap', external: true }]);
  assert.equal(held.effect, 'external');
  assert.equal(review(held).allowed, false);
  assert.ok(Object.isFrozen(GRANTED) && Object.isFrozen(GRANTED.effects));
});
