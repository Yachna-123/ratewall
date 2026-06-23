'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, 'check_and_increment.lua');

/**
 * RedisStore implements the same checkAndIncrement(...) contract as
 * MemoryStore, but backed by a real Redis instance via a Lua script
 * (see check_and_increment.lua). This is what makes rate limiting
 * correct across MULTIPLE app instances/processes sharing one Redis —
 * the in-memory store only protects a single process.
 *
 * `ioredis` is a peer dependency, not bundled — pass in your own client
 * instance so you control connection options, TLS, cluster mode, etc.
 *
 * Usage:
 *   const Redis = require('ioredis');
 *   const { RedisStore } = require('ratewall');
 *   const redis = new Redis(process.env.REDIS_URL);
 *   const store = new RedisStore({ redis });
 */
class RedisStore {
  /**
   * @param {object} opts
   * @param {object} opts.redis - an ioredis client instance
   * @param {string} [opts.prefix] - key namespace prefix, default "rw"
   */
  constructor({ redis, prefix = 'rw' }) {
    if (!redis || typeof redis.defineCommand !== 'function') {
      throw new Error('RedisStore requires an ioredis client instance (with defineCommand support)');
    }
    this.redis = redis;
    this.prefix = prefix;
    this._scriptLoaded = false;
    this._loadScript();
  }

  _loadScript() {
    if (this._scriptLoaded) return;
    const luaSource = fs.readFileSync(SCRIPT_PATH, 'utf8');
    // defineCommand registers the script once and lets ioredis call it
    // by name afterwards; ioredis handles EVALSHA caching + fallback to
    // EVAL on a NOSCRIPT error internally, so we don't have to.
    this.redis.defineCommand('rwCheckAndIncrement', {
      numberOfKeys: 2,
      lua: luaSource,
    });
    this._scriptLoaded = true;
  }

  _key(key, windowId) {
    return `${this.prefix}:${key}:${windowId}`;
  }

  /**
   * @param {object} args
   * @param {string} args.key
   * @param {number} args.currWindowId
   * @param {number} args.prevWindowId
   * @param {number} args.prevWeight
   * @param {number} args.max
   * @param {number} [args.windowMs] - needed for TTL; falls back to a
   *        generous default if not supplied by the caller.
   * @returns {Promise<{ allowed: boolean, weightedCount: number }>}
   */
  async checkAndIncrement({ key, currWindowId, prevWindowId, prevWeight, max, windowMs = 60_000 }) {
    const currKey = this._key(key, currWindowId);
    const prevKey = this._key(key, prevWindowId);

    const [allowedFlag, scaledWeightedCount] = await this.redis.rwCheckAndIncrement(
      currKey,
      prevKey,
      prevWeight,
      max,
      windowMs
    );

    return {
      allowed: allowedFlag === 1,
      weightedCount: scaledWeightedCount / 1000,
    };
  }
}

module.exports = { RedisStore };
