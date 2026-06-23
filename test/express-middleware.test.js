'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ratewall, ipKeyGenerator } = require('../src/express-middleware');
const { MemoryStore } = require('../src/memory-store');

/**
 * These tests exercise the middleware function directly against minimal
 * fake req/res objects, rather than a real Express app — real `express`
 * isn't installable in this sandbox (no registry access). The fake req/res
 * below implement exactly the surface the middleware actually touches
 * (req.ip, res.setHeader, res.status().json()), so this proves the
 * middleware's own logic is correct. It does NOT prove Express itself
 * wires req.ip / trust proxy the way assumed here — that needs a real
 * Express app, ideally with supertest, run locally (see README).
 */
function makeReq(ip = '127.0.0.1') {
  return { ip };
}

function makeRes() {
  const res = {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

test('allows requests under the limit and calls next()', async () => {
  const middleware = ratewall({ windowMs: 1000, max: 3, store: new MemoryStore() });
  const req = makeReq('1.1.1.1');
  const res = makeRes();
  let nextCalled = false;

  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200, 'should not have set an error status');
});

test('blocks requests over the limit with a 429 and Retry-After header', async () => {
  const middleware = ratewall({ windowMs: 1000, max: 1, store: new MemoryStore() });
  const req = makeReq('2.2.2.2');

  // first request: allowed
  const res1 = makeRes();
  await middleware(req, res1, () => {});
  assert.equal(res1.statusCode, 200);

  // second request, same key, same window: blocked
  const res2 = makeRes();
  let nextCalled = false;
  await middleware(req, res2, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, 'next() should not be called when blocked');
  assert.equal(res2.statusCode, 429);
  assert.equal(res2.body.error, 'Too Many Requests');
  assert.ok('Retry-After' in res2.headers);
});

test('sets standard RateLimit-* headers by default', async () => {
  const middleware = ratewall({ windowMs: 1000, max: 5, store: new MemoryStore() });
  const req = makeReq('3.3.3.3');
  const res = makeRes();

  await middleware(req, res, () => {});

  assert.equal(res.headers['RateLimit-Limit'], '5');
  assert.equal(res.headers['RateLimit-Remaining'], '4');
  assert.ok('RateLimit-Reset' in res.headers);
});

test('omits standard headers when standardHeaders is false', async () => {
  const middleware = ratewall({ windowMs: 1000, max: 5, store: new MemoryStore(), standardHeaders: false });
  const req = makeReq('4.4.4.4');
  const res = makeRes();

  await middleware(req, res, () => {});

  assert.equal('RateLimit-Limit' in res.headers, false);
});

test('different IPs are rate-limited independently via the default key generator', async () => {
  const middleware = ratewall({ windowMs: 1000, max: 1, store: new MemoryStore() });

  const resA1 = makeRes();
  await middleware(makeReq('5.5.5.5'), resA1, () => {});
  assert.equal(resA1.statusCode, 200);

  const resB1 = makeRes();
  await middleware(makeReq('6.6.6.6'), resB1, () => {});
  assert.equal(resB1.statusCode, 200, 'a different IP should have its own independent budget');
});

test('custom keyGenerator overrides the default per-IP behavior', async () => {
  const middleware = ratewall({
    windowMs: 1000,
    max: 1,
    store: new MemoryStore(),
    keyGenerator: (req) => req.userId,
  });

  // Same userId, different IPs -- should still share one budget, proving
  // the custom keyGenerator is actually being used instead of req.ip.
  const req1 = { ip: '7.7.7.7', userId: 'user-42' };
  const req2 = { ip: '8.8.8.8', userId: 'user-42' };

  const res1 = makeRes();
  await middleware(req1, res1, () => {});
  assert.equal(res1.statusCode, 200);

  const res2 = makeRes();
  let nextCalled = false;
  await middleware(req2, res2, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false, 'should be blocked: same userId key, even though IP differs');
  assert.equal(res2.statusCode, 429);
});

test('custom handler is invoked instead of the default 429 response when blocked', async () => {
  let handlerCalled = false;
  const middleware = ratewall({
    windowMs: 1000,
    max: 1,
    store: new MemoryStore(),
    handler: (req, res) => {
      handlerCalled = true;
      res.status(503).json({ custom: true });
    },
  });
  const req = makeReq('9.9.9.9');

  await middleware(req, makeRes(), () => {});
  const res2 = makeRes();
  await middleware(req, res2, () => {});

  assert.equal(handlerCalled, true);
  assert.equal(res2.statusCode, 503);
  assert.equal(res2.body.custom, true);
});

test('a throwing store error calls next(err) instead of silently blocking (fail open)', async () => {
  const brokenStore = {
    async checkAndIncrement() {
      throw new Error('redis connection lost');
    },
  };
  const middleware = ratewall({ windowMs: 1000, max: 5, store: brokenStore });
  const req = makeReq('10.10.10.10');
  const res = makeRes();
  let caughtErr = null;

  await middleware(req, res, (err) => {
    caughtErr = err;
  });

  assert.ok(caughtErr instanceof Error);
  assert.equal(caughtErr.message, 'redis connection lost');
  assert.equal(res.statusCode, 200, 'should not have been treated as a 429 — fail open, not closed');
});

test('ipKeyGenerator reads req.ip', () => {
  assert.equal(ipKeyGenerator({ ip: '11.11.11.11' }), '11.11.11.11');
});
