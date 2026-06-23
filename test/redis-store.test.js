'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RedisStore } = require('../src/redis-store');

/**
 * FakeRedisClient mimics just enough of ioredis's shape (defineCommand +
 * the resulting method call) to exercise RedisStore's logic without a
 * real Redis server. It re-implements the Lua script's exact semantics
 * in JS, so this test verifies RedisStore wires arguments correctly and
 * interprets the script's return shape correctly — it does NOT verify
 * that Redis itself runs the script atomically over the network. That
 * claim can only be verified against a real Redis instance (see
 * README's "Testing against real Redis" section) since it depends on
 * Redis's actual single-threaded command execution guarantee, which a
 * fake client can't reproduce.
 */
class FakeRedisClient {
  constructor() {
    this.store = new Map();
  }

  defineCommand(name, { lua }) {
    if (name !== 'rwCheckAndIncrement') {
      throw new Error(`unexpected command name: ${name}`);
    }
    // confirm the real Lua source was actually read and passed in,
    // rather than silently no-op'ing
    if (!lua || !lua.includes('redis.call')) {
      throw new Error('lua script source was not loaded correctly');
    }
    this.rwCheckAndIncrement = async (currKey, prevKey, prevWeight, max, windowMs) => {
      const currCount = this.store.get(currKey) || 0;
      const prevCount = this.store.get(prevKey) || 0;
      const weightedCount = currCount + prevCount * prevWeight;

      if (weightedCount >= max) {
        return [0, Math.floor(weightedCount * 1000)];
      }

      const newCurrCount = currCount + 1;
      this.store.set(currKey, newCurrCount);
      const finalWeightedCount = newCurrCount + prevCount * prevWeight;
      return [1, Math.floor(finalWeightedCount * 1000)];
    };
  }
}

test('RedisStore throws clearly if not given an ioredis-shaped client', () => {
  assert.throws(() => new RedisStore({ redis: {} }), /ioredis client instance/);
});

test('RedisStore registers the Lua script via defineCommand on construction', () => {
  const fakeClient = new FakeRedisClient();
  new RedisStore({ redis: fakeClient });
  assert.equal(typeof fakeClient.rwCheckAndIncrement, 'function', 'script should be registered as a callable command');
});

test('RedisStore allows requests under the limit and blocks over it', async () => {
  const fakeClient = new FakeRedisClient();
  const store = new RedisStore({ redis: fakeClient });

  for (let i = 0; i < 5; i++) {
    const result = await store.checkAndIncrement({
      key: 'user-a',
      currWindowId: 10,
      prevWindowId: 9,
      prevWeight: 0,
      max: 5,
      windowMs: 1000,
    });
    assert.equal(result.allowed, true, `request ${i + 1} should be allowed`);
  }

  const sixth = await store.checkAndIncrement({
    key: 'user-a',
    currWindowId: 10,
    prevWindowId: 9,
    prevWeight: 0,
    max: 5,
    windowMs: 1000,
  });
  assert.equal(sixth.allowed, false);
});

test('RedisStore namespaces keys with the configured prefix', async () => {
  const fakeClient = new FakeRedisClient();
  const store = new RedisStore({ redis: fakeClient, prefix: 'custom' });

  await store.checkAndIncrement({
    key: 'user-a',
    currWindowId: 1,
    prevWindowId: 0,
    prevWeight: 0,
    max: 5,
    windowMs: 1000,
  });

  assert.ok(fakeClient.store.has('custom:user-a:1'), 'key should be namespaced with custom prefix');
});
