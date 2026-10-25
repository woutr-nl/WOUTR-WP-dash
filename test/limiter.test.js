import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, MAX_FAILURES, MAX_GLOBAL, MAX_ENTRIES, WINDOW } from '../src/limiter.js';

test('per-IP block after MAX_FAILURES, lifted after the window', () => {
  const l = createLimiter();
  for (let i = 0; i < MAX_FAILURES; i++) l.fail('a', 0);
  assert.ok(l.blocked('a', 1));
  assert.ok(!l.blocked('b', 1));
  assert.ok(!l.blocked('a', WINDOW + 1));
});

test('rotating IPs hit the global cap', () => {
  const l = createLimiter();
  for (let i = 0; i < MAX_GLOBAL; i++) l.fail(`ip${i}`, 0);
  assert.ok(l.blocked('fresh', 1));
  assert.ok(!l.blocked('fresh', WINDOW + 1));
});

test('map size is capped', () => {
  const l = createLimiter();
  for (let i = 0; i < MAX_ENTRIES + 50; i++) l.fail(`ip${i}`, 0);
  assert.equal(l.failures.size, MAX_ENTRIES);
});
