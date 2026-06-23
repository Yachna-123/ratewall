'use strict';

/**
 * Drives autocannon against benchmarks/server.js and reports:
 *   1. Standard load numbers: throughput (req/sec), latency percentiles
 *   2. A CORRECTNESS check: out of all requests fired, how many got a
 *      200 (allowed) vs 429 (blocked)? Since the server is configured
 *      with a single shared key and max=50, the number of 200s should
 *      be close to 50 * (number of 1-second windows the test spans) —
 *      NOT close to the total number of requests fired. If far more
 *      200s come through than that, it's evidence of a race condition
 *      letting requests leak past the limit under concurrency.
 *
 * Usage:
 *   1. In one terminal: node benchmarks/server.js
 *      (optionally: RATEWALL_STORE=redis node benchmarks/server.js)
 *   2. In another terminal: node benchmarks/run.js
 */
const autocannon = require('autocannon');

const URL = process.env.BENCH_URL || 'http://localhost:3001/';
const DURATION_S = Number(process.env.BENCH_DURATION || 10);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS || 100);

async function main() {
  console.log(`[bench] hitting ${URL} with ${CONNECTIONS} concurrent connections for ${DURATION_S}s...`);

  const result = await autocannon({
    url: URL,
    connections: CONNECTIONS,
    duration: DURATION_S,
  });

  const total = result.requests.total;
  const non2xx = result.non2xx; // autocannon tracks non-2xx responses (our 429s land here)
  const allowed = total - non2xx;
  const windowsSpanned = Math.ceil(DURATION_S * 1000 / 1000); // windowMs=1000 in server.js
  const expectedMaxAllowed = 50 * windowsSpanned; // MAX=50 in server.js, +/- 1 window of slack

  console.log('\n--- Throughput ---');
  console.log(`Total requests fired:      ${total}`);
  console.log(`Requests/sec (avg):        ${result.requests.average}`);
  console.log(`Latency p50/p99 (ms):      ${result.latency.p50} / ${result.latency.p99}`);

  console.log('\n--- Correctness (the actual point of this benchmark) ---');
  console.log(`Allowed (2xx):             ${allowed}`);
  console.log(`Blocked (429/non-2xx):     ${non2xx}`);
  console.log(`Expected allowed (~):      <= ${expectedMaxAllowed} (50/window * ${windowsSpanned} windows, +/- 1 window slack)`);

  if (allowed > expectedMaxAllowed + 50) {
    console.log(`\n⚠️  Allowed count is well above the expected ceiling — investigate for a race condition leak.`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ Allowed count stayed within the expected ceiling under concurrent load.`);
  }
}

main().catch((err) => {
  console.error('[bench] failed:', err.message);
  console.error('Is the benchmark server running? Start it with: node benchmarks/server.js');
  process.exitCode = 1;
});
