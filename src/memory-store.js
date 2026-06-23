'use strict';

/**
 * MemoryStore is a single-process, in-memory implementation of the store
 * interface used by SlidingWindowCounter. It exists so the algorithm can
 * be unit-tested fast, without Redis, and so the atomicity contract can
 * be verified in isolation before introducing network/IO concerns.
 *
 * IMPORTANT: checkAndIncrement is intentionally written as ONE synchronous
 * block of work (wrapped in a resolved Promise) rather than two separate
 * awaited steps. That is the actual fix for the race condition: if "read
 * the count" and "increment the count" are two separate `await` points,
 * the Node.js event loop can interleave other callers' code between them,
 * letting more than `max` requests through under concurrent load. Doing
 * both in one synchronous tick removes that interleaving opportunity here,
 * the same way a Lua script removes it in Redis (Lua scripts run to
 * completion without other Redis commands interleaving).
 */
class MemoryStore {
  constructor() {
    /** @type {Map<string, number>} windowKey -> count */
    this.counts = new Map();
  }

  _windowKey(key, windowId) {
    return `${key}:${windowId}`;
  }

  /**
   * @param {object} args
   * @param {string} args.key
   * @param {number} args.currWindowId
   * @param {number} args.prevWindowId
   * @param {number} args.prevWeight
   * @param {number} args.max
   * @returns {Promise<{ allowed: boolean, weightedCount: number }>}
   */
  async checkAndIncrement({ key, currWindowId, prevWindowId, prevWeight, max }) {
    // Everything below is synchronous JS with no `await` in the middle —
    // that's what makes this one atomic step from the event loop's
    // perspective. No other checkAndIncrement call can interleave here.
    const currCount = this.counts.get(this._windowKey(key, currWindowId)) || 0;
    const prevCount = this.counts.get(this._windowKey(key, prevWindowId)) || 0;

    const weightedCount = currCount + prevCount * prevWeight;

    if (weightedCount >= max) {
      return { allowed: false, weightedCount };
    }

    const newCurrCount = currCount + 1;
    this.counts.set(this._windowKey(key, currWindowId), newCurrCount);

    // opportunistically clean up windows that can no longer be referenced
    // (anything older than the previous window is dead weight)
    this.counts.delete(this._windowKey(key, prevWindowId - 1));

    return { allowed: true, weightedCount: currCount + 1 + prevCount * prevWeight };
  }

  /** Test helper: wipe all state between test cases */
  reset() {
    this.counts.clear();
  }
}

module.exports = { MemoryStore };
