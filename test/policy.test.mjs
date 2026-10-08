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

test('agreeing to terms and granting permissions need a person', () => {
  for (const l of ['Agree', 'I agree', 'Accept all', 'Allow', 'Grant access']) assert.ok(isExternalLabel(l), l);
  for (const l of ['Ask Gemini', 'Add alarm', 'Search here', 'Allowance']) assert.ok(!isExternalLabel(l), l);
});
