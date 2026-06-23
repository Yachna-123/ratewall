'use strict';

/**
 * REAL Express + supertest integration tests.
 *
 * These are not run as part of this sandbox's test suite (express/supertest
 * couldn't be installed here — no registry access). Run these on your own
 * machine after `npm install`, to prove the middleware behaves correctly
 * inside an actual Express app and HTTP request/response cycle, not just
 * against the hand-rolled fake req/res used in express-middleware.test.js.
 *
 *   npm install
 *   node --test test/express-integration.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { ratewall } = require('../src/express-middleware');
const { MemoryStore } = require('../src/memory-store');

function buildApp({ windowMs, max, store }) {
  const app = express();
  app.use(ratewall({ windowMs, max, store }));
  app.get('/', (req, res) => res.status(200).json({ ok: true }));
  return app;
}

test('a real Express app allows requests under the limit', async () => {
  const app = buildApp({ windowMs: 1000, max: 3, store: new MemoryStore() });

  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.headers['ratelimit-limit'], '3');
});

test('a real Express app returns 429 once the limit is exceeded', async () => {
  const app = buildApp({ windowMs: 1000, max: 2, store: new MemoryStore() });

  await request(app).get('/').expect(200);
  await request(app).get('/').expect(200);
  const blocked = await request(app).get('/');

  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'Too Many Requests');
  assert.ok(blocked.headers['retry-after']);
});

test('concurrent real HTTP requests do not exceed the limit', async () => {
  const app = buildApp({ windowMs: 1000, max: 5, store: new MemoryStore() });

  const requests = Array.from({ length: 15 }, () => request(app).get('/'));
  const results = await Promise.all(requests);

  const allowedCount = results.filter((r) => r.status === 200).length;
  assert.equal(allowedCount, 5, 'exactly max(5) real HTTP requests should succeed under concurrent load');
});
