# Ratewall

A Redis-backed sliding window rate limiter for Node.js, with an Express middleware adapter.

## Why not a fixed window?

A fixed window counter resets to zero at a hard boundary (e.g. every 60s). That creates a burst loophole: a client can send `max` requests in the last millisecond of one window, then another `max` in the first millisecond of the next — a burst of up to **2x `max`** in a few milliseconds of real time, even though the limiter is "working correctly."

## Why not a true sliding window log?

A sliding log stores a timestamp per request and is exact, but costs O(n) storage and O(n) work per check, where `n` is the number of requests in the window. That's expensive at real scale (think: a busy API key making thousands of requests per window).

## What this implements: the sliding window counter

A middle ground. It keeps two adjacent fixed windows — the current one and the previous one — and weights the previous window's count by how much it still overlaps the sliding window ending "now":

```
weightedCount = currentWindowCount + previousWindowCount * (1 - elapsedFractionOfCurrentWindow)
```

This is **O(1) storage and O(1) work per check**, and it caps bursts much closer to the true limit than a fixed window — at the cost of a small, documented approximation margin right at window boundaries (see `test/sliding-window-counter.test.js`, the `boundary burst` test, for the exact behavior and the math).

## The real bug this project surfaced: a check-then-act race condition

The naive implementation of "check the count, then increment it" as two separate steps has a race condition under concurrent load:

```js
// BROKEN — DO NOT DO THIS
const count = await store.get(key);       // step 1: read
if (count < max) {
  await store.set(key, count + 1);        // step 2: write
}
```

If 10 requests arrive concurrently, all 10 can execute step 1 (and all read the *same* pre-increment count) before any of them executes step 2. With `max = 5`, all 10 requests can be allowed through — not 5.

**The fix:** collapse read-and-increment into a single atomic operation.

- In the in-memory store (`src/memory-store.js`), this means doing both steps synchronously in one tick, with no `await` between them — nothing else can interleave in the middle of a single synchronous block.
- In the Redis store (`src/redis-store.js` + `src/check_and_increment.lua`), this means running the whole check-and-increment as **one Lua script**, which Redis guarantees executes to completion without any other client's commands interleaving. This is the only way to get the same atomicity guarantee across *multiple app instances* sharing one Redis — the in-memory fix only protects a single process.

This was caught by `test/sliding-window-counter.test.js`'s concurrency test, firing 10 simultaneous requests at a `max: 5` limiter and asserting exactly 5 are allowed.

## Usage

```js
const express = require('express');
const Redis = require('ioredis');
const { ratewall, RedisStore } = require('ratewall');

const redis = new Redis(process.env.REDIS_URL);

const app = express();
app.use(
  ratewall({
    windowMs: 60_000,
    max: 100,
    store: new RedisStore({ redis }),
    keyGenerator: (req) => req.user?.id ?? req.ip, // default is per-IP
  })
);
```

For single-process use (development, or low-traffic apps that don't need multi-instance correctness), omit `store` and it defaults to an in-memory store:

```js
app.use(ratewall({ windowMs: 60_000, max: 100 }));
```

## Failure mode: fail open, not closed

If the store throws (e.g. a Redis connection drop), the middleware calls `next(err)` and lets the request through, rather than blocking it. Treating an infrastructure outage as "rate limit exceeded" would turn a Redis blip into an outage for every user simultaneously — that's a worse failure mode than temporarily not rate-limiting at all.

## What's verified, and how

This project was built across environments with different capabilities, and I want to be precise about which claims are backed by what evidence rather than blur the line:

| Claim | Verified by |
|---|---|
| Sliding window algorithm math is correct (boundary timing, decay, isolation per key) | `test/sliding-window-counter.test.js` — all passing |
| The check-then-act race condition is real, and the atomic fix resolves it | `test/sliding-window-counter.test.js`'s concurrency test, **and** an in-process micro-benchmark (5000 concurrent checks against `max=50`, result: exactly 50 allowed, 4950 blocked) |
| Express middleware logic is correct (headers, custom key generators, fail-open behavior) | `test/express-middleware.test.js` — fake req/res, all passing |
| Express middleware works inside a **real** Express app/HTTP cycle | `test/express-integration.test.js` — requires `npm install` + real `express`/`supertest`, run locally |
| RedisStore's argument wiring and return-value parsing is correct | `test/redis-store.test.js` — fake Redis client, all passing |
| The Lua script actually runs correctly against **real** Redis, with the atomicity guarantee holding over a real network round trip | Not yet verified in this repo's CI — run `node benchmarks/server.js` with `RATEWALL_STORE=redis` against a real Redis instance, then `npm run bench`, locally |
| Real HTTP-level throughput and latency under load | `npm run bench` against `benchmarks/server.js`, run locally with `autocannon` |

The honest summary: the **algorithm and the fix for the race condition are proven**, including under real concurrency. The **real-Redis and real-HTTP load numbers require running this locally**, since that environment had no network access to install Redis or run a live load test. Treat the in-process numbers above as evidence the logic is sound, and the benchmark scripts in `benchmarks/` as the next step to get production-realistic numbers.

## Running the benchmark locally

```bash
npm install

# Terminal 1
node benchmarks/server.js
# or, against real Redis:
# RATEWALL_STORE=redis REDIS_URL=redis://localhost:6379 node benchmarks/server.js

# Terminal 2
npm run bench
```

This fires concurrent requests at a single shared rate-limit key (deliberately — that's what actually stresses the atomicity guarantee) and reports both throughput and a correctness check: how many requests were allowed vs. the expected ceiling.

## Tests

```bash
npm install
npm test              # full suite, requires express/supertest/ioredis installed
npm run test:unit     # dependency-light subset (no real express/redis needed)
```

## What's deliberately out of scope (v1)

- Token bucket / fixed window implementations — discussed above as the rejected alternatives, not built, to keep this focused and rigorous rather than spread thin across three algorithms.
- A Fastify adapter — the core (`SlidingWindowCounter`) has no Express dependency, so one is straightforward to add later, but wasn't necessary to prove the core claim.
- A dashboard/UI — the benchmark script's terminal output covers the same evidence a dashboard would, for a fraction of the build time.
