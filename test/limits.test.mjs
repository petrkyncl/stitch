import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Meter, LIMITS, CapError } from '../src/llm.mjs';

test('a run stops before it goes over its call or spend cap', () => {
  const m = new Meter();
  m.guard(); // fresh run: allowed
  m.calls = LIMITS.calls;
  assert.throws(() => m.guard(), CapError);
  const n = new Meter();
  n.dollars = LIMITS.dollars;
  assert.throws(() => n.guard(), CapError);
});
