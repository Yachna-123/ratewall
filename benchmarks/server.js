'use strict';

/**
 * A minimal Express app with ratewall applied, for load testing.
 *
 * Run this, then point autocannon at it (see benchmarks/run.js, or run
 * autocannon directly from the CLI):
 *
 *   node benchmarks/server.js
 *   npx autocannon -c 100 -d 10 http://localhost:3001/
 *
 * Two modes, controlled by RATEWALL_STORE env var:
 *   RATEWALL_STORE=memory  (default) - single-process MemoryStore
 *   RATEWALL_STORE=redis             - RedisStore, requires REDIS_URL env
 *                                       var or localhost:6379 default.
 *
 * The memory-store run tells you the middleware's own overhead.
 * The redis-store run tells you the realistic, network-round-trip cost —
 * and is the one that actually proves atomicity holds over real Redis
 * under concurrent load, not just within one Node process.
 */
const express = require('express');
const { ratewall } = require('../src/express-middleware');
const { MemoryStore } = require('../src/memory-store');

const PORT = process.env.PORT || 3001;
const WINDOW_MS = 1000;
const MAX = 50; // generous enough to see real throughput, tight enough to see blocking

function buildStore() {
  if (process.env.RATEWALL_STORE === 'redis') {
    // require lazily so a memory-only run never needs ioredis installed
    const Redis = require('ioredis');
    const { RedisStore } = require('../src/redis-store');
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    console.log('[benchmark] using RedisStore against', process.env.REDIS_URL || 'redis://localhost:6379');
    return new RedisStore({ redis });
  }
  console.log('[benchmark] using MemoryStore (single-process, no network round trip)');
  return new MemoryStore();
}

const app = express();

// Use a single fixed key for everyone hitting this benchmark server, so
// autocannon's concurrent connections all compete for the SAME rate-limit
// budget — that's what actually stresses the atomicity guarantee. If each
// connection got its own key (e.g. by source port), they'd never contend
// with each other and the race condition this whole project is about
// would never get exercised.
app.use(
  ratewall({
    windowMs: WINDOW_MS,
    max: MAX,
    store: buildStore(),
    keyGenerator: () => 'benchmark-shared-key',
  })
);

app.get('/', (req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[benchmark] server listening on http://localhost:${PORT}`);
  console.log(`[benchmark] window=${WINDOW_MS}ms max=${MAX} (shared key across all callers)`);
});
