'use strict';

/**
 * SlidingWindowCounter implements the "sliding window counter" rate-limiting
 * algorithm. It approximates a true sliding log by keeping two adjacent
 * fixed windows (the current one and the previous one) and weighting the
 * previous window's count by how much of it still overlaps the sliding
 * window of size `windowMs` ending "now".
 *
 * Why not a fixed window?
 *   A fixed window resets its counter at a hard boundary (e.g. every
 *   60s). A client can send `max` requests in the last millisecond of one
 *   window and another `max` in the first millisecond of the next,
 *   producing a burst of up to 2x `max` in a tiny span of real time. The
 *   sliding window counter removes most of that burst risk by carrying
 *   forward a weighted fraction of the previous window's count.
 *
 * Why not a true sliding window log?
 *   A sliding log (storing a timestamp per request) is exact, but costs
 *   O(n) storage per key and O(n) work per check, where n is the number
 *   of requests in the window. That's expensive at scale. The counter
 *   approach is O(1) storage and O(1) work per check, at the cost of a
 *   small approximation error right at window boundaries (see tests).
 *
 * Concurrency note:
 *   The store's `checkAndIncrement` must be a SINGLE atomic operation
 *   (read current+previous window counts AND increment in one step).
 *   If "check" and "increment" are two separate awaited steps, concurrent
 *   callers can race: multiple requests can all read count=0 before any
 *   of them commits an increment, letting more than `max` requests through.
 *   This is exactly why the Redis implementation uses a Lua script — Redis
 *   runs Lua scripts atomically, with no other command interleaving.
 */
class SlidingWindowCounter {
  /**
   * @param {object} opts
   * @param {number} opts.windowMs - size of the sliding window, in ms
   * @param {number} opts.max - max requests allowed per window
   * @param {object} opts.store - object exposing async checkAndIncrement(key, currWindowId, prevWindowId, weight, max) -> { allowed, count }
   */
  constructor({ windowMs, max, store }) {
    if (!windowMs || windowMs <= 0) {
      throw new Error('windowMs must be a positive number');
    }
    if (!max || max <= 0) {
      throw new Error('max must be a positive number');
    }
    if (!store || typeof store.checkAndIncrement !== 'function') {
      throw new Error('store must implement an async checkAndIncrement(...) method');
    }
    this.windowMs = windowMs;
    this.max = max;
    this.store = store;
  }

  /**
   * @param {string} key - identifier for the caller (IP, user id, API key, etc.)
   * @param {number} [now] - current timestamp in ms, injectable for tests
   * @returns {Promise<{ allowed: boolean, count: number, remaining: number, resetMs: number }>}
   */
  async check(key, now = Date.now()) {
    const currWindowId = Math.floor(now / this.windowMs);
    const prevWindowId = currWindowId - 1;
    const elapsedInCurrent = now - currWindowId * this.windowMs;
    const elapsedFraction = elapsedInCurrent / this.windowMs;
    // weight given to the PREVIOUS window's count, shrinking linearly
    // toward 0 as we move further into the current window.
    const prevWeight = 1 - elapsedFraction;

    const result = await this.store.checkAndIncrement({
      key,
      currWindowId,
      prevWindowId,
      prevWeight,
      max: this.max,
      windowMs: this.windowMs,
    });

    const resetMs = (currWindowId + 1) * this.windowMs - now;

    return {
      allowed: result.allowed,
      count: result.weightedCount,
      remaining: Math.max(0, this.max - result.weightedCount),
      resetMs,
    };
  }
}

module.exports = { SlidingWindowCounter };
