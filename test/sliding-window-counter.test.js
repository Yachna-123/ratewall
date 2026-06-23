'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { SlidingWindowCounter } = require('../src/sliding-window-counter');
const { MemoryStore } = require('../src/memory-store');

let store;

beforeEach(() => {
  store = new MemoryStore();
});

test('allows requests under the limit within a single window', async () => {
  const limiter = new SlidingWindowCounter({ windowMs: 1000, max: 5, store });
  const now = 10_000; // exactly at a window boundary, window 10

  for (let i = 0; i < 5; i++) {
    const result = await limiter.check('user-a', now + i);
    assert.equal(result.allowed, true, `request ${i + 1} should be allowed`);
  }

  const sixth = await limiter.check('user-a', now + 5);
  assert.equal(sixth.allowed, false, '6th request in the same window should be blocked');
});

test('different keys are tracked independently', async () => {
  const limiter = new SlidingWindowCounter({ windowMs: 1000, max: 2, store });
  const now = 5000;

  assert.equal((await limiter.check('user-a', now)).allowed, true);
  assert.equal((await limiter.check('user-a', now)).allowed, true);
  assert.equal((await limiter.check('user-a', now)).allowed, false);

  // user-b has its own independent budget
  assert.equal((await limiter.check('user-b', now)).allowed, true);
  assert.equal((await limiter.check('user-b', now)).allowed, true);
});

test('count resets once the previous window fully decays out of the sliding range', async () => {
  const limiter = new SlidingWindowCounter({ windowMs: 1000, max: 5, store });

  // fill window 10 completely (now = 10_500, mid-window)
  for (let i = 0; i < 5; i++) {
    await limiter.check('user-a', 10_500);
  }
  assert.equal((await limiter.check('user-a', 10_500)).allowed, false);

  // jump forward two full windows — window 10's count should no longer
  // weigh on window 12 at all (prevWindowId for window 12 is window 11,
  // which has 0 requests).
  const farFuture = await limiter.check('user-a', 12_500);
  assert.equal(farFuture.allowed, true, 'budget should be fully available 2 windows later');
});

test('boundary burst: requests right at a window edge are still capped near the true limit (not doubled)', async () => {
  const limiter = new SlidingWindowCounter({ windowMs: 1000, max: 10, store });

  // Fill window 10 right at its very end: now = 10_990 -> window 10,
  // elapsedFraction = 990/1000 = 0.99
  for (let i = 0; i < 10; i++) {
    const r = await limiter.check('user-a', 10_990);
    assert.equal(r.allowed, true);
  }
  assert.equal((await limiter.check('user-a', 10_990)).allowed, false);

  // Now check at the very start of the NEXT window: now = 11_010 ->
  // window 11, elapsedFraction = 10/1000 = 0.01, so prevWeight = 0.99.
  // weightedCount going in = 0 (curr) + 10 * 0.99 (prev) = 9.9, which is
  // just under max(10) -- so exactly ONE more request is allowed before
  // it's blocked again. A fixed window, by contrast, would allow a full
  // fresh batch of 10 here, doubling the effective burst to 20 in ~20ms.
  // The sliding window counter's small approximation margin (allowing
  // this one extra request) is the documented tradeoff against a true
  // sliding log, traded for O(1) storage/work per check.
  const firstInNextWindow = await limiter.check('user-a', 11_010);
  assert.equal(firstInNextWindow.allowed, true, 'just under the weighted limit, correctly allowed');

  const secondInNextWindow = await limiter.check('user-a', 11_011);
  assert.equal(secondInNextWindow.allowed, false, 'should now be blocked — burst capped near the limit, not doubled');
});

test('concurrent requests do not exceed the limit (no check-then-act race)', async () => {
  const limiter = new SlidingWindowCounter({ windowMs: 1000, max: 5, store });
  const now = 20_000;

  // Fire 10 concurrent checks against a budget of 5. If checkAndIncrement
  // were two separate awaited steps (read, then write), the event loop
  // could interleave all 10 reads before any write commits, letting all
  // 10 through. With one atomic step, exactly 5 should be allowed.
  const results = await Promise.all(
    Array.from({ length: 10 }, () => limiter.check('user-a', now))
  );

  const allowedCount = results.filter((r) => r.allowed).length;
  assert.equal(allowedCount, 5, 'exactly max(5) requests should be allowed under concurrent load');
});

test('remaining and resetMs are reported sensibly', async () => {
  const limiter = new SlidingWindowCounter({ windowMs: 1000, max: 5, store });
  const now = 30_200; // 200ms into window 30

  const result = await limiter.check('user-a', now);
  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 4);
  assert.equal(result.resetMs, 800); // 1000ms window, 200ms elapsed -> 800ms left
});
